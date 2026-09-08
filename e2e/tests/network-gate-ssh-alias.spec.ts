import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  findCommand,
  openViaCommandPalette,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * The remote allowlist, and the credentials dialog, applied to git's scp-like
 * remote with the LOGIN LEFT OFF.
 *
 * git's scp form is `[user@]host:path` — the login is optional — so
 * `gitserver:team/app.git` is an ssh remote on `gitserver`. It is the spelling
 * an `~/.ssh/config` `Host` alias leaves behind, which is how a corporate host
 * is usually reached. Both gates required the `@`, so the host read as nothing
 * at all:
 *
 * - every fetch, pull and push to that remote was refused with
 *   `Remote "gitserver:team/app.git" is not in your allowlist`, and no entry
 *   the user could write would ever have covered it;
 * - the credentials dialog fell to its malformed branch, substituted `https`,
 *   skipped the ssh probe and drew a red ✗ "No Credentials Found" over
 *   "Protocol: https" for a remote that works.
 */

const ALIAS_REMOTE = 'gitserver:team/app.git';

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

/** Set the security settings through the store, the way the app itself does. */
async function setAllowlist(page: Page, allowlist: string[]): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__GITNADO_STORES__?.settingsStore !==
      'undefined',
  );
  await page.evaluate((list) => {
    (window as unknown as SettingsStoreWindow)
      .__GITNADO_STORES__!.settingsStore!.getState()
      .setRemoteAllowlist(list);
  }, allowlist);
}

function fetchButton(page: Page) {
  return page.locator('lv-context-dashboard').getByRole('button', { name: /Fetch/i });
}

async function mockAliasOrigin(page: Page): Promise<void> {
  await startCommandCaptureWithMocks(page, {
    get_remotes: [{ name: 'origin', url: ALIAS_REMOTE, pushUrl: ALIAS_REMOTE }],
    get_fetch_remote: 'origin',
    fetch: null,
  });
}

test.describe('the allowlist covers an scp remote that names no login', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('a fetch to an allowlisted alias remote goes through', async ({ page }) => {
    await mockAliasOrigin(page);
    await setAllowlist(page, ['gitserver']);

    await fetchButton(page).click();

    await waitForCommand(page, 'fetch');
    expect((await findCommand(page, 'fetch')).length).toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('a fetch to an alias remote off the allowlist is still refused, and says so', async ({
    page,
  }) => {
    await mockAliasOrigin(page);
    await setAllowlist(page, ['elsewhere.test']);

    await fetchButton(page).click();

    // The refusal names the remote it refused, and the request is never made.
    await expect(page.locator('.toast.error').first()).toContainText('allowlist');
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
  });
});

test.describe('the credentials dialog tests an scp remote that names no login', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('testing an allowlisted alias remote reports it over ssh', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [{ name: 'origin', url: ALIAS_REMOTE, pushUrl: null }],
      // What the backend now sends for this remote: `parse_target` resolves it,
      // so `credential_target` reports the ssh probe's own answer instead of
      // asking `git credential fill` about an https host it invented from the
      // whole string.
      test_credentials: {
        success: true,
        host: 'gitserver',
        protocol: 'ssh',
        username: 'deploy',
        message: "Hi deploy! You've successfully authenticated",
      },
    });
    await setAllowlist(page, ['gitserver']);

    await openViaCommandPalette(page, 'Credential Management');
    await page
      .locator('lv-credentials-dialog lv-modal[open]')
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('lv-credentials-dialog .tab', { hasText: 'Test Credentials' }).click();
    await expect(page.locator('lv-credentials-dialog .remote-item')).toHaveCount(1);
    await page.locator('lv-credentials-dialog .form-actions .btn-primary').click();

    // The gate used to refuse the test outright — the button flipped back and
    // a toast named a remote the allowlist did name — so the panel below never
    // appeared at all.
    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Credentials Working');
    await expect(result).toContainText('Protocol: ssh');
    await expect(result).toContainText('Host: gitserver');
    // SSH authenticates with a key: there is no credential entry to reject.
    await expect(result.locator('button', { hasText: 'Erase Credentials' })).toHaveCount(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    expect((await findCommand(page, 'test_credentials'))[0]?.args).toEqual({
      path: '/tmp/test-repo',
      remoteUrl: ALIAS_REMOTE,
    });
  });
});
