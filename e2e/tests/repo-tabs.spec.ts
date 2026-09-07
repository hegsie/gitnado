import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the multi-repository tab bar:
 * tooltips, duplicate-name disambiguation, active-tab indication, the
 * all-repositories dropdown, middle-click close, the tab context menu, and
 * keyboard tab switching.
 *
 * setupOpenRepository() opens the default repo (/tmp/test-repo); extra repos
 * are added through the repository store like the welcome/restore flows do.
 */

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

async function activeTabName(page: Page): Promise<string | null> {
  return page.locator('lv-toolbar .tab.active .tab-name').textContent();
}

test.describe('Repository Tabs - multiple repos', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await addRepo(page, '/work/client-a/api', 'api');
    await addRepo(page, '/work/client-b/api', 'api');
  });

  test('renders one tab per open repo with full-path tooltips', async ({ page }) => {
    const tabs = page.locator('lv-toolbar .tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(1)).toHaveAttribute('title', '/work/client-a/api');
    await expect(tabs.nth(2)).toHaveAttribute('title', '/work/client-b/api');
  });

  test('disambiguates duplicate repo names with the parent directory', async ({ page }) => {
    const hints = page.locator('lv-toolbar .tab .tab-hint');
    await expect(hints).toHaveCount(2);
    await expect(hints.nth(0)).toHaveText('client-a');
    await expect(hints.nth(1)).toHaveText('client-b');
  });

  test('clicking a tab activates it and updates the visual indicator', async ({ page }) => {
    // Last added repo is active
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/client-b/api'
    );

    await page.locator('lv-toolbar .tab').first().click();

    await expect(page.locator('lv-toolbar .tab.active')).toHaveCount(1);
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');
    await expect(page.locator('lv-toolbar .tab').first()).toHaveAttribute('aria-selected', 'true');
  });

  test('the all-repositories dropdown lists every repo and switches tabs', async ({ page }) => {
    await page.locator('lv-toolbar .tab-list-btn').click();

    const items = page.locator('lv-toolbar .tab-list-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator('.item-path')).toContainText('/tmp/test-repo');

    await items.nth(0).click();

    // Menu closes and the first repo becomes active
    await expect(page.locator('lv-toolbar .tab-list-menu')).toHaveCount(0);
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');
  });

  test('middle-click closes a tab', async ({ page }) => {
    await page.locator('lv-toolbar .tab').nth(1).click({ button: 'middle' });

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(2);
    await expect(page.locator('lv-toolbar .tab[title="/work/client-a/api"]')).toHaveCount(0);
  });

  test('context menu Close Others keeps only the clicked tab', async ({ page }) => {
    await page.locator('lv-toolbar .tab').nth(1).click({ button: 'right' });

    const closeOthers = page.locator('lv-toolbar .context-menu-item', { hasText: 'Close Others' });
    await expect(closeOthers).toBeVisible();
    await closeOthers.click();

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);
    await expect(page.locator('lv-toolbar .tab')).toHaveAttribute('title', '/work/client-a/api');
  });

  test('context menu Close Tabs to the Right', async ({ page }) => {
    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });

    await page
      .locator('lv-toolbar .context-menu-item', { hasText: 'Close Tabs to the Right' })
      .click();

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);
    await expect(page.locator('lv-toolbar .tab')).toHaveAttribute('title', '/tmp/test-repo');
  });

  test('context menu Close All empties the tab strip', async ({ page }) => {
    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });

    await page.locator('lv-toolbar .context-menu-item', { hasText: 'Close All' }).click();

    await expect(page.locator('lv-toolbar .tab')).toHaveCount(0);
    await expect(page.locator('lv-toolbar .no-repos')).toBeVisible();
  });

  test('Ctrl+Tab cycles to the next tab and wraps', async ({ page }) => {
    // Active: client-b (index 2). Ctrl+Tab wraps to index 0.
    await page.keyboard.press('Control+Tab');
    expect(await activeTabName(page)).toBe('test-repo');

    await page.keyboard.press('Control+Tab');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/client-a/api'
    );

    await page.keyboard.press('Control+Shift+Tab');
    expect(await activeTabName(page)).toBe('test-repo');
  });

  test('Ctrl+digit jumps directly to that tab', async ({ page }) => {
    await page.keyboard.press('Control+1');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');

    await page.keyboard.press('Control+3');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/client-b/api'
    );
  });
});

