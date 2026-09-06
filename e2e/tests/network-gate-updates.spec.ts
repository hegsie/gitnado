import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * Offline Mode and the remote allowlist, applied to the auto-updater.
 *
 * `check_for_update` fetches `latest.json` from the release host and
 * `download_and_install_update` pulls a signed binary and runs it, so an
 * ungated "Check for Updates" contacted github.com while the app said it was
 * offline. Worse, the failure was invisible: the dialog folded a refusal and a
 * failed check into the same `null` and went back to showing nothing at all.
 *
 * The backend refuses too (`src-tauri/src/services/update_service.rs`), which
 * is what covers the unattended 24-hour loop; only this half can answer the
 * click.
 */

const updateMocks = {
  get_app_version: '0.8.0',
  check_for_update: {
    updateAvailable: true,
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    releaseNotes: 'Fixes',
  },
};

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

async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('lv-settings-dialog')).toBeVisible();
}

function checkButton(page: Page) {
  return page.locator('lv-settings-dialog .check-update-btn');
}

function updateError(page: Page) {
  return page.locator('lv-settings-dialog .update-error');
}

test.describe('Settings Dialog — the updater respects the network gate', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('Offline Mode refuses the update check and says why', async ({ page }) => {
    await startCommandCaptureWithMocks(page, updateMocks);
    await setSecurity(page, { offlineMode: true });
    await openSettings(page);

    await checkButton(page).click();

    await expect(updateError(page)).toBeVisible();
    await expect(updateError(page)).toContainText('offline mode');
    await expect(updateError(page)).toContainText('Settings > Security');

    // Refused before the request is ever made — the point of the gate.
    expect(await findCommand(page, 'check_for_update')).toHaveLength(0);
    // And the button comes back, rather than being stuck on "Checking...".
    await expect(checkButton(page)).toBeEnabled();
  });

  test('an allowlist without github.com refuses the update check', async ({ page }) => {
    await startCommandCaptureWithMocks(page, updateMocks);
    await setSecurity(page, { remoteAllowlist: ['gitlab.com'] });
    await openSettings(page);

    await checkButton(page).click();

    await expect(updateError(page)).toBeVisible();
    await expect(updateError(page)).toContainText('github.com');
    await expect(updateError(page)).toContainText('allowlist');

    expect(await findCommand(page, 'check_for_update')).toHaveLength(0);
  });

  test('an allowlist that names github.com lets the check through', async ({ page }) => {
    await startCommandCaptureWithMocks(page, updateMocks);
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSettings(page);

    await checkButton(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'check_for_update')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('lv-settings-dialog .update-status.available')).toContainText('0.9.0');
    await expect(updateError(page)).toHaveCount(0);
  });

  test('with no policy in force the check runs as before', async ({ page }) => {
    await startCommandCaptureWithMocks(page, updateMocks);
    await openSettings(page);

    await checkButton(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'check_for_update')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('lv-settings-dialog .update-status.available')).toContainText('0.9.0');
    await expect(updateError(page)).toHaveCount(0);
  });

  test('turning Offline Mode back off lets the very next check through', async ({ page }) => {
    // The gate is read per call, not captured once: the same guarantee that
    // lets the backend's 24-hour loop resume without a restart.
    await startCommandCaptureWithMocks(page, updateMocks);
    await setSecurity(page, { offlineMode: true });
    await openSettings(page);

    await checkButton(page).click();
    await expect(updateError(page)).toBeVisible();

    await setSecurity(page, { offlineMode: false });
    await checkButton(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'check_for_update')).length)
      .toBeGreaterThan(0);
    await expect(updateError(page)).toHaveCount(0);
  });

  test('a binary the manifest puts on an unlisted host is refused by the check itself', async ({
    page,
  }) => {
    // The manifest host is on the allowlist, so the frontend gate lets the
    // check through — but `latest.json` names the BINARY's host, and only the
    // backend can see that. Its refusal has to come back from the check: the
    // manual check used to announce the update and leave the install path to
    // refuse it silently, so Settings said "Update available" forever.
    await startCommandCaptureWithMocks(page, updateMocks);
    await injectCommandError(
      page,
      'check_for_update',
      'Remote "https://cdn.example.net/Leviathan.AppImage" is not in your allowlist',
      'BLOCKED',
    );
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSettings(page);

    await checkButton(page).click();

    await expect(updateError(page)).toBeVisible();
    await expect(updateError(page)).toContainText('cdn.example.net');
    await expect(page.locator('lv-settings-dialog .update-status.available')).toHaveCount(0);
    await expect(checkButton(page)).toBeEnabled();
  });

  test('a failed check reports the backend error instead of showing nothing', async ({ page }) => {
    await startCommandCaptureWithMocks(page, updateMocks);
    await injectCommandError(page, 'check_for_update', 'Update check failed: connection reset');
    await openSettings(page);

    await checkButton(page).click();

    await expect(updateError(page)).toBeVisible();
    await expect(updateError(page)).toContainText('connection reset');
  });
});
