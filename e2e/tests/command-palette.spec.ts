import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  injectCommandError,
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * The palette is loaded per repository: it caches the active repo's branches
 * and tracked files at open time and every entry it dispatches is scoped to
 * that repository. These specs cover the repository boundary from the real
 * surfaces — Ctrl/Cmd+P and the tab bar — rather than the internal flags.
 */

const palette = 'lv-command-palette[open]';

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

test.describe('Command palette repository boundary', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('an open palette closes when the active repository changes', async ({ page }) => {
    await addRepo(page, '/work/other-repo', 'other-repo');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/other-repo'
    );

    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();

    // Ctrl+digit, not a click: the palette is a full-screen overlay, so a
    // click on the tab would dismiss it through the backdrop and prove
    // nothing about the repository switch.
    await page.keyboard.press('Control+1');

    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');
    await expect(page.locator(palette)).toHaveCount(0);
  });

  test('a failed branch load is reported and the palette still opens', async ({ page }) => {
    await injectCommandError(page, 'get_branches', 'branches unavailable');

    await page.keyboard.press('Meta+p');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'Failed to load branches: branches unavailable'
    );
    await expect(page.locator(palette)).toBeVisible();
  });

  test('a failed tracked-file load is reported and the palette still opens', async ({ page }) => {
    await injectCommandError(page, 'list_tracked_files', 'index unreadable');

    await page.keyboard.press('Meta+p');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'Failed to load tracked files: index unreadable'
    );
    await expect(page.locator(palette)).toBeVisible();
  });

  test('an ordinary open reports nothing', async ({ page }) => {
    await page.keyboard.press('Meta+p');

    await expect(page.locator(palette)).toBeVisible();
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });
});

/**
 * "Open in Terminal" / "Reveal in File Manager" / "Open in Editor" act on the
 * ACTIVE repository. Success is the OS opening something, so the only visible
 * outcome is the palette closing; a backend failure must reach the user.
 */
test.describe('Command palette: open the active repository elsewhere', () => {
  async function runCommand(page: Page, label: string): Promise<void> {
    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();
    await page.locator(`${palette} .search-input`).fill(label);
    const entry = page.locator(`${palette} .command`, { hasText: label }).first();
    await expect(entry).toBeVisible();
    await entry.click();
  }

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // The editor command resolves with an OpenResult payload; the unmocked
    // default (null) would legitimately be treated as a failure.
    await startCommandCaptureWithMocks(page, {
      open_terminal: null,
      open_file_manager: null,
      open_in_configured_editor: { success: true, message: 'Opened in code' },
    });
  });

  test('Open in Terminal runs open_terminal for the active repository', async ({ page }) => {
    await runCommand(page, 'Open in Terminal');

    await waitForCommand(page, 'open_terminal');
    const calls = await findCommand(page, 'open_terminal');
    expect(calls[0].args).toMatchObject({ path: '/tmp/test-repo' });

    await expect(page.locator(palette)).toHaveCount(0);
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Reveal in File Manager runs open_file_manager for the active repository', async ({
    page,
  }) => {
    await runCommand(page, 'Reveal in File Manager');

    await waitForCommand(page, 'open_file_manager');
    const calls = await findCommand(page, 'open_file_manager');
    expect(calls[0].args).toMatchObject({ path: '/tmp/test-repo' });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Open in Editor opens the repository root in the configured editor', async ({ page }) => {
    await runCommand(page, 'Open in Editor');

    await waitForCommand(page, 'open_in_configured_editor');
    const calls = await findCommand(page, 'open_in_configured_editor');
    expect(calls[0].args).toMatchObject({
      path: '/tmp/test-repo',
      filePath: '/tmp/test-repo',
    });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('a backend failure surfaces its own message as an error toast', async ({ page }) => {
    await injectCommandError(
      page,
      'open_terminal',
      'Operation failed: No terminal emulator found',
      'OPERATION_FAILED'
    );

    await runCommand(page, 'Open in Terminal');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'No terminal emulator found'
    );
  });
});
