import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { injectCommandError } from '../fixtures/test-helpers';

/**
 * E2E tests for the file-watcher failure path.
 *
 * When the backend cannot register a watch — an exhausted
 * `fs.inotify.max_user_watches` budget is the usual cause on Linux — the app
 * used to log a warning to the console and carry on, so auto-refresh silently
 * stopped working with no indication to the user.
 *
 * setupOpenRepository() opens the default repo (/tmp/test-repo); extra repos
 * are added through the repository store like the welcome/restore flows do,
 * which is what makes app-shell start a watcher for them.
 */

const LIMIT_ERROR =
  'the system file-watch limit was reached while watching /tmp/huge-monorepo. ' +
  'Raise the inotify limit to restore it, e.g. `sudo sysctl fs.inotify.max_user_watches=524288`.';

async function addRepo(page: Page, path: string, name: string): Promise<void> {
  await page.evaluate(
    ({ path, name }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => { addRepository: (repo: unknown) => void };
        };
      };
      stores.repositoryStore.getState().addRepository({
        path,
        name,
        isValid: true,
        isBare: false,
        headRef: 'main',
        state: 'clean',
        isShallow: false,
        isPartialClone: false,
        cloneFilter: null,
      });
    },
    { path, name }
  );
}

test.describe('file watcher failure feedback', () => {
  test('warns the user, naming the cause, when auto-refresh cannot start', async ({ page }) => {
    await setupOpenRepository(page);
    await injectCommandError(page, 'start_watching', LIMIT_ERROR);

    await addRepo(page, '/tmp/huge-monorepo', 'huge-monorepo');

    const toast = page.locator('lv-toast-container .toast.warning');
    await expect(toast).toBeVisible();
    await expect(toast.locator('.toast-message')).toContainText(
      'Auto-refresh is unavailable for "huge-monorepo"'
    );
    // The one thing the user can actually act on
    await expect(toast.locator('.toast-message')).toContainText('fs.inotify.max_user_watches');
    // …and manual refresh still works, which the message has to say
    await expect(toast.locator('.toast-message')).toContainText('refresh manually');
  });

  test('offers a Retry that re-attempts the watch', async ({ page }) => {
    await setupOpenRepository(page);
    await injectCommandError(page, 'start_watching', LIMIT_ERROR);

    await addRepo(page, '/tmp/huge-monorepo', 'huge-monorepo');

    const toast = page.locator('lv-toast-container .toast.warning');
    await expect(toast).toBeVisible();

    const retry = toast.locator('.toast-action-btn');
    await expect(retry).toHaveText('Retry');

    // Record the retry attempt, then click. The mocked backend keeps failing,
    // so the toast is raised again rather than the app going quiet.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      (window as unknown as { __WATCH_RETRIES__: number }).__WATCH_RETRIES__ = 0;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'start_watching') {
          (window as unknown as { __WATCH_RETRIES__: number }).__WATCH_RETRIES__++;
        }
        return original(command, args);
      };
    });

    await retry.click();

    await page.waitForFunction(
      () => (window as unknown as { __WATCH_RETRIES__: number }).__WATCH_RETRIES__ > 0
    );
    await expect(
      page.locator('lv-toast-container .toast.warning:not(.exiting)')
    ).toBeVisible();
  });

  test('stays quiet when the watch succeeds', async ({ page }) => {
    await setupOpenRepository(page);

    await addRepo(page, '/tmp/second-repo', 'second-repo');

    // The tab for the new repo is up, so its watcher has been started
    await expect(page.locator('lv-toolbar .tab')).toHaveCount(2);
    await expect(page.locator('lv-toast-container .toast.warning')).toHaveCount(0);
  });
});
