import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * The remote allowlist, applied to a remote reached by IPv6 literal.
 *
 * A self-hosted box with no DNS is reached by address, and git accepts the
 * bracketed scp form `git@[2001:db8::1]:team/app.git`. The frontend gate read
 * that host with `[^:/]+`, which stops at the first colon INSIDE the literal,
 * so it judged `[2001` — not a host any allowlist entry can name. The backend
 * gate read the whole `[2001:db8::1]` and allowed the operation, so fetch,
 * pull and push were refused HERE, first, with a message naming a remote the
 * allowlist did name, and no entry could ever make it pass.
 */

const IPV6_REMOTE = 'git@[2001:db8::1]:team/app.git';

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

async function mockIpv6Origin(page: Page): Promise<void> {
  await startCommandCaptureWithMocks(page, {
    get_remotes: [{ name: 'origin', url: IPV6_REMOTE, pushUrl: IPV6_REMOTE }],
    get_fetch_remote: 'origin',
    fetch: null,
  });
}

test.describe('the allowlist covers a remote reached by IPv6 literal', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('a fetch to an allowlisted IPv6 remote goes through', async ({ page }) => {
    await mockIpv6Origin(page);
    await setAllowlist(page, ['[2001:db8::1]']);

    await fetchButton(page).click();

    await waitForCommand(page, 'fetch');
    expect((await findCommand(page, 'fetch')).length).toBeGreaterThan(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('a fetch to an IPv6 remote off the allowlist is still refused, and says so', async ({
    page,
  }) => {
    await mockIpv6Origin(page);
    await setAllowlist(page, ['[2001:db8::2]']);

    await fetchButton(page).click();

    // The refusal names the remote it refused, and the request is never made.
    await expect(page.locator('.toast.error').first()).toContainText('allowlist');
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
  });
});
