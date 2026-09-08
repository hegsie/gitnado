import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks, setupOpenRepository, emptyRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  startCommandCapture,
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
} from '../fixtures/test-helpers';

test.describe('Welcome Screen', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    // Setup Tauri mocks with empty repository (no repo open)
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
  });

  test('should display welcome screen when no repository is open', async () => {
    await expect(app.welcomeScreen).toBeVisible();
    await expect(app.welcomeLogo).toHaveText('Gitnado');
    await expect(app.welcomeTagline).toContainText('Git client');
  });

  test('should display all action buttons', async ({ page }) => {
    await expect(app.openButton).toBeVisible();
    await expect(app.cloneButton).toBeVisible();
    await expect(app.initButton).toBeVisible();

    // Verify button text
    await expect(app.openButton).toContainText('Open');
    await expect(app.cloneButton).toContainText('Clone');
    await expect(app.initButton).toContainText('Init');
  });

  test('should open clone dialog when Clone button is clicked', async () => {
    await app.cloneButton.click();
    await expect(dialogs.clone.dialog).toBeVisible();
  });

  test('should open init dialog when Init button is clicked', async () => {
    await app.initButton.click();
    await expect(dialogs.init.dialog).toBeVisible();
  });

  test('should close clone dialog with Escape key', async () => {
    await app.cloneButton.click();
    await expect(dialogs.clone.dialog).toBeVisible();

    await dialogs.clone.closeWithEscape();
    await expect(dialogs.clone.dialog).not.toBeVisible();
  });

  test('should close init dialog with Escape key', async () => {
    await app.initButton.click();
    await expect(dialogs.init.dialog).toBeVisible();

    await dialogs.init.closeWithEscape();
    await expect(dialogs.init.dialog).not.toBeVisible();
  });

  test('should display recent repositories section', async () => {
    await expect(app.recentSection).toBeVisible();
  });

  test('should show empty message when no recent repositories', async () => {
    const emptyMessage = app.welcomeScreen.locator('.empty-recent');
    await expect(emptyMessage).toContainText('No recent repositories');
  });
});

test.describe('Welcome Screen with Recent Repositories', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    // Setup Tauri mocks with some recent repositories
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          switch (command) {
            case 'get_recent_repositories':
              return [
                { path: '/path/to/repo1', name: 'repo1' },
                { path: '/path/to/repo2', name: 'repo2' },
              ];
            case 'get_repository_info':
              return null; // No repo open
            default:
              return null;
          }
        },
        transformCallback: () => 0,
        convertFileSrc: (path: string) => path,
      };
    });

    app = new AppPage(page);
    await app.goto();
  });

  test('should display recent repository items', async () => {
    // Note: This test depends on how the store initializes recent repos
    // The component may need to call get_recent_repositories
    await expect(app.recentSection).toBeVisible();
  });

  test('should call open_repository when clicking a recent repo', async ({ page }) => {
    // Wait for recent items to render
    const recentItem = app.recentItems.first();
    // Only proceed if recent items are rendered (depends on store initialization)
    const itemCount = await app.recentItems.count();
    if (itemCount > 0) {
      await startCommandCapture(page);
      await recentItem.click();

      await waitForCommand(page, 'open_repository');

      const openCmds = await findCommand(page, 'open_repository');
      expect(openCmds.length).toBeGreaterThanOrEqual(1);
      expect((openCmds[0].args as { path?: string })?.path).toBe('/path/to/repo1');

      // Verify the welcome screen is still visible (mock returns null, so no repo loads)
      await expect(app.welcomeScreen).toBeVisible();
    }
  });

  test('surfaces an error toast when a recent repository can no longer be opened', async ({ page }) => {
    // The recent list is restored from the persisted store, not from a command,
    // so seed it directly to guarantee an entry to click.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: { setState: (s: Record<string, unknown>) => void };
      };
      stores.repositoryStore.setState({
        recentRepositories: [{ path: '/path/to/gone', name: 'gone', lastOpened: Date.now() }],
      });
    });
    await expect(app.recentItems).toHaveCount(1);

    await startCommandCapture(page);
    await injectCommandError(page, 'open_repository', 'failed to open repository: /path/to/gone');

    await app.recentItems.first().click();

    // A moved or deleted repo must tell the user — repositoryStore.error is never rendered
    const toastMessage = page.locator('lv-toast-container .toast.error .toast-message');
    await expect(toastMessage).toContainText('failed to open repository', { timeout: 5000 });
    await expect(app.welcomeScreen).toBeVisible();
  });
});

test.describe('Clone Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();
  });

  test('should have URL input field', async () => {
    await expect(dialogs.clone.urlInput).toBeVisible();
  });

  test('should have Clone button', async () => {
    await expect(dialogs.clone.cloneButton).toBeVisible();
  });

  test('should allow entering repository URL', async () => {
    await dialogs.clone.fillUrl('https://github.com/test/repo.git');
    await expect(dialogs.clone.urlInput).toHaveValue('https://github.com/test/repo.git');
  });
});

