import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandMock,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

async function openWorkspaceManager(page: import('@playwright/test').Page): Promise<void> {
  await openViaCommandPalette(page, 'workspaces');
  await page.locator('gn-workspace-manager-dialog[open]').waitFor({ state: 'visible', timeout: 3000 });
}

/**
 * Dispatch open-repo-file event from the workspace manager dialog.
 * The dialog is inside the shadow DOM of gn-app-shell, so we need to
 * traverse shadow roots to find it.
 */
async function dispatchOpenRepoFileEvent(
  page: import('@playwright/test').Page,
  detail: { repoPath: string; filePath: string; lineNumber: number },
): Promise<void> {
  await page.evaluate((detail) => {
    // Traverse shadow DOM to find the workspace-manager-dialog
    const appShell = document.querySelector('gn-app-shell');
    const dialog = appShell?.shadowRoot?.querySelector('gn-workspace-manager-dialog');
    if (dialog) {
      dialog.dispatchEvent(new CustomEvent('open-repo-file', {
        detail,
        bubbles: true,
        composed: true,
      }));
    }
  }, detail);
}

test.describe('Workspace Manager - open-repo-file handler', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_workspaces: [],
      search_workspace: { results: [], failures: [] },
    });
  });

  test('should open workspace manager from command palette', async ({ page }) => {
    await openWorkspaceManager(page);
    await expect(page.locator('gn-workspace-manager-dialog[open]')).toBeVisible();
  });

  test('open-repo-file event should close workspace manager and show blame view', async ({ page }) => {
    await openWorkspaceManager(page);

    // Dispatch open-repo-file event from workspace manager (via shadow DOM)
    await dispatchOpenRepoFileEvent(page, { repoPath: '/tmp/test-repo', filePath: 'src/main.ts', lineNumber: 10 });

    // Workspace manager should close
    await expect(page.locator('gn-workspace-manager-dialog[open]')).not.toBeVisible();
  });

  test('open-repo-file for different repo should call open_repository', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_workspaces: [],
      open_repository: {
        path: '/tmp/other-repo',
        name: 'other-repo',
        isValid: true,
        isBare: false,
        headRef: 'main',
        state: 'clean',
      },
      get_commits: [],
      get_branches: [],
      get_status: [],
      get_stashes: [],
      get_tags: [],
      get_remotes: [],
      get_head_info: { name: 'main', oid: 'abc123', isDetached: false },
    });

    await openWorkspaceManager(page);

    // Dispatch open-repo-file with a different repo path (via shadow DOM)
    await dispatchOpenRepoFileEvent(page, { repoPath: '/tmp/other-repo', filePath: 'README.md', lineNumber: 1 });

    // Should have called open_repository with the other repo path
    await expect
      .poll(async () => {
        const cmds = await findCommand(page, 'open_repository');
        return cmds.filter(c => (c.args as { path?: string })?.path === '/tmp/other-repo').length;
      })
      .toBeGreaterThan(0);
  });

  test('open-repo-file error should show toast notification', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_workspaces: [],
      open_repository: { __error__: 'Repository not found' },
    });

    await openWorkspaceManager(page);

    // Dispatch open-repo-file with a non-existent repo (via shadow DOM)
    await dispatchOpenRepoFileEvent(page, { repoPath: '/tmp/nonexistent', filePath: 'file.ts', lineNumber: 1 });

    // Should show an error toast
    await expect(page.locator('gn-toast-container .toast.error, gn-toast-container .toast-error')).toBeVisible({ timeout: 5000 });
  });
});


