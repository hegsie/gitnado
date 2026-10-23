import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import {
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the OIDC / Enterprise SSO Dialog.
 *
 * Covers: opening the dialog (via the command palette / app-shell event),
 * provider discovery (mock discover_oidc_provider), starting OAuth (mock
 * oauth_get_authorize_url for provider 'oidc'), simulating oauth-complete, and
 * asserting the account is created (save_global_account captured with oidc
 * config) with the connected UI shown — plus a discovery error path.
 */

const ISSUER = 'https://auth.example.com';

const dialog = (page: import('@playwright/test').Page) => page.locator('gn-oidc-dialog gn-modal[open]');

async function openOidcDialog(app: AppPage): Promise<void> {
  await app.executeCommand('Enterprise SSO');
}

test.describe('OIDC Dialog - Display', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('opens via the command palette and shows issuer + client id inputs', async ({ page }) => {
    await openOidcDialog(app);

    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('gn-oidc-dialog input[type="url"]')).toBeVisible();
    await expect(page.locator('gn-oidc-dialog .sign-in-btn')).toBeVisible();
    await expect(page.locator('gn-oidc-dialog .discover-btn')).toBeVisible();
  });
});

test.describe('OIDC Dialog - Discovery', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('discovers the provider and shows discovered endpoints', async ({ page }) => {
    await injectCommandMock(page, {
      discover_oidc_provider: {
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksUri: `${ISSUER}/jwks`,
        issuer: ISSUER,
        scopesSupported: ['openid', 'profile', 'email'],
      },
    });

    await openOidcDialog(app);
    await expect(dialog(page)).toBeVisible();

    await page.locator('gn-oidc-dialog input[type="url"]').fill(ISSUER);
    await page.locator('gn-oidc-dialog .discover-btn').click();

    const discovery = page.locator('gn-oidc-dialog .discovery');
    await expect(discovery).toBeVisible();
    await expect(discovery).toContainText(`${ISSUER}/authorize`);
    await expect(discovery).toContainText(`${ISSUER}/token`);
  });

  test('shows an error when discovery fails (SSRF/validation)', async ({ page }) => {
    await injectCommandError(
      page,
      'discover_oidc_provider',
      'Issuer URL host is not allowed (loopback)'
    );

    await openOidcDialog(app);
    await expect(dialog(page)).toBeVisible();

    await page.locator('gn-oidc-dialog input[type="url"]').fill('https://localhost');
    await page.locator('gn-oidc-dialog .discover-btn').click();

    const errorEl = page.locator('gn-oidc-dialog .error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toContainText('loopback');
    // Dialog stays open and no discovery panel is shown.
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('gn-oidc-dialog .discovery')).toHaveCount(0);
  });
});

test.describe('OIDC Dialog - Sign in + account creation', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('starts OAuth with provider oidc and creates an account on oauth-complete', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      // No loopback polling: the dialog opens the browser URL; the test then
      // simulates the callback by dispatching the oauth-complete window event.
      oauth_get_authorize_url: {
        authorizeUrl: `${ISSUER}/authorize?client_id=acme-client`,
        state: 'oidc-state-1',
        loopbackPort: null,
      },
      // Avoid actually opening a browser window in the loopback `open()` path.
      'plugin:shell|open': null,
      save_global_account: {
        id: 'oidc-new',
        name: 'Acme SSO',
        integrationType: 'oidc',
        config: { type: 'oidc', issuerUrl: ISSUER, clientId: 'acme-client' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: true,
      },
      decode_oidc_id_token: {
        sub: 'user-123',
        email: 'sso@example.com',
        name: 'SSO User',
        preferredUsername: 'ssouser',
        picture: null,
      },
    });

    await openOidcDialog(app);
    await expect(dialog(page)).toBeVisible();

    await page.locator('gn-oidc-dialog input[type="text"]').first().fill('Acme SSO');
    await page.locator('gn-oidc-dialog input[type="url"]').fill(ISSUER);
    // Client ID is the only plain text input after the name field.
    await page.locator('gn-oidc-dialog input[type="text"]').nth(1).fill('acme-client');

    await page.locator('gn-oidc-dialog .sign-in-btn').click();

    // Verify startOAuth -> oauth_get_authorize_url was called with provider oidc.
    await waitForCommand(page, 'oauth_get_authorize_url');
    const authCalls = await findCommand(page, 'oauth_get_authorize_url');
    expect(authCalls.length).toBeGreaterThan(0);
    const authArgs = authCalls[0].args as Record<string, string>;
    expect(authArgs.provider).toBe('oidc');
    expect(authArgs.clientId).toBe('acme-client');
    expect(authArgs.instanceUrl).toBe(ISSUER);

    // Simulate the OAuth callback completing.
    await page.evaluate((issuer) => {
      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'oidc',
            tokens: { accessToken: 'oidc-access', idToken: 'header.payload.sig' },
            instanceUrl: issuer,
          },
        })
      );
    }, ISSUER);

    // The account is persisted with the oidc config.
    await waitForCommand(page, 'save_global_account');
    const saveCalls = await findCommand(page, 'save_global_account');
    expect(saveCalls.length).toBeGreaterThan(0);
    const account = (saveCalls[saveCalls.length - 1].args as Record<string, unknown>).account as {
      integrationType: string;
      config: { type: string; issuerUrl: string; clientId: string };
    };
    expect(account.integrationType).toBe('oidc');
    expect(account.config).toMatchObject({ type: 'oidc', issuerUrl: ISSUER, clientId: 'acme-client' });

    // Connected UI shows the decoded identity.
    const status = page.locator('gn-oidc-dialog .connection-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('SSO User');
  });
});