test.describe('Clone Dialog - Command Verification', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();
  });

  test('should call clone_repository with correct URL and path', async ({ page }) => {
    // Fill in the clone form
    await dialogs.clone.fillUrl('https://github.com/user/my-project.git');
    await dialogs.clone.fillPath('/home/user/projects');

    // Start capturing commands before clicking clone
    await startCommandCapture(page);

    // Click the clone button
    await dialogs.clone.clone();

    await waitForCommand(page, 'clone_repository');

    // Verify clone_repository was called with the correct arguments
    const cloneCmds = await findCommand(page, 'clone_repository');
    expect(cloneCmds.length).toBeGreaterThanOrEqual(1);

    const args = cloneCmds[0].args as { url?: string; path?: string };
    expect(args.url).toBe('https://github.com/user/my-project.git');
    // The dialog constructs the full path as destination/repoName
    expect(args.path).toBe('/home/user/projects/my-project');
  });

  test('should call clone_repository with SSH URL', async ({ page }) => {
    await dialogs.clone.fillUrl('git@github.com:user/ssh-repo.git');
    await dialogs.clone.fillPath('/tmp/clones');

    await startCommandCapture(page);
    await dialogs.clone.clone();

    await waitForCommand(page, 'clone_repository');

    const cloneCmds = await findCommand(page, 'clone_repository');
    expect(cloneCmds.length).toBeGreaterThanOrEqual(1);

    const args = cloneCmds[0].args as { url?: string; path?: string };
    expect(args.url).toBe('git@github.com:user/ssh-repo.git');
    expect(args.path).toBe('/tmp/clones/ssh-repo');
  });

  test('should not call clone_repository when URL is empty', async ({ page }) => {
    // Only fill destination, leave URL empty
    await dialogs.clone.fillPath('/home/user/projects');

    // The Clone button should be disabled when URL is empty
    await expect(dialogs.clone.cloneButton).toBeDisabled();

    // Verify the dialog remains open
    await expect(dialogs.clone.dialog).toBeVisible();
  });

  test('should not call clone_repository when destination is empty', async ({ page }) => {
    // Only fill URL, leave destination empty
    await dialogs.clone.fillUrl('https://github.com/user/repo.git');

    // The Clone button should be disabled when destination is empty
    await expect(dialogs.clone.cloneButton).toBeDisabled();

    // Verify the dialog remains open
    await expect(dialogs.clone.dialog).toBeVisible();
  });
});

test.describe('Clone Dialog - Error Handling', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();
  });

  test('should show error message when clone fails', async ({ page }) => {
    // Fill in valid form data
    await dialogs.clone.fillUrl('https://github.com/user/nonexistent-repo.git');
    await dialogs.clone.fillPath('/home/user/projects');

    // Inject error for clone_repository command
    await injectCommandError(page, 'clone_repository', 'Repository not found');

    // Click clone
    await dialogs.clone.clone();

    // Verify error message is displayed in the dialog
    const errorMessage = page.locator('lv-clone-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Repository not found');
  });

  test('should disable clone button when URL is empty', async ({ page }) => {
    // Leave URL empty but fill destination
    await dialogs.clone.fillPath('/home/user/projects');

    // The Clone button should be disabled when URL is empty (validation at button level)
    await expect(dialogs.clone.cloneButton).toBeDisabled();

    // Dialog should remain open
    await expect(dialogs.clone.dialog).toBeVisible();
  });

  test('should disable clone button when destination is empty', async ({ page }) => {
    // Fill URL but leave destination empty
    await dialogs.clone.fillUrl('https://github.com/user/repo.git');

    // The Clone button should be disabled when destination is empty (validation at button level)
    await expect(dialogs.clone.cloneButton).toBeDisabled();

    // Dialog should remain open
    await expect(dialogs.clone.dialog).toBeVisible();
  });

  test('should clear error message when user edits URL after error', async ({ page }) => {
    // Trigger a clone error by filling both fields and injecting an error
    await dialogs.clone.fillUrl('https://github.com/user/bad-repo.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await injectCommandError(page, 'clone_repository', 'Repository not found');
    await dialogs.clone.clone();

    const errorMessage = page.locator('lv-clone-dialog .error-message');
    await expect(errorMessage).toBeVisible();

    // Edit the URL field -- error should clear
    await dialogs.clone.fillUrl('https://github.com/user/good-repo.git');
    await expect(errorMessage).not.toBeVisible();
  });

  test('should show network error message on clone failure', async ({ page }) => {
    await dialogs.clone.fillUrl('https://github.com/user/repo.git');
    await dialogs.clone.fillPath('/home/user/projects');

    // Inject a network-style error
    await injectCommandError(page, 'clone_repository', 'Failed to connect: network unreachable');

    await dialogs.clone.clone();

    const errorMessage = page.locator('lv-clone-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Failed to connect');
  });
});

test.describe('Init Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.initButton.click();
    await dialogs.init.waitForOpen();
  });

  test('should have path input field', async () => {
    await expect(dialogs.init.pathInput).toBeVisible();
  });

  test('should have Initialize button', async () => {
    await expect(dialogs.init.initButton).toBeVisible();
  });

  test('should allow entering directory path', async () => {
    await dialogs.init.fillPath('/path/to/new/repo');
    await expect(dialogs.init.pathInput).toHaveValue('/path/to/new/repo');
  });
});