test.describe('Workspace Manager - repo status chips', () => {
  test('renders the tracked branch with its ahead/behind counts and labels a detached repo', async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_workspaces: [
        {
          id: 'ws-1',
          name: 'Alpha Workspace',
          description: '',
          color: '#4fc3f7',
          repositories: [
            { path: '/repos/alpha', name: 'alpha' },
            { path: '/repos/beta', name: 'beta' },
          ],
          createdAt: '2024-01-01T00:00:00Z',
          lastOpened: null,
        },
      ],
      search_workspace: { results: [], failures: [] },
      validate_workspace_repositories: [
        {
          path: '/repos/alpha',
          name: 'alpha',
          exists: true,
          isValidRepo: true,
          changedFilesCount: 0,
          currentBranch: 'main',
          isDetached: false,
          ahead: 2,
          behind: 1,
        },
        {
          path: '/repos/beta',
          name: 'beta',
          exists: true,
          isValidRepo: true,
          changedFilesCount: 0,
          currentBranch: null,
          isDetached: true,
          ahead: 0,
          behind: 0,
        },
      ],
    });

    // The dialog auto-selects the first workspace on open.
    await openWorkspaceManager(page);

    const dialog = page.locator('gn-workspace-manager-dialog');

    // The tracked branch keeps its name and its counts...
    await expect(dialog.locator('.repo-branch').first()).toHaveText('main');
    await expect(dialog.locator('.repo-ahead-behind').first()).toHaveText('↑2 ↓1');

    // ...and the detached repo says so instead of showing a branch named HEAD,
    // with no ahead/behind, which is what git reports for it.
    await expect(dialog.locator('.repo-branch.detached')).toHaveText('detached HEAD');
    await expect(dialog.locator('.repo-ahead-behind')).toHaveCount(1);
  });
});

test.describe('Workspace Manager - partial search failures', () => {
  test('shows matches from the repos that worked alongside the ones that could not be searched', async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_workspaces: [
        {
          id: 'ws-1',
          name: 'Alpha Workspace',
          description: '',
          color: '#4fc3f7',
          repositories: [
            { path: '/repos/alpha', name: 'alpha' },
            { path: '/repos/beta', name: 'beta' },
          ],
          createdAt: '2024-01-01T00:00:00Z',
          lastOpened: null,
        },
      ],
      validate_workspace_repositories: [],
      search_workspace: {
        results: [
          {
            repoName: 'alpha',
            repoPath: '/repos/alpha',
            filePath: 'src/main.ts',
            lineNumber: 42,
            lineContent: 'const needle = true',
            matchStart: 6,
            matchEnd: 12,
          },
        ],
        failures: ['Failed to search repository "beta": repository path does not exist'],
      },
    });

    await openWorkspaceManager(page);

    const dialog = page.locator('gn-workspace-manager-dialog');
    await dialog.locator('.search-input').fill('needle');
    await dialog.locator('.search-btn').click();

    // The matches that were found are still shown...
    await expect(dialog.locator('.search-result-item')).toHaveCount(1);
    // ...and the repository that could not be searched is named, not silently dropped.
    await expect(dialog.locator('.search-failures')).toContainText('beta');
  });

  test('reports an empty search only once it has completed', async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_workspaces: [
        {
          id: 'ws-1',
          name: 'Alpha Workspace',
          description: '',
          color: '#4fc3f7',
          repositories: [{ path: '/repos/alpha', name: 'alpha' }],
          createdAt: '2024-01-01T00:00:00Z',
          lastOpened: null,
        },
      ],
      validate_workspace_repositories: [],
      search_workspace: { results: [], failures: [] },
    });

    await openWorkspaceManager(page);

    const dialog = page.locator('gn-workspace-manager-dialog');
    await dialog.locator('.search-input').fill('needle');
    // Typing is not a search: the verdict only arrives once the search has run.
    await expect(dialog.locator('.search-no-results')).toHaveCount(0);

    await dialog.locator('.search-btn').click();
    await expect(dialog.locator('.search-no-results')).toContainText('No results found');
    await expect(dialog.locator('.search-failures')).toHaveCount(0);
  });

  test('clears a stale failure banner when the dialog is reopened', async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_workspaces: [
        {
          id: 'ws-1',
          name: 'Alpha Workspace',
          description: '',
          color: '#4fc3f7',
          repositories: [{ path: '/repos/alpha', name: 'alpha' }],
          createdAt: '2024-01-01T00:00:00Z',
          lastOpened: null,
        },
      ],
      validate_workspace_repositories: [],
      search_workspace: {
        results: [],
        failures: ['Failed to search repository "alpha": repository path does not exist'],
      },
    });

    await openWorkspaceManager(page);

    const dialog = page.locator('gn-workspace-manager-dialog');
    await dialog.locator('.search-input').fill('needle');
    await dialog.locator('.search-btn').click();
    await expect(dialog.locator('.search-failures')).toContainText('alpha');

    await page.keyboard.press('Escape');
    await expect(page.locator('gn-workspace-manager-dialog[open]')).not.toBeVisible();

    await openWorkspaceManager(page);
    await expect(dialog.locator('.search-failures')).toHaveCount(0);
    await expect(dialog.locator('.search-input')).toHaveValue('');
  });
});
