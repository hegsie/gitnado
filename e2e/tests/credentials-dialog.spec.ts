import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  findCommand,
  injectCommandMock,
  openViaCommandPalette,
  startCommandCaptureWithMocks,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the Credential Management dialog (lv-credentials-dialog).
 *
 * A URL-scoped credential helper (`credential.<url>.helper`) can be written in
 * any git config file. Removing one has to target the file it actually lives
 * in — the backend refuses a `--local` unset without a repository path, and a
 * `--local` unset never touches the global file. These tests install a
 * stateful mock that only drops the helper when the removal is aimed
 * correctly, so a wrong-target call reproduces the "confirm and nothing
 * happens" loop instead of silently passing.
 */
async function mockCredentialHelpers(
  page: import('@playwright/test').Page,
  helper: { name: string; command: string; scope: string; configScope: string; urlPattern: string | null }
): Promise<void> {
  await page.evaluate((initialHelper) => {
    const win = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      __HELPERS__: unknown[];
    };
    const originalInvoke = win.__TAURI_INTERNALS__.invoke;
    win.__HELPERS__ = [initialHelper];

    win.__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
      switch (command) {
        case 'get_credential_helpers':
          return win.__HELPERS__;
        case 'get_available_helpers':
          return [];
        case 'detect_credential_manager':
          return null;
        case 'unset_credential_helper': {
          const params = args as { path?: string | null; global?: boolean; urlPattern?: string };
          // Faithful to the backend: `--local` without a repository path is
          // refused, and the wrong scope simply does not touch this file.
          const wantsGlobal = initialHelper.configScope === 'global';
          const aimedRight = wantsGlobal
            ? params.global === true
            : params.global !== true && typeof params.path === 'string' && params.path.length > 0;
          if (aimedRight) {
            win.__HELPERS__ = [];
          }
          return null;
        }
        // showConfirm() resolves true only for the OK button label.
        case 'plugin:dialog|message':
          return 'Ok';
        default:
          return originalInvoke(command, args);
      }
    };
  }, helper);
}

async function openCredentialsDialog(page: import('@playwright/test').Page): Promise<void> {
  await openViaCommandPalette(page, 'Credential Management');
  await page
    .locator('lv-credentials-dialog lv-modal[open]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Credentials Dialog - removing URL-scoped helpers', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('removing a URL-scoped helper actually removes it from the list', async ({ page }) => {
    await mockCredentialHelpers(page, {
      name: 'manager',
      command: 'manager',
      scope: 'url',
      configScope: 'global',
      urlPattern: 'https://github.com',
    });
    await openCredentialsDialog(page);

    const helperItem = page.locator('lv-credentials-dialog .helper-item');
    await expect(helperItem).toHaveCount(1);

    await page.locator('lv-credentials-dialog .helper-item .btn-icon.danger').click();

    // Assert the settled, reloaded list — `.helper-item` is briefly absent
    // while loadData() renders its loading state, so an empty list on its own
    // would pass even when the removal did nothing.
    await expect(page.locator('lv-credentials-dialog .empty-state')).toContainText(
      'No credential helpers configured'
    );
    await expect(helperItem).toHaveCount(0);
    await expect(page.locator('lv-credentials-dialog .error-banner')).not.toBeVisible();
  });

  test('a system-scoped helper is not offered as removable', async ({ page }) => {
    await mockCredentialHelpers(page, {
      name: 'manager',
      command: 'manager',
      scope: 'url',
      configScope: 'system',
      urlPattern: 'https://github.com',
    });
    await openCredentialsDialog(page);

    const removeButton = page.locator('lv-credentials-dialog .helper-item .btn-icon.danger');
    await expect(removeButton).toBeDisabled();
    await expect(removeButton).toHaveAttribute('title', /system git config/);
  });
});

/**
 * The "Test Credentials" tab reports the protocol git would actually use.
 *
 * An scp-form remote whose login is not `git` — `deploy@host:team/app.git`, an
 * ordinary corporate remote — is SSH, and was classified as HTTPS: a working
 * remote came back "No Credentials Found", and the erase button then offered
 * to drop `https` credentials that were never in play.
 */
