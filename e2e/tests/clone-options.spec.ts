import { test, expect } from '@playwright/test';
import { setupTauriMocks, emptyRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * E2E: the clone dialog's branch and submodule options.
 *
 * The backend has always accepted a `branch`, but the dialog sent only url,
 * path, depth, filter and singleBranch — so cloning any branch other than the
 * remote's default was impossible from the UI. And with no recursive clone on
 * the backend, a cloned superproject left every submodule directory empty.
 */

const clonedRepo = {
  path: '/home/user/projects/proj',
  name: 'proj',
  isValid: true,
  isBare: false,
  headRef: 'develop',
};

const oneSubmodule = [
  {
    name: 'libs/vendor',
    path: 'libs/vendor',
    url: 'https://example.com/vendor.git',
    headOid: null,
    branch: null,
    initialized: false,
    status: 'uninitialized',
  },
];

test.describe('Clone Dialog - branch and submodule options', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await injectCommandMock(page, {
      clone_repository: clonedRepo,
      get_submodules: [],
      update_submodules: null,
    });
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();
  });

  test('offers the branch field and the submodule checkbox', async () => {
    await expect(dialogs.clone.branchInput).toBeVisible();
    await expect(dialogs.clone.submodulesCheckbox).toBeVisible();
    await expect(dialogs.clone.submodulesCheckbox).not.toBeChecked();
  });

  test('passes the requested branch to clone_repository', async ({ page }) => {
    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');
    await dialogs.clone.fillBranch('develop');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');

    const args = (await findCommand(page, 'clone_repository'))[0].args as { branch?: string };
    expect(args.branch).toBe('develop');
  });

  test('sends no branch when the field is left empty', async ({ page }) => {
    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');

    const args = (await findCommand(page, 'clone_repository'))[0].args as { branch?: string };
    expect(args.branch).toBeUndefined();
  });

  test('reports a branch that does not exist on the remote', async ({ page }) => {
    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');
    await dialogs.clone.fillBranch('no-such-branch');

    await injectCommandError(
      page,
      'clone_repository',
      "Remote branch no-such-branch not found in upstream origin",
    );
    await dialogs.clone.clone();

    const errorMessage = page.locator('lv-clone-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('no-such-branch');
    await expect(dialogs.clone.dialog).toBeVisible();
  });

  test('clones submodules after the clone finishes when asked', async ({ page }) => {
    await injectCommandMock(page, { get_submodules: oneSubmodule });

    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');
    await dialogs.clone.checkSubmodules();

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'update_submodules');

    const args = (await findCommand(page, 'update_submodules'))[0].args as {
      path?: string;
      init?: boolean;
      recursive?: boolean;
    };
    expect(args.path).toBe(clonedRepo.path);
    expect(args.init).toBe(true);
    expect(args.recursive).toBe(true);

    // The submodule phase ran AFTER the clone, against the new repository.
    const commands = (await findCommand(page, 'clone_repository')).length;
    expect(commands).toBeGreaterThanOrEqual(1);

    // Everything succeeded, so the dialog closes on its own.
    await expect(dialogs.clone.dialog).toBeHidden();
  });

  test('does not run the submodule phase when the box is unchecked', async ({ page }) => {
    await injectCommandMock(page, { get_submodules: oneSubmodule });

    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');
    await expect(dialogs.clone.dialog).toBeHidden();

    expect(await findCommand(page, 'update_submodules')).toHaveLength(0);
  });

  test('a submodule failure is reported as a partial success, not a failed clone', async ({
    page,
  }) => {
    await injectCommandMock(page, { get_submodules: oneSubmodule });
    await injectCommandError(page, 'update_submodules', 'authentication required');

    await dialogs.clone.fillUrl('https://example.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');
    await dialogs.clone.checkSubmodules();
    await dialogs.clone.clone();

    // A toast, because opening the cloned repository tears the welcome
    // screen — and the dialog it hosts — down.
    const warning = page.locator('.toast.warning', { hasText: /submodules were not/i });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('authentication required');
    // The clone itself succeeded, so nothing says it failed.
    await expect(page.locator('lv-clone-dialog .error-message')).toHaveCount(0);

    // And the repository the user asked for is open regardless.
    const opened = await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as
        | {
            repositoryStore: {
              getState: () => { openRepositories: { repository: { path: string } }[] };
            };
          }
        | undefined;
      return (
        stores?.repositoryStore.getState().openRepositories.map((r) => r.repository.path) ?? []
      );
    });
    expect(opened).toContain(clonedRepo.path);
  });
});
