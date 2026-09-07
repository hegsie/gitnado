import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * The network gate on LFS transfers judges the LFS ENDPOINT, not the git
 * remote.
 *
 * git-lfs resolves where it transfers from `lfs.url` / `remote.<r>.lfsurl` —
 * both of which a `.lfsconfig` COMMITTED to the repository may set — before it
 * falls back to the remote. So a repository cloned from github.com can carry
 * an `.lfsconfig` that sends every LFS pull to a host of the author's
 * choosing, and an allowlist that only ever looked at the remote waved it
 * through. The backend resolves the endpoint the way git-lfs does
 * (`get_lfs_endpoint`); the dialog's Pull must refuse on it, and say so.
 */

type SettingsStoreWindow = {
  __LEVIATHAN_STORES__?: {
    settingsStore?: {
      getState: () => { setRemoteAllowlist: (domains: string[]) => void };
    };
  };
};

/** Set the allowlist through the store, the way the Settings dialog does. */
async function setAllowlist(page: Page, domains: string[]): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__LEVIATHAN_STORES__?.settingsStore !==
      'undefined'
  );
  await page.evaluate((list) => {
    (window as unknown as SettingsStoreWindow)
      .__LEVIATHAN_STORES__!.settingsStore!.getState()
      .setRemoteAllowlist(list);
  }, domains);
}

const HOSTILE_ENDPOINT = 'https://evil.example.net/o/r.git/info/lfs';

/** An LFS-enabled repository whose git remote is on github.com. */
function lfsRepositoryMocks(endpoint: string | null) {
  return {
    get_lfs_status: {
      installed: true,
      version: 'git-lfs/3.4.0',
      enabled: true,
      patterns: [{ pattern: '*.psd' }],
      fileCount: 1,
      totalSize: 1024,
    },
    get_lfs_files: [{ path: 'art/logo.psd', oid: 'abc', size: 1024, downloaded: false }],
    get_remotes: [{ name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null }],
    get_fetch_remote: 'origin',
    get_lfs_endpoint: endpoint,
    lfs_pull: 'Downloading LFS objects: 1 of 1',
  };
}

async function openLfsDialog(page: Page): Promise<void> {
  await openViaCommandPalette(page, 'Manage Git LFS');
  await expect(page.locator('lv-lfs-dialog .dialog')).toBeVisible();
}

test.describe('LFS transfers are gated on the LFS endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('Pull is refused, naming the committed endpoint, when it is off the allowlist', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(page, lfsRepositoryMocks(HOSTILE_ENDPOINT));
    await setAllowlist(page, ['github.com']);
    await openLfsDialog(page);

    await page.locator('lv-lfs-dialog').getByRole('button', { name: /Pull Files/i }).click();

    // The gate refuses before anything reaches git-lfs, and says why — naming
    // the host the transfer would really have gone to, not the git remote.
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('not in your allowlist');
    await expect(toast).toContainText('evil.example.net');
    expect(await findCommand(page, 'lfs_pull')).toHaveLength(0);
  });

  test('Pull goes through when the endpoint is on the allowlist', async ({ page }) => {
    await startCommandCaptureWithMocks(page, lfsRepositoryMocks('https://github.com/o/r.git'));
    await setAllowlist(page, ['github.com']);
    await openLfsDialog(page);

    await page.locator('lv-lfs-dialog').getByRole('button', { name: /Pull Files/i }).click();

    await waitForCommand(page, 'lfs_pull');
    await expect(page.locator('lv-lfs-dialog .message.success')).toContainText(
      'LFS files pulled successfully'
    );
  });

  test('with no endpoint of its own the git remote is judged, as before', async ({ page }) => {
    await startCommandCaptureWithMocks(page, lfsRepositoryMocks(null));
    await setAllowlist(page, ['gitlab.com']);
    await openLfsDialog(page);

    await page.locator('lv-lfs-dialog').getByRole('button', { name: /Pull Files/i }).click();

    const toast = page.locator('.toast');
    await expect(toast).toContainText('not in your allowlist');
    await expect(toast).toContainText('github.com');
    expect(await findCommand(page, 'lfs_pull')).toHaveLength(0);
  });
});
