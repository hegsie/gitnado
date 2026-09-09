import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { DialogsPage } from '../pages/dialogs.page';
import { startCommandCaptureWithMocks, findCommand } from '../fixtures/test-helpers';

/**
 * Offline mode, applied to "Sign in with GitHub".
 *
 * oauth.service had no frontend gate at all, and the backend's guards sit on
 * the token exchange — the LAST step. So with offline mode on the sign-in
 * started, the system browser opened, the user authorised the app against
 * their real GitHub account, the callback came back, and only then was the
 * exchange refused: account access granted to an app that then said it was
 * offline. Nothing may leave until the gate has answered.
 */

interface SettingsStoreWindow {
  __GITNADO_STORES__?: {
    settingsStore?: {
      getState: () => { setOfflineMode: (on: boolean) => void };
    };
  };
}

async function setOffline(page: Page, on: boolean): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__GITNADO_STORES__?.settingsStore !==
      'undefined',
  );
  await page.evaluate((enabled) => {
    (window as unknown as SettingsStoreWindow)
      .__GITNADO_STORES__!.settingsStore!.getState()
      .setOfflineMode(enabled);
  }, on);
}

async function openGitHubDialog(dialogs: DialogsPage): Promise<void> {
  await dialogs.commandPalette.open();
  await dialogs.commandPalette.search('GitHub Integration');
  await dialogs.commandPalette.executeFirst();
  await expect(dialogs.github.dialog).toBeVisible();
}

test.describe('offline mode refuses an OAuth sign-in before it starts', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      oauth_get_authorize_url: {
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=x',
        state: 'test-state',
      },
    });
  });

  test('the browser is never opened, and the dialog says why', async ({ page }) => {
    await setOffline(page, true);
    await openGitHubDialog(dialogs);

    await dialogs.github.oauthSignInButton.click();

    // The refusal names the setting and where to change it...
    const message = page.locator('.toast.error, lv-github-dialog .error-message').first();
    await expect(message).toContainText(/offline mode/i);
    await expect(message).toContainText(/Settings > Security/i);

    // ...and no flow was ever started, so nothing reached the browser.
    expect(await findCommand(page, 'oauth_get_authorize_url')).toHaveLength(0);
    expect(await findCommand(page, 'plugin:shell|open')).toHaveLength(0);
  });

  test('with offline mode off the same button starts the flow', async ({ page }) => {
    await setOffline(page, false);
    await openGitHubDialog(dialogs);

    await dialogs.github.oauthSignInButton.click();

    await expect
      .poll(async () => (await findCommand(page, 'oauth_get_authorize_url')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});
