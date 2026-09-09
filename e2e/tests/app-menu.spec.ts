import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository, setupTauriMocks, initializeRepositoryStore } from '../fixtures/tauri-mock';
import {
  emitBackendEvent,
  findCommand,
  injectCommandMock,
  startCommandCapture,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the native application menu bar.
 *
 * Playwright cannot click a native OS menu, so what is covered here is
 * everything on this side of the boundary: choosing a menu item emits
 * `app-menu-action` with the item's id, and the app must react exactly as it
 * does when the same action is run from the command palette — including the
 * "open a repository first" guard, and the enabled/disabled state pushed back
 * to the native menu as repositories open and close.
 *
 * The native menu itself (labels, ordering, the accelerators the OS draws,
 * greyed-out items) needs manual verification per platform.
 */

/** Choose a menu item, exactly as the Rust side reports it. */
async function chooseMenuItem(page: Page, id: string): Promise<void> {
  await emitBackendEvent(page, 'app-menu-action', id);
}

type MenuSyncItems = Array<{ id: string; enabled: boolean; accelerator: string | null }>;

async function lastMenuSync(page: Page): Promise<MenuSyncItems> {
  const calls = await findCommand(page, 'sync_app_menu');
  expect(calls.length, 'sync_app_menu should have been invoked').toBeGreaterThan(0);
  return (calls[calls.length - 1].args as { items: MenuSyncItems }).items;
}

test.describe('Application menu — with a repository open', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('Repository ▸ Clean opens the same dialog as the palette command', async ({ page }) => {
    await injectCommandMock(page, {
      get_cleanable_files: [
        { path: 'untracked-file.txt', isDirectory: false, isIgnored: false, size: 1024 },
      ],
    });

    await chooseMenuItem(page, 'clean');

    await expect(page.locator('lv-clean-dialog[open] .dialog')).toBeVisible();
    await expect(page.locator('lv-clean-dialog .title')).toContainText('Clean Working Directory');
  });

  test('Repository ▸ Remotes opens the remotes dialog', async ({ page }) => {
    // Fetch, Pull and Push are refused outright for a repository with no
    // remote, and the refusal says "add one first" — but the dialog that adds
    // one was reachable only from the command palette, so the remedy had no
    // route for anyone who did not already know it was there.
    await chooseMenuItem(page, 'remotes');

    await expect(page.locator('lv-remote-dialog')).toBeVisible();
  });

  test('View ▸ Command Palette opens the palette', async ({ page }) => {
    await chooseMenuItem(page, 'command-palette');

    await expect(page.locator('lv-command-palette[open]')).toBeVisible();
  });

  test('Help ▸ Keyboard Shortcuts opens the shortcuts dialog', async ({ page }) => {
    await chooseMenuItem(page, 'keyboard-shortcuts');

    await expect(page.locator('lv-keyboard-shortcuts-dialog[open]')).toBeVisible();
  });

  test('File ▸ Close Repository Tab closes the active tab', async ({ page }) => {
    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);

    await chooseMenuItem(page, 'close-repository-tab');

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(0);
    await expect(page.locator('lv-welcome')).toBeVisible();
  });

  test('an unroutable menu id is reported rather than ignored', async ({ page }) => {
    await chooseMenuItem(page, 'not-a-real-menu-item');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText('not available');
  });
});

test.describe('Application menu — with no repository open', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('lv-welcome')).toBeVisible();
  });

  test('a repository action explains why nothing happened', async ({ page }) => {
    await chooseMenuItem(page, 'clean');

    await expect(page.locator('lv-toast-container .toast.warning')).toContainText(
      'open a repository'
    );
    await expect(page.locator('lv-clean-dialog[open] .dialog')).toHaveCount(0);
  });

  test('actions that need no repository still work', async ({ page }) => {
    await chooseMenuItem(page, 'command-palette');

    await expect(page.locator('lv-command-palette[open]')).toBeVisible();
    await expect(page.locator('lv-toast-container .toast.warning')).toHaveCount(0);
  });

  test('File ▸ Clone Repository opens the clone dialog', async ({ page }) => {
    await chooseMenuItem(page, 'clone-repository');

    await expect(page.locator('lv-clone-dialog lv-modal[open]')).toBeVisible();
  });
});

test.describe('Application menu — enabled state follows the open repository', () => {
  test('every repository item is enabled once a repository opens', async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('lv-welcome')).toBeVisible();

    await startCommandCapture(page);
    await initializeRepositoryStore(page);
    await waitForCommand(page, 'sync_app_menu');

    const items = await lastMenuSync(page);
    expect(items.find((i) => i.id === 'fetch')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'remotes')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'repository-health')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'close-repository-tab')?.enabled).toBe(true);
  });

  test('repository items are disabled again when the last tab closes', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCapture(page);

    await chooseMenuItem(page, 'close-repository-tab');
    await expect(page.locator('lv-welcome')).toBeVisible();
    await waitForCommand(page, 'sync_app_menu');

    const items = await lastMenuSync(page);
    expect(items.find((i) => i.id === 'fetch')?.enabled).toBe(false);
    expect(items.find((i) => i.id === 'repository-health')?.enabled).toBe(false);
    // Items that work without a repository stay clickable.
    expect(items.find((i) => i.id === 'command-palette')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'open-repository')?.enabled).toBe(true);
  });

  test('menu items carry the keyboard shortcut they are bound to', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCapture(page);

    await chooseMenuItem(page, 'close-repository-tab');
    await waitForCommand(page, 'sync_app_menu');

    const items = await lastMenuSync(page);
    expect(items.find((i) => i.id === 'fetch')?.accelerator).toBe('CmdOrCtrl+Shift+F');
    expect(items.find((i) => i.id === 'toggle-left-panel')?.accelerator).toBe('CmdOrCtrl+B');
    // Nothing invented for an action with no binding.
    expect(items.find((i) => i.id === 'bisect')?.accelerator).toBe(null);
  });
});
