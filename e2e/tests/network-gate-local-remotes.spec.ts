import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * Offline mode and the allowlist, applied to a remote that is a place on THIS
 * machine.
 *
 * A `backup = /mnt/usb/repo.git` remote (or a `file:///srv/git/app.git` one)
 * opens no socket at all, so neither setting has anything to say about it —
 * which is exactly what the Offline Mode description promises: "Block every
 * operation that leaves this machine". Both refused it anyway: offline mode
 * answered before it looked at the target, and the allowlist read
 * `/mnt/usb/repo.git` as the host `mnt`, so the only entry that could permit a
 * push to a USB disk was the literal string `mnt`.
 */

const LOCAL_REMOTE = '/mnt/usb/repo.git';

interface SettingsStoreWindow {
  __GITNADO_STORES__?: {
    settingsStore?: {
      getState: () => {
        setOfflineMode: (on: boolean) => void;
        setRemoteAllowlist: (list: string[]) => void;
      };
    };
  };
}

async function settingsState(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__GITNADO_STORES__?.settingsStore !==
      'undefined',
  );
}

/** Turn offline mode on through the store, the way Settings itself does. */
async function setOffline(page: Page, on: boolean): Promise<void> {
  await settingsState(page);
  await page.evaluate((enabled) => {
    (window as unknown as SettingsStoreWindow)
      .__GITNADO_STORES__!.settingsStore!.getState()
      .setOfflineMode(enabled);
  }, on);
}

async function setAllowlist(page: Page, allowlist: string[]): Promise<void> {
  await settingsState(page);
  await page.evaluate((list) => {
    (window as unknown as SettingsStoreWindow)
      .__GITNADO_STORES__!.settingsStore!.getState()
      .setRemoteAllowlist(list);
  }, allowlist);
}

function fetchButton(page: Page) {
  return page.locator('lv-context-dashboard').getByRole('button', { name: /Fetch/i });
}

async function mockLocalOrigin(page: Page, url = LOCAL_REMOTE): Promise<void> {
  await startCommandCaptureWithMocks(page, {
    get_remotes: [{ name: 'origin', url, pushUrl: url }],
    get_fetch_remote: 'origin',
    get_push_remote: 'origin',
    fetch: null,
    push: null,
  });
}

test.describe('a remote on this machine is not a network operation', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('offline mode does not refuse a fetch from a filesystem remote', async ({ page }) => {
    await mockLocalOrigin(page);
    await setOffline(page, true);

    await fetchButton(page).click();

    await waitForCommand(page, 'fetch');
    expect((await findCommand(page, 'fetch')).length).toBeGreaterThan(0);
    await expect(page.locator('.toast.error, .toast.warning')).toHaveCount(0);
  });

  test('offline mode does not refuse a fetch from a file:// remote', async ({ page }) => {
    await mockLocalOrigin(page, 'file:///srv/git/app.git');
    await setOffline(page, true);

    await fetchButton(page).click();

    await waitForCommand(page, 'fetch');
    expect((await findCommand(page, 'fetch')).length).toBeGreaterThan(0);
    await expect(page.locator('.toast.error, .toast.warning')).toHaveCount(0);
  });

  test('an allowlist does not refuse a filesystem remote it cannot name', async ({ page }) => {
    await mockLocalOrigin(page);
    await setAllowlist(page, ['github.com']);

    await fetchButton(page).click();

    await waitForCommand(page, 'fetch');
    expect((await findCommand(page, 'fetch')).length).toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('a remote that only looks local is still refused, and says so', async ({ page }) => {
    // A UNC path is SMB: it does leave the machine, so offline mode keeps
    // refusing it.
    await mockLocalOrigin(page, '//fileserver/share/repo.git');
    await setOffline(page, true);

    await fetchButton(page).click();

    await expect(page.locator('.toast.warning, .toast.error').first()).toContainText(
      'Offline mode',
    );
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
  });
});