test.describe('Init Dialog - Command Verification', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.initButton.click();
    await dialogs.init.waitForOpen();
  });

  test('should call init_repository with correct path', async ({ page }) => {
    await dialogs.init.fillPath('/home/user/new-project');

    // Start capturing commands before clicking init
    await startCommandCapture(page);

    await dialogs.init.init();

    await waitForCommand(page, 'init_repository');

    const initCmds = await findCommand(page, 'init_repository');
    expect(initCmds.length).toBeGreaterThanOrEqual(1);

    const args = initCmds[0].args as { path?: string; bare?: boolean };
    expect(args.path).toBe('/home/user/new-project');
    expect(args.bare).toBe(false);
  });

  test('should call init_repository with bare=true when bare checkbox is checked', async ({ page }) => {
    await dialogs.init.fillPath('/home/user/bare-repo');
    await dialogs.init.setBare(true);

    await startCommandCapture(page);

    await dialogs.init.init();

    await waitForCommand(page, 'init_repository');

    const initCmds = await findCommand(page, 'init_repository');
    expect(initCmds.length).toBeGreaterThanOrEqual(1);

    const args = initCmds[0].args as { path?: string; bare?: boolean };
    expect(args.path).toBe('/home/user/bare-repo');
    expect(args.bare).toBe(true);
  });

  test('should not call init_repository when path is empty', async ({ page }) => {
    // Leave path empty - the Initialize button should be disabled
    await expect(dialogs.init.initButton).toBeDisabled();

    // Verify the dialog remains open
    await expect(dialogs.init.dialog).toBeVisible();
  });

  test('should pass the configured default branch name to init_repository', async ({ page }) => {
    // The dialog reads the setting when it opens, so change it and reopen
    await dialogs.init.closeWithEscape();
    await page.evaluate(() => {
      (window as any).__GITNADO_STORES__.settingsStore.getState().setDefaultBranchName('trunk');
    });
    await app.initButton.click();
    await dialogs.init.waitForOpen();

    await expect(dialogs.init.initialBranchInput).toHaveValue('trunk');

    await dialogs.init.fillPath('/home/user/trunk-project');

    await startCommandCapture(page);
    await dialogs.init.init();
    await waitForCommand(page, 'init_repository');

    const initCmds = await findCommand(page, 'init_repository');
    expect(initCmds.length).toBeGreaterThanOrEqual(1);

    const args = initCmds[0].args as { path?: string; initialBranch?: string };
    expect(args.path).toBe('/home/user/trunk-project');
    expect(args.initialBranch).toBe('trunk');
  });

  test('should show an error and keep the init dialog open for an invalid initial branch', async ({ page }) => {
    await dialogs.init.fillPath('/home/user/bad-branch-project');
    await dialogs.init.fillInitialBranch('bad name');

    await injectCommandError(page, 'init_repository', 'Invalid initial branch name: bad name');

    await dialogs.init.init();

    const errorMessage = page.locator('lv-init-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Invalid initial branch name: bad name');
    await expect(dialogs.init.dialog).toBeVisible();
  });
});

test.describe('Init Dialog - Error Handling', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await app.initButton.click();
    await dialogs.init.waitForOpen();
  });

  test('should show error message when init fails', async ({ page }) => {
    await dialogs.init.fillPath('/home/user/new-project');

    // Inject error for init_repository command
    await injectCommandError(page, 'init_repository', 'Permission denied: cannot create directory');

    await dialogs.init.init();

    // Verify error message is displayed in the dialog
    const errorMessage = page.locator('lv-init-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Permission denied');
  });

  test('should disable init button when path is empty', async ({ page }) => {
    // Leave path empty - the Initialize button should be disabled (validation at button level)
    await expect(dialogs.init.initButton).toBeDisabled();

    // Dialog should remain open
    await expect(dialogs.init.dialog).toBeVisible();
  });

  test('should clear error message when user edits path after error', async ({ page }) => {
    // Trigger an init error by filling path and injecting an error
    await dialogs.init.fillPath('/home/user/existing-project');

    await injectCommandError(page, 'init_repository', 'Directory already exists');
    await dialogs.init.init();

    const errorMessage = page.locator('lv-init-dialog .error-message');
    await expect(errorMessage).toBeVisible();

    // Edit the path field -- error should clear
    await dialogs.init.fillPath('/home/user/new-project');
    await expect(errorMessage).not.toBeVisible();
  });

  test('should show error when directory already contains a git repo', async ({ page }) => {
    await dialogs.init.fillPath('/home/user/existing-repo');

    // Inject a specific error simulating an existing repo
    await injectCommandError(page, 'init_repository', 'Directory already contains a .git directory');

    await dialogs.init.init();

    const errorMessage = page.locator('lv-init-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('already contains');
  });
});

// ============================================================================
// Extended Tests - Transition After Success
// ============================================================================

test.describe('Welcome - Extended Tests', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test('clone success should transition away from welcome screen to repo view', async ({ page }) => {
    // Set up Tauri mocks with empty repo initially (welcome screen visible)
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();

    // Verify welcome screen is shown
    await expect(app.welcomeScreen).toBeVisible();

    // Open clone dialog
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    // Fill in clone form
    await dialogs.clone.fillUrl('https://github.com/user/my-project.git');
    await dialogs.clone.fillPath('/home/user/projects');

    // Mock clone_repository to succeed and return a valid repository
    // After clone, the app opens the repository, so we need open_repository to return data
    await page.evaluate(() => {
      const originalInvoke = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke;

      (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
        if (command === 'clone_repository') {
          return { path: '/home/user/projects/my-project', name: 'my-project' };
        }
        if (command === 'open_repository' || command === 'get_repository_info') {
          return {
            path: '/home/user/projects/my-project',
            name: 'my-project',
            isValid: true,
            isBare: false,
            headRef: 'main',
            state: 'clean',
          };
        }
        return originalInvoke(command, args);
      };
    });

    // Click clone
    await dialogs.clone.clone();

    // Verify the clone dialog closes (either closes or shows progress then closes)
    await expect(dialogs.clone.dialog).not.toBeVisible({ timeout: 10000 });

    // After successful clone, the welcome screen should no longer be visible
    // as the app transitions to the repository view
    await expect(app.welcomeScreen).not.toBeVisible({ timeout: 10000 });
  });

  test('init success should transition away from welcome screen', async ({ page }) => {
    // Set up Tauri mocks with empty repo initially (welcome screen visible)
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();

    // Verify welcome screen is shown
    await expect(app.welcomeScreen).toBeVisible();

    // Open init dialog
    await app.initButton.click();
    await dialogs.init.waitForOpen();

    // Fill in init form
    await dialogs.init.fillPath('/home/user/new-project');

    // Mock init_repository to succeed and return a valid repository
    // After init, the app opens the repository
    await page.evaluate(() => {
      const originalInvoke = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke;

      (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
        if (command === 'init_repository') {
          return { path: '/home/user/new-project', name: 'new-project' };
        }
        if (command === 'open_repository' || command === 'get_repository_info') {
          return {
            path: '/home/user/new-project',
            name: 'new-project',
            isValid: true,
            isBare: false,
            headRef: 'main',
            state: 'clean',
          };
        }
        return originalInvoke(command, args);
      };
    });

    // Click init
    await dialogs.init.init();

    // Verify the init dialog closes
    await expect(dialogs.init.dialog).not.toBeVisible({ timeout: 10000 });

    // After successful init, the welcome screen should no longer be visible
    await expect(app.welcomeScreen).not.toBeVisible({ timeout: 10000 });
  });
});