test.describe('Credentials Dialog - testing a remote', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  async function openTestTab(page: import('@playwright/test').Page): Promise<void> {
    await openCredentialsDialog(page);
    await page.locator('lv-credentials-dialog .tab', { hasText: 'Test Credentials' }).click();
    await expect(page.locator('lv-credentials-dialog .remote-item')).toHaveCount(1);
    await page.locator('lv-credentials-dialog .form-actions .btn-primary').click();
    await expect(page.locator('lv-credentials-dialog .test-result')).toBeVisible();
  }

  test('an scp-form remote is reported over ssh and offers nothing to erase', async ({ page }) => {
    await injectCommandMock(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [
        { name: 'origin', url: 'deploy@git.example.test:team/app.git', pushUrl: null },
      ],
      test_credentials: {
        success: true,
        host: 'git.example.test',
        protocol: 'ssh',
        username: 'deploy',
        message: "Hi deploy! You've successfully authenticated",
      },
    });
    await openTestTab(page);

    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toContainText('Credentials Working');
    await expect(result).toContainText('Protocol: ssh');
    // SSH authenticates with a key; there is no credential entry to reject, so
    // the button would be a silent no-op.
    await expect(result.locator('button', { hasText: 'Erase Credentials' })).toHaveCount(0);
  });

  test('a failed ssh handshake is reported as an authentication failure', async ({ page }) => {
    await injectCommandMock(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [
        { name: 'origin', url: 'deploy@git.example.test:team/app.git', pushUrl: null },
      ],
      test_credentials: {
        success: false,
        host: 'git.example.test',
        protocol: 'ssh',
        username: null,
        message: 'Permission denied (publickey).',
      },
    });
    await openTestTab(page);

    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toContainText('SSH Authentication Failed');
    await expect(result).not.toContainText('No Credentials Found');
    await expect(result).toContainText('Permission denied (publickey).');
  });

  test('an https remote still offers to erase the credential it found', async ({ page }) => {
    await injectCommandMock(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [
        { name: 'origin', url: 'https://git.example.test/team/app.git', pushUrl: null },
      ],
      test_credentials: {
        success: true,
        host: 'git.example.test',
        protocol: 'https',
        username: 'someone',
        message: 'Credentials found for git.example.test',
      },
    });
    await openTestTab(page);

    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toContainText('Protocol: https');
    await expect(result.locator('button', { hasText: 'Erase Credentials' })).toBeVisible();
  });

  test('an http remote erases the http credential it found, not an https one', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [
        { name: 'origin', url: 'http://git.internal.test/team/app.git', pushUrl: null },
      ],
      test_credentials: {
        success: true,
        host: 'git.internal.test',
        protocol: 'http',
        username: 'someone',
        message: 'Credentials found for git.internal.test',
      },
      erase_credentials: null,
      'plugin:dialog|message': 'Ok',
    });
    await openTestTab(page);

    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toContainText('Protocol: http');
    await result.locator('button', { hasText: 'Erase Credentials' }).click();

    // `git credential reject protocol=https` matches nothing for an http
    // remote: the user confirms a re-authentication warning and the credential
    // stays exactly where it was.
    await expect
      .poll(async () => (await findCommand(page, 'erase_credentials'))[0]?.args)
      .toEqual({ path: '/tmp/test-repo', host: 'git.internal.test', protocol: 'http' });
  });

  test('a git:// remote is told it needs no credential and offered no erase', async ({ page }) => {
    await injectCommandMock(page, {
      get_credential_helpers: [],
      get_available_helpers: [],
      detect_credential_manager: null,
      get_remotes: [
        { name: 'origin', url: 'git://git.internal.test/team/app.git', pushUrl: null },
      ],
      test_credentials: {
        success: false,
        host: 'git.internal.test',
        protocol: 'git',
        username: null,
        message: 'No credentials found for git.internal.test',
      },
    });
    await openTestTab(page);

    // `git://` does not authenticate at all, so "No Credentials Found" reads as
    // a fault to go and fix when there is nothing to fix — and an erase button
    // there rejects an entry git would never have consulted.
    const result = page.locator('lv-credentials-dialog .test-result');
    await expect(result).toContainText('No Credentials Needed');
    await expect(result).not.toContainText('No Credentials Found');
    await expect(result.locator('button', { hasText: 'Erase Credentials' })).toHaveCount(0);
  });
});