test.describe('Repository Tabs - single repo', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('shows no disambiguation hint for a unique name', async ({ page }) => {
    await expect(page.locator('lv-toolbar .tab')).toHaveCount(1);
    await expect(page.locator('lv-toolbar .tab .tab-hint')).toHaveCount(0);
  });

  test('Ctrl+Tab with a single repo keeps it active', async ({ page }) => {
    await page.keyboard.press('Control+Tab');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveCount(1);
  });

  test('context menu disables Close Others and Close Tabs to the Right', async ({ page }) => {
    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });

    await expect(
      page.locator('lv-toolbar .context-menu-item', { hasText: 'Close Others' })
    ).toBeDisabled();
    await expect(
      page.locator('lv-toolbar .context-menu-item', { hasText: 'Close Tabs to the Right' })
    ).toBeDisabled();
  });
});

test.describe('Repository Tabs - open this repository elsewhere', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await addRepo(page, '/work/client-a/api', 'api');
    await addRepo(page, '/work/client-b/api', 'api');
    // The editor command resolves with an OpenResult payload; the unmocked
    // default (null) would legitimately be treated as a failure.
    await startCommandCaptureWithMocks(page, {
      open_terminal: null,
      open_file_manager: null,
      open_in_configured_editor: { success: true, message: 'Opened in code' },
    });
  });

  test('Open in Terminal acts on the clicked tab, not the active one', async ({ page }) => {
    // client-b (the last added) is active; the menu is opened on client-a.
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/client-b/api'
    );

    await page.locator('lv-toolbar .tab').nth(1).click({ button: 'right' });
    await page.locator('lv-toolbar .context-menu-item', { hasText: 'Open in Terminal' }).click();

    await waitForCommand(page, 'open_terminal');
    const calls = await findCommand(page, 'open_terminal');
    expect(calls[0].args).toMatchObject({ path: '/work/client-a/api' });

    // The menu closes and nothing is reported on success.
    await expect(page.locator('lv-toolbar .tab-context-menu')).toHaveCount(0);
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Reveal in File Manager opens the clicked tab directory', async ({ page }) => {
    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });
    await page
      .locator('lv-toolbar .context-menu-item', { hasText: 'Reveal in File Manager' })
      .click();

    await waitForCommand(page, 'open_file_manager');
    const calls = await findCommand(page, 'open_file_manager');
    expect(calls[0].args).toMatchObject({ path: '/tmp/test-repo' });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Open in Editor targets the repository root of the clicked tab', async ({ page }) => {
    await page.locator('lv-toolbar .tab').nth(2).click({ button: 'right' });
    await page.locator('lv-toolbar .context-menu-item', { hasText: 'Open in Editor' }).click();

    await waitForCommand(page, 'open_in_configured_editor');
    const calls = await findCommand(page, 'open_in_configured_editor');
    expect(calls[0].args).toMatchObject({
      path: '/work/client-b/api',
      filePath: '/work/client-b/api',
    });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('a terminal that cannot be launched is reported to the user', async ({ page }) => {
    await injectCommandError(
      page,
      'open_terminal',
      'Operation failed: No terminal emulator found',
      'OPERATION_FAILED'
    );

    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });
    await page.locator('lv-toolbar .context-menu-item', { hasText: 'Open in Terminal' }).click();

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'No terminal emulator found'
    );
  });

  test('an editor that reports failure is not silently swallowed', async ({ page }) => {
    await injectCommandMock(page, {
      open_in_configured_editor: { success: false, message: 'No editor configured' },
    });

    await page.locator('lv-toolbar .tab').first().click({ button: 'right' });
    await page.locator('lv-toolbar .context-menu-item', { hasText: 'Open in Editor' }).click();

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'No editor configured'
    );
  });
});