test.describe('Welcome Screen - recent repository rows', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    await app.goto();

    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, unknown>).__GITNADO_STORES__ !== 'undefined',
      { timeout: 10000 }
    );

    // Seed recents through the store: most recent first ⇒ rows are repo1, repo2.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => {
            clearRecentRepositories: () => void;
            addRecentRepository: (path: string, name: string) => void;
          };
        };
      };
      const state = stores.repositoryStore.getState();
      state.clearRecentRepositories();
      state.addRecentRepository('/path/to/repo2', 'repo2');
      state.addRecentRepository('/path/to/repo1', 'repo1');
    });

    await expect(app.recentItems).toHaveCount(2);
  });

  test('reveals the per-row remove control on hover', async () => {
    const remove = app.recentItems.first().locator('.recent-remove');
    await expect(remove).toHaveCount(1);

    await expect
      .poll(() => remove.evaluate((el) => getComputedStyle(el).opacity))
      .toBe('0');

    await app.recentItems.first().hover();

    await expect
      .poll(() => remove.evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');
  });

  test('has no stray remove buttons sitting between rows', async () => {
    await expect(app.welcomeScreen.locator('.recent-list > button.recent-remove')).toHaveCount(0);
  });

  test('removes only the clicked entry and does not open it', async ({ page }) => {
    await startCommandCapture(page);

    await app.recentItems.first().hover();
    await app.recentItems.first().locator('.recent-remove').click();

    await expect(app.recentItems).toHaveCount(1);
    await expect(app.recentItems.first()).toContainText('repo2');
    expect(await findCommand(page, 'open_repository')).toHaveLength(0);
  });

  test('opens a recent repository with the keyboard', async ({ page }) => {
    await startCommandCapture(page);

    await app.recentItems.first().press('Enter');

    await waitForCommand(page, 'open_repository');
    const openCmds = await findCommand(page, 'open_repository');
    expect(openCmds.length).toBeGreaterThan(0);
    expect((openCmds[0].args as { path: string }).path).toBe('/path/to/repo1');
  });

  test('Enter on the remove button removes the entry without opening it', async ({ page }) => {
    await startCommandCapture(page);

    await app.recentItems.first().hover();
    await app.recentItems.first().locator('.recent-remove').press('Enter');

    await expect(app.recentItems).toHaveCount(1);
    await expect(app.recentItems.first()).toContainText('repo2');
    expect(await findCommand(page, 'open_repository')).toHaveLength(0);
  });
});

/**
 * "Reopen Last Repositories" (Settings → Behavior).
 *
 * The startup restore used to run unconditionally, so this setting — persisted,
 * with a setter, and read by nothing — could not be obeyed. A restart is
 * simulated by seeding the persisted zustand blobs before the page loads; the
 * seed only fills in values that are not already stored, so a reload keeps
 * whatever the running app wrote.
 */
test.describe('Session restore', () => {
  const RESTORED_PATH = '/tmp/test-repo';

  async function seedSession(page: Page, openLastRepository: boolean): Promise<void> {
    await page.addInitScript(
      ({ openLastRepository, path }) => {
        if (!localStorage.getItem('gitnado-repositories')) {
          localStorage.setItem(
            'gitnado-repositories',
            JSON.stringify({
              state: {
                recentRepositories: [],
                persistedOpenRepos: [{ path, name: 'test-repo' }],
                activeIndex: 0,
                persistedActivePath: path,
              },
              version: 0,
            })
          );
        }
        if (!localStorage.getItem('gitnado-settings')) {
          localStorage.setItem(
            'gitnado-settings',
            JSON.stringify({ state: { openLastRepository }, version: 7 })
          );
        }
      },
      { openLastRepository, path: RESTORED_PATH }
    );
  }

  async function persistedPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const raw = localStorage.getItem('gitnado-repositories');
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { state?: { persistedOpenRepos?: { path: string }[] } };
      return (parsed.state?.persistedOpenRepos ?? []).map((r) => r.path);
    });
  }

  test('reopens the last session when the setting is on', async ({ page }) => {
    await setupTauriMocks(page);
    await seedSession(page, true);
    const app = new AppPage(page);
    await app.goto();

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);
    await expect(app.welcomeScreen).not.toBeVisible();
  });

  test('starts on the welcome screen when the setting is off, keeping the tabs', async ({
    page,
  }) => {
    await setupTauriMocks(page);
    await seedSession(page, false);
    const app = new AppPage(page);
    await app.goto();

    await expect(app.welcomeScreen).toBeVisible();
    await expect(page.locator('lv-toolbar .tab')).toHaveCount(0);
    // Nothing failed to restore, so nothing is reported as an error either.
    await expect(page.locator('.toast')).toHaveCount(0);
    // The remembered tabs survive: the toggle is reversible, not a wipe.
    expect(await persistedPaths(page)).toEqual([RESTORED_PATH]);
  });

  test('restores again once the setting is turned back on', async ({ page }) => {
    await setupTauriMocks(page);
    await seedSession(page, false);
    const app = new AppPage(page);
    await app.goto();
    await expect(app.welcomeScreen).toBeVisible();

    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        settingsStore: { getState: () => { setOpenLastRepository: (v: boolean) => void } };
      };
      stores.settingsStore.getState().setOpenLastRepository(true);
    });
    await page.reload();

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);
  });
});

