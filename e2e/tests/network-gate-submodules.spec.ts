import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * The remote allowlist, applied to the hosts `git submodule update` really
 * contacts.
 *
 * The gate used to check the SUPERPROJECT's remote and stop there, but
 * `.gitmodules` is repository content: a superproject on an allowlisted host
 * can name submodules anywhere, and `git submodule update` clones or fetches
 * every one of them. So an allowlist of `github.com` passed, and the app went
 * to gitlab.com.
 *
 * The backend enforces the same rule (`src-tauri/src/commands/submodule.rs`);
 * only this half can answer the click with a toast that names the host.
 */

const SUPERPROJECT_ON_GITHUB = [
  { name: 'origin', url: 'https://github.com/test/repo.git', pushUrl: null },
];

interface SettingsStoreWindow {
  __LEVIATHAN_STORES__?: {
    settingsStore?: {
      getState: () => {
        setOfflineMode: (on: boolean) => void;
        setRemoteAllowlist: (list: string[]) => void;
      };
    };
  };
}

/** Set the security settings through the store, the way the app itself does. */
async function setSecurity(
  page: Page,
  security: { offlineMode?: boolean; remoteAllowlist?: string[] },
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__LEVIATHAN_STORES__?.settingsStore !==
      'undefined',
  );
  await page.evaluate((s) => {
    const store = (
      window as unknown as SettingsStoreWindow
    ).__LEVIATHAN_STORES__!.settingsStore!.getState();
    if (s.offlineMode !== undefined) store.setOfflineMode(s.offlineMode);
    if (s.remoteAllowlist !== undefined) store.setRemoteAllowlist(s.remoteAllowlist);
  }, security);
}

interface MockSubmodule {
  name: string;
  path: string;
  url: string | null;
}

function submoduleRows(submodules: MockSubmodule[]) {
  return submodules.map((s) => ({
    ...s,
    headOid: 'abc123',
    branch: 'main',
    initialized: true,
    status: 'current',
  }));
}

async function openSubmoduleDialog(page: Page): Promise<void> {
  await openViaCommandPalette(page, 'submodule');
  await page
    .locator('lv-submodule-dialog .dialog-overlay')
    .waitFor({ state: 'visible', timeout: 3000 });
}

function dialog(page: Page) {
  return page.locator('lv-submodule-dialog .dialog');
}

function updateAllButton(page: Page) {
  return dialog(page).locator('.bulk-actions button', { hasText: /Update All/i });
}

test.describe('Submodule Dialog — the allowlist covers the submodule hosts', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('Update All is refused when a submodule points off the allowlist', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_remotes: SUPERPROJECT_ON_GITHUB,
      get_submodules: submoduleRows([
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git' },
        { name: 'vendor/plugin', path: 'vendor/plugin', url: 'https://gitlab.com/vendor/plugin.git' },
      ]),
      update_submodules: null,
    });
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSubmoduleDialog(page);

    await updateAllButton(page).click();

    // The refusal names the host that was refused, not just "blocked".
    await expect(page.locator('.toast.error').first()).toContainText('gitlab.com');
    // Refused before the request is ever made — the point of the gate.
    expect(await findCommand(page, 'update_submodules')).toHaveLength(0);
    // And nothing claims success behind the error.
    await expect(dialog(page).locator('.message.success')).toHaveCount(0);
  });

  test('Update All goes through when every submodule is on the allowlist', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_remotes: SUPERPROJECT_ON_GITHUB,
      get_submodules: submoduleRows([
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git' },
        { name: 'vendor/plugin', path: 'vendor/plugin', url: 'https://github.com/vendor/plugin.git' },
      ]),
      update_submodules: null,
    });
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSubmoduleDialog(page);

    await updateAllButton(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'update_submodules')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('a relative submodule url is not refused for having no host of its own', async ({
    page,
  }) => {
    // `../plugin.git` resolves against the superproject's remote, which is on
    // the allowlist. Refusing it would break an ordinary relative layout.
    await startCommandCaptureWithMocks(page, {
      get_remotes: SUPERPROJECT_ON_GITHUB,
      get_submodules: submoduleRows([
        { name: 'vendor/plugin', path: 'vendor/plugin', url: '../plugin.git' },
      ]),
      update_submodules: null,
    });
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSubmoduleDialog(page);

    await dialog(page).locator('.submodule-actions button[title="Update"]').first().click();

    await expect
      .poll(async () => (await findCommand(page, 'update_submodules')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('updating one submodule is not refused because a different one is off the list', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(page, {
      get_remotes: SUPERPROJECT_ON_GITHUB,
      get_submodules: submoduleRows([
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git' },
        { name: 'vendor/plugin', path: 'vendor/plugin', url: 'https://gitlab.com/vendor/plugin.git' },
      ]),
      update_submodules: null,
    });
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSubmoduleDialog(page);

    // The FIRST row is the allowlisted one; that update was never going to
    // contact gitlab.com.
    await dialog(page).locator('.submodule-actions button[title="Update"]').first().click();

    await expect
      .poll(async () => (await findCommand(page, 'update_submodules')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);

    // The one that IS off the list still is refused.
    await dialog(page).locator('.submodule-actions button[title="Update"]').nth(1).click();
    await expect(page.locator('.toast.error').first()).toContainText('gitlab.com');
    expect(await findCommand(page, 'update_submodules')).toHaveLength(1);
  });

  test('with no policy in force the update runs as before', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_remotes: SUPERPROJECT_ON_GITHUB,
      get_submodules: submoduleRows([
        { name: 'vendor/plugin', path: 'vendor/plugin', url: 'https://gitlab.com/vendor/plugin.git' },
      ]),
      update_submodules: null,
    });
    await openSubmoduleDialog(page);

    await dialog(page).locator('.submodule-actions button[title="Update"]').first().click();

    await expect
      .poll(async () => (await findCommand(page, 'update_submodules')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});