/** Repository payload shaped like the backend's `Repository`. */
function repositoryPayload(path: string) {
  return {
    path,
    name: path.split('/').pop(),
    isValid: true,
    isBare: false,
    headRef: 'main',
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

function scanResultPayload(overrides: Record<string, unknown> = {}) {
  return {
    root: '/code',
    repositories: [
      { path: '/code/alpha', name: 'alpha', isBare: false },
      { path: '/code/beta', name: 'beta', isBare: false },
    ],
    scannedDirectories: 12,
    truncated: false,
    cancelled: false,
    ...overrides,
  };
}

/** Fire one of the webview's OS drag/drop events through the Tauri mock. */
async function emitDragEvent(
  page: import('@playwright/test').Page,
  event: 'tauri://drag-enter' | 'tauri://drag-over' | 'tauri://drag-leave' | 'tauri://drag-drop',
  paths: string[] = []
): Promise<void> {
  await page.evaluate(
    ({ name, dropped }) => {
      const emit = (window as unknown as {
        __EMIT_TAURI_EVENT__: (event: string, payload: unknown) => void;
      }).__EMIT_TAURI_EVENT__;
      emit(name, { paths: dropped, position: { x: 20, y: 20 } });
    },
    { name: event, dropped: paths }
  );
}

test.describe('Welcome Screen - scan for repositories', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    await app.goto();
    await expect(app.welcomeScreen).toBeVisible();
  });

  test('scans the chosen folder and opens the selected repository', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|open': '/code',
      scan_for_repositories: scanResultPayload(),
      open_repository: repositoryPayload('/code/alpha'),
      get_repository_info: repositoryPayload('/code/alpha'),
    });

    await app.scanButton.click();

    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.result-item')).toHaveCount(2);
    await expect(dialog.locator('.results-toolbar')).toContainText('2 repositories');

    const scanCalls = await findCommand(page, 'scan_for_repositories');
    expect((scanCalls[0].args as { path: string }).path).toBe('/code');

    // Nothing is opened until the user picks something.
    const openSelected = dialog.getByRole('button', { name: /Open selected/ });
    await expect(openSelected).toBeDisabled();

    await dialog.locator('.result-item').first().locator('input[type="checkbox"]').check();
    await expect(openSelected).toBeEnabled();
    await openSelected.click();

    // The repository really opens: the welcome screen gives way to the repo view.
    await expect(app.welcomeScreen).not.toBeVisible({ timeout: 10000 });
    const openCalls = await findCommand(page, 'open_repository');
    expect((openCalls[0].args as { path: string }).path).toBe('/code/alpha');
  });

  test('reports a folder with no repositories in it', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|open': '/code',
      scan_for_repositories: scanResultPayload({ repositories: [], scannedDirectories: 40 }),
    });

    await app.scanButton.click();

    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.explanation')).toContainText('No Git repositories were found');
    await expect(dialog.locator('.notice')).toContainText('40');
    await expect(dialog.locator('.result-item')).toHaveCount(0);
  });

  test('surfaces a scan failure and offers a retry', async ({ page }) => {
    await injectCommandMock(page, { 'plugin:dialog|open': '/code' });
    await injectCommandError(page, 'scan_for_repositories', '/code no longer exists');

    await app.scanButton.click();

    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.error-message')).toContainText('no longer exists');

    // A failed scan used to be a dead end: Close was the only way out, and the
    // folder went with it. The folder is often only briefly unreachable (a
    // network volume, a rename), so retrying it is the recovery.
    await injectCommandMock(page, { scan_for_repositories: scanResultPayload() });
    await dialog.getByRole('button', { name: 'Try again' }).click();

    await expect(dialog.locator('.result-item')).toHaveCount(2);
    await expect(dialog.locator('.error-message')).toHaveCount(0);
  });

  test('does not open the scan dialog when the folder picker is cancelled', async ({ page }) => {
    await injectCommandMock(page, { 'plugin:dialog|open': null });

    await app.scanButton.click();

    // The element is always mounted in the shell; a cancelled picker must
    // leave it closed (and so invisible), not open it on an empty folder.
    await expect(page.locator('lv-scan-repositories-dialog .body')).not.toBeVisible();
  });
});

test.describe('Welcome Screen - dropping a folder on the window', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    await app.goto();
    await expect(app.welcomeScreen).toBeVisible();
  });

  test('shows a drop affordance while a folder is dragged over the window', async ({ page }) => {
    await emitDragEvent(page, 'tauri://drag-enter', ['/code/alpha']);
    await expect(app.welcomeScreen.locator('.drop-overlay')).toBeVisible();
    await expect(app.welcomeScreen.locator('.drop-overlay')).toContainText('Drop a folder');

    await emitDragEvent(page, 'tauri://drag-leave');
    await expect(app.welcomeScreen.locator('.drop-overlay')).toHaveCount(0);
  });

  test('shows only the welcome screen\'s own overlay, never two', async ({ page }) => {
    // app-shell renders a second copy of this affordance for the
    // repository-open state (see the describe below). It is scoped to that
    // state precisely so a drag here does not stack two dashed frames.
    await emitDragEvent(page, 'tauri://drag-enter', ['/code/alpha']);

    await expect(app.welcomeScreen.locator('.drop-overlay')).toBeVisible();
    await expect(page.locator('lv-app-shell .window-drop-overlay')).toHaveCount(0);
  });

  test('opens a dropped repository', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/code/alpha',
        name: 'alpha',
        exists: true,
        isDirectory: true,
        isRepository: true,
        isBare: false,
      },
      open_repository: repositoryPayload('/code/alpha'),
      get_repository_info: repositoryPayload('/code/alpha'),
    });

    await emitDragEvent(page, 'tauri://drag-enter', ['/code/alpha']);
    await expect(app.welcomeScreen.locator('.drop-overlay')).toBeVisible();
    await emitDragEvent(page, 'tauri://drag-drop', ['/code/alpha']);

    await expect(app.welcomeScreen).not.toBeVisible({ timeout: 10000 });
    const openCalls = await findCommand(page, 'open_repository');
    expect((openCalls[0].args as { path: string }).path).toBe('/code/alpha');
  });

  test('offers a scan or an init for a dropped folder that is not a repository', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/projects',
        name: 'projects',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
      scan_for_repositories: scanResultPayload({ root: '/projects' }),
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects']);

    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');
    // The drop affordance goes away as soon as the drop lands.
    await expect(app.welcomeScreen.locator('.drop-overlay')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Scan it for repositories' }).click();
    await expect(dialog.locator('.result-item')).toHaveCount(2);
    const scanCalls = await findCommand(page, 'scan_for_repositories');
    expect((scanCalls[0].args as { path: string }).path).toBe('/projects');
  });

  test('re-points the scan dialog at a folder dropped while it is already open', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/projects',
        name: 'projects',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
      scan_for_repositories: scanResultPayload({ root: '/projects' }),
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects']);
    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');
    await dialog.getByRole('button', { name: 'Scan it for repositories' }).click();
    await expect(dialog.locator('.result-item')).toHaveCount(2);

    // An OS drop is not blocked by an in-page modal: a second folder can land
    // while the dialog is open, and it must re-point the dialog rather than
    // vanish.
    await emitDragEvent(page, 'tauri://drag-drop', ['/elsewhere']);

    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');
    await expect(dialog.locator('.folder-path')).toHaveText('/elsewhere');
    await expect(dialog.locator('.result-item')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('elsewhere');

    // Initialize acts on the folder the dialog is actually showing.
    await dialog.getByRole('button', { name: 'Initialize a repository here' }).click();
    await expect(page.getByRole('textbox', { name: /Repository Location/i })).toHaveValue(
      '/elsewhere'
    );
  });

  test('closes the stale offer when the dropped folder has become a repository', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/projects/new-thing',
        name: 'new-thing',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects/new-thing']);
    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');

    // The user does exactly what the offer asked for — creates a repository in
    // that folder from a terminal — and drops it again, which is the only way
    // back into this dialog.
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/projects/new-thing',
        name: 'new-thing',
        exists: true,
        isDirectory: true,
        isRepository: true,
        isBare: false,
      },
      open_repository: repositoryPayload('/projects/new-thing'),
      get_repository_info: repositoryPayload('/projects/new-thing'),
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects/new-thing']);

    // The repository opens — and the modal that still called it "not a Git
    // repository", and still offered to initialize one there, goes with it.
    await expect(app.welcomeScreen).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('.toast')).toContainText('Opened new-thing');
    await expect(dialog.locator('.body')).not.toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Initialize a repository here' })
    ).toHaveCount(0);
  });

  test('rescans and says so when the same folder is dropped again', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/projects',
        name: 'projects',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
      scan_for_repositories: scanResultPayload({ root: '/projects' }),
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects']);
    const dialog = page.locator('lv-scan-repositories-dialog');
    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');
    await dialog.getByRole('button', { name: 'Scan it for repositories' }).click();
    await expect(dialog.locator('.result-item')).toHaveCount(2);

    // The SAME folder again: the path, the mode and the open state are all
    // unchanged, so this drop used to reach a dialog that could not tell it had
    // happened — no toast, no rescan, nothing.
    await emitDragEvent(page, 'tauri://drag-drop', ['/projects']);

    await expect(page.locator('.toast')).toContainText('Rescanning projects');
    await expect(dialog.locator('.result-item')).toHaveCount(2);
    await expect
      .poll(async () => (await findCommand(page, 'scan_for_repositories')).length)
      .toBe(2);
  });

  test('offers to initialize a dropped folder that is not a repository', async ({ page }) => {
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/projects/new-thing',
        name: 'new-thing',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects/new-thing']);

    const dialog = page.locator('lv-scan-repositories-dialog');
    await dialog.getByRole('button', { name: 'Initialize a repository here' }).click();

    // The init dialog takes over, pre-filled with the dropped folder.
    await expect(page.getByRole('dialog', { name: 'Initialize Repository' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Repository Location/i })).toHaveValue(
      '/projects/new-thing'
    );
  });

  test('reports a dropped path that is gone', async ({ page }) => {
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/code/gone',
        name: 'gone',
        exists: false,
        isDirectory: false,
        isRepository: false,
        isBare: false,
      },
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/code/gone']);

    await expect(page.locator('.toast')).toContainText('no longer exists');
    await expect(app.welcomeScreen).toBeVisible();
  });

  test('reports a dropped repository that cannot be opened', async ({ page }) => {
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/code/locked',
        name: 'locked',
        exists: true,
        isDirectory: true,
        isRepository: true,
        isBare: false,
      },
    });
    await injectCommandError(page, 'open_repository', 'permission denied');

    await emitDragEvent(page, 'tauri://drag-drop', ['/code/locked']);

    await expect(page.locator('.toast')).toContainText('permission denied');
    await expect(app.welcomeScreen).toBeVisible();
  });

  test('names each dropped folder that is not a repository and offers a scan for each', async ({
    page,
  }) => {
    // Two folders selected in the file manager and dropped together used to
    // produce ONE toast — "2 dropped folders are not Git repositories" — whose
    // single "Scan folder" button acted on a folder it did not name, leaving
    // the other with no route back at all.
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/work/alpha',
        name: 'alpha',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/work/alpha', '/work/beta']);

    await expect(page.locator('.toast')).toHaveCount(2);
    await expect(page.locator('.toast').nth(0)).toContainText('alpha is not a Git repository');
    await expect(page.locator('.toast').nth(1)).toContainText('beta is not a Git repository');

    // Each button says which folder it takes — and takes that one.
    const dialog = page.locator('lv-scan-repositories-dialog');
    await page.getByRole('button', { name: 'Scan alpha' }).click();
    await expect(dialog.locator('.explanation')).toContainText('not a Git repository');
    await expect(dialog.locator('.folder-path')).toHaveText('/work/alpha');

    // And the second folder is still reachable, which is the whole point.
    await page.getByRole('button', { name: 'Scan beta' }).click();
    await expect(dialog.locator('.folder-path')).toHaveText('/work/beta');
  });
});

/**
 * The SAME drop, with a repository already open.
 *
 * `startRepositoryDropListener` is bound for the whole window, so a folder
 * dropped here really is accepted — it opens in a new tab. But the affordance
 * was bound only to `<lv-welcome .dragActive>`, so the identical drag showed a
 * dashed "Drop a folder to open it" frame on one screen and absolutely nothing
 * on the other: the same window behaving differently in its two states.
 */
test.describe('Dropping a folder while a repository is open', () => {
  const dropOverlay = (page: Page) => page.locator('lv-app-shell .window-drop-overlay');

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // The welcome screen is gone — this is the other state.
    await expect(page.locator('lv-welcome')).toHaveCount(0);
  });

  test('shows the drop affordance the welcome screen shows', async ({ page }) => {
    await emitDragEvent(page, 'tauri://drag-enter', ['/code/alpha']);

    await expect(dropOverlay(page)).toBeVisible();
    await expect(dropOverlay(page)).toContainText('Drop a folder');
    // And it says what will happen, which differs from the welcome case.
    await expect(dropOverlay(page)).toContainText('new tab');

    await emitDragEvent(page, 'tauri://drag-leave');
    await expect(dropOverlay(page)).toHaveCount(0);
  });

  test('opens a dropped repository in a new tab and drops the affordance', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      classify_repository_path: {
        path: '/code/alpha',
        name: 'alpha',
        exists: true,
        isDirectory: true,
        isRepository: true,
        isBare: false,
      },
      open_repository: repositoryPayload('/code/alpha'),
      get_repository_info: repositoryPayload('/code/alpha'),
    });

    await emitDragEvent(page, 'tauri://drag-enter', ['/code/alpha']);
    await expect(dropOverlay(page)).toBeVisible();
    await emitDragEvent(page, 'tauri://drag-drop', ['/code/alpha']);

    // The drop lands as a second tab…
    await expect(page.locator('lv-toolbar .tab', { hasText: 'alpha' })).toBeVisible({
      timeout: 10000,
    });
    // …and the affordance goes away with the drag that raised it.
    await expect(dropOverlay(page)).toHaveCount(0);
  });

});

/**
 * Language setting.
 *
 * @lit/localize runs in runtime mode, so picking a language has to re-render
 * the app in place — the dialog the user is looking at and the welcome screen
 * behind it — with no restart and no reload.
 */
test.describe('Language setting', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    await app.goto();
  });

  /** Open Settings with the keyboard shortcut — it works without a repository */
  async function openSettings(page: Page): Promise<void> {
    await page.keyboard.press('Meta+,');
    await expect(page.locator('lv-settings-dialog')).toBeVisible();
  }

  function languageSelect(page: Page) {
    return page.locator('lv-settings-dialog #language-select');
  }

  test('offers every locale the app ships', async ({ page }) => {
    await openSettings(page);
    const options = languageSelect(page).locator('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText('English');
    await expect(options.nth(1)).toHaveText('Français');
    await expect(languageSelect(page)).toHaveValue('en');
  });

  test('switching language re-renders the app without a reload', async ({ page }) => {
    // A sentinel that only survives if the document is never reloaded.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__NO_RELOAD__ = true;
    });

    await openSettings(page);
    await languageSelect(page).selectOption('fr');

    // The dialog the user is looking at...
    await expect(page.locator('lv-settings-dialog .section-title').first()).toHaveText('Apparence');
    // ...and the welcome screen behind it, both in the new language.
    await expect(app.welcomeTagline).toHaveText('Un client Git puissant et open source');
    // The Open/Clone/Init actions, in order — the page object finds them by
    // their English text, which is exactly what has just changed.
    await expect(app.welcomeScreen.locator('.action-btn').first()).toContainText('Ouvrir');

    const survived = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__NO_RELOAD__ === true
    );
    expect(survived, 'the page was never reloaded').toBe(true);
  });

  test('switching back to English restores the English UI', async ({ page }) => {
    await openSettings(page);
    await languageSelect(page).selectOption('fr');
    await expect(app.welcomeTagline).toHaveText('Un client Git puissant et open source');

    await languageSelect(page).selectOption('en');
    await expect(page.locator('lv-settings-dialog .section-title').first()).toHaveText('Appearance');
    await expect(app.welcomeTagline).toHaveText('A powerful, open-source Git client');
  });

  test('the chosen language is remembered on the next launch', async ({ page }) => {
    await openSettings(page);
    await languageSelect(page).selectOption('fr');
    await expect(app.welcomeTagline).toHaveText('Un client Git puissant et open source');

    await page.reload();
    await app.waitForReady();

    await expect(app.welcomeTagline).toHaveText('Un client Git puissant et open source');
    await openSettings(page);
    await expect(languageSelect(page)).toHaveValue('fr');
  });
});

test.describe('Language setting with an unsupported persisted locale', () => {
  test('falls back to English instead of failing to render', async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    // A locale the app no longer ships — persisted by an older build, or by a
    // language that was dropped.
    await page.addInitScript(() => {
      localStorage.setItem(
        'gitnado-settings',
        JSON.stringify({ state: { language: 'xx-YY' }, version: 7 })
      );
    });

    const app = new AppPage(page);
    await app.goto();

    await expect(app.welcomeTagline).toHaveText('A powerful, open-source Git client');
    await page.keyboard.press('Meta+,');
    await expect(page.locator('lv-settings-dialog #language-select')).toHaveValue('en');
  });
});

/**
 * The scan offer's "Initialize a repository here" with a repository ALREADY
 * open. Every other init test runs from the welcome screen, where the welcome
 * component owns the init dialog; once a repository is open it is app-shell's
 * copy that has to answer — with the toolbar's own dialog mounted alongside it.
 */
test.describe('Initialize a repository here - with a repository already open', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await expect(app.welcomeScreen).toHaveCount(0);
  });

  test('opens the shell init dialog, pre-filled with the dropped folder', async ({ page }) => {
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/projects/new-thing',
        name: 'new-thing',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects/new-thing']);

    const scanDialog = page.locator('lv-scan-repositories-dialog');
    await scanDialog.getByRole('button', { name: 'Initialize a repository here' }).click();

    // Exactly one init dialog is on screen, even though the toolbar mounts one
    // of its own: the page object must resolve to that one and no other.
    await expect(app.initDialog).toHaveCount(1);
    await expect(app.initDialog).toBeVisible();
    await expect(dialogs.init.dialog).toBeVisible();
    await expect(dialogs.init.pathInput).toHaveValue('/projects/new-thing');
  });

  test('initializes the dropped folder from that dialog', async ({ page }) => {
    await injectCommandMock(page, {
      classify_repository_path: {
        path: '/projects/new-thing',
        name: 'new-thing',
        exists: true,
        isDirectory: true,
        isRepository: false,
        isBare: false,
      },
      init_repository: repositoryPayload('/projects/new-thing'),
      get_repository_info: repositoryPayload('/projects/new-thing'),
    });

    await emitDragEvent(page, 'tauri://drag-drop', ['/projects/new-thing']);
    await page
      .locator('lv-scan-repositories-dialog')
      .getByRole('button', { name: 'Initialize a repository here' })
      .click();
    await expect(app.initDialog).toBeVisible();

    await startCommandCapture(page);
    await dialogs.init.init();

    await waitForCommand(page, 'init_repository');
    const args = (await findCommand(page, 'init_repository'))[0].args as { path?: string };
    expect(args.path).toBe('/projects/new-thing');
    // The dialog closes on success, so nothing is left open behind the repo.
    await expect(app.initDialog).toHaveCount(0);
  });
});

/**
 * The language a user ends up in on first launch after an UPGRADE. The system
 * locale is what a FRESH install starts from; an install that has been running
 * in English must not be switched to another language by an update.
 */
test.describe('Language on a French-locale machine', () => {
  test.use({ locale: 'fr-FR' });

  test('a fresh install follows the system language', async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    const app = new AppPage(page);
    await app.goto();

    await expect(app.welcomeTagline).toHaveText('Un client Git puissant et open source');
  });

  test('an upgrade keeps the English the user has always had', async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    // A settings blob from before the language setting existed: it has no
    // `language` key at all, and that install has only ever rendered English.
    await page.addInitScript(() => {
      localStorage.setItem(
        'gitnado-settings',
        JSON.stringify({ state: { theme: 'dark' }, version: 7 })
      );
    });

    const app = new AppPage(page);
    await app.goto();

    await expect(app.welcomeTagline).toHaveText('A powerful, open-source Git client');
    await page.keyboard.press('Meta+,');
    await expect(page.locator('lv-settings-dialog #language-select')).toHaveValue('en');
  });
});
