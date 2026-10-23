/**
 * OIDC / Enterprise SSO Dialog Integration Tests
 *
 * Tests the gn-oidc-dialog Lit component: discovery (success/failure incl.
 * SSRF/validation error strings), starting OAuth with ('oidc', clientId,
 * issuerUrl), oauth-complete account creation (save_global_account with oidc
 * config) + token storage, and error surfacing — with a mocked Tauri backend.
 */

// Mock Tauri API before importing any modules that use it
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args: unknown }> = [];
const keyringStore = new Map<string, string>();

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } })
  .__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import * as oauthService from '../../../services/oauth.service.ts';
import { createEmptyIntegrationAccount, createEmptyUnifiedProfile } from '../../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';
import '../gn-oidc-dialog.ts';
import type { GnOidcDialog } from '../gn-oidc-dialog.ts';

const ISSUER = 'https://auth.example.com';

const mockDiscovery = {
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  jwksUri: 'https://auth.example.com/jwks',
  issuer: ISSUER,
  scopesSupported: ['openid', 'profile', 'email'],
};

const mockUserInfo = {
  sub: 'user-123',
  email: 'sso@example.com',
  name: 'SSO User',
  preferredUsername: 'ssouser',
  picture: null,
};

function createTestAccount(
  overrides: Partial<IntegrationAccount> & { id: string }
): IntegrationAccount {
  const base = createEmptyIntegrationAccount(overrides.integrationType ?? 'oidc');
  return {
    ...base,
    name: 'Test SSO',
    isDefault: true,
    cachedUser: null,
    ...overrides,
  } as IntegrationAccount;
}

const mockAccount = createTestAccount({
  id: 'oidc-acc-1',
  name: 'Acme SSO',
  integrationType: 'oidc',
  config: { type: 'oidc', issuerUrl: ISSUER, clientId: 'acme-client' },
  isDefault: true,
});

async function waitForLoad(el: GnOidcDialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
}

function setupMockInvoke(): void {
  keyringStore.clear();

  mockInvoke = async (command: string, args?: unknown) => {
    const params = args as Record<string, unknown> | undefined;

    if (command === 'get_keyring_token') {
      const key = (params as Record<string, string>)?.key;
      return keyringStore.get(key) ?? null;
    }
    if (command === 'store_keyring_token') {
      const { key, value } = params as Record<string, string>;
      keyringStore.set(key, value);
      return null;
    }
    if (command === 'delete_keyring_token') {
      const key = (params as Record<string, string>)?.key;
      keyringStore.delete(key);
      return null;
    }

    if (command === 'get_unified_profiles_config') {
      return {
        version: 3,
        profiles: [],
        accounts: unifiedProfileStore.getState().accounts,
        repositoryAssignments: {},
      };
    }
    if (command === 'load_unified_profile_for_repository') return null;
    if (command === 'save_global_account') return params;
    if (command === 'update_global_account_cached_user') return null;

    if (command === 'discover_oidc_provider') return mockDiscovery;
    if (command === 'decode_oidc_id_token') return mockUserInfo;
    if (command === 'oauth_get_authorize_url') {
      return { authorizeUrl: 'https://auth.example.com/authorize?x', state: 'st-1', loopbackPort: null };
    }

    return null;
  };
}

describe('gn-oidc-dialog', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    unifiedProfileStore.getState().reset();
    uiStore.getState().toasts.length = 0;
    setupMockInvoke();
  });

  describe('Rendering', () => {
    it('renders gn-modal with the OIDC form when open', async () => {
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      expect(el.shadowRoot!.querySelector('gn-modal')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.token-form')).to.not.be.null;
      // Three text inputs: name, issuer, client id.
      const inputs = el.shadowRoot!.querySelectorAll('input');
      expect(inputs.length).to.equal(3);
    });
  });

  describe('Discovery', () => {
    it('shows discovered endpoints on success', async () => {
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = ISSUER;
      await (el as unknown as { handleDiscover: () => Promise<void> }).handleDiscover();
      await el.updateComplete;

      const discovery = el.shadowRoot!.querySelector('.discovery');
      expect(discovery).to.not.be.null;
      expect(discovery!.textContent).to.include('https://auth.example.com/authorize');
      expect(discovery!.textContent).to.include('https://auth.example.com/token');

      const discoverCall = invokeHistory.find((h) => h.command === 'discover_oidc_provider');
      expect(discoverCall).to.not.be.undefined;
      expect((discoverCall!.args as Record<string, string>).issuerUrl).to.equal(ISSUER);
    });

    it('surfaces a discovery/SSRF validation error inline', async () => {
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'discover_oidc_provider') {
          throw new Error('Issuer URL host is not allowed (loopback)');
        }
        return origMock(command, args);
      };

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = 'https://localhost';
      await (el as unknown as { handleDiscover: () => Promise<void> }).handleDiscover();
      await el.updateComplete;

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('loopback');
      expect((el as unknown as { discovery: unknown }).discovery).to.be.null;
    });
  });

  describe('Start OAuth', () => {
    it('invokes startOAuth with ("oidc", clientId, issuerUrl)', async () => {
      // startOAuth(provider, clientId, instanceUrl) calls the
      // oauth_get_authorize_url command with { provider, clientId, instanceUrl }.
      // Assert the dialog threads the OIDC issuer through as instanceUrl and the
      // per-account client ID.
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = ISSUER;
      (el as unknown as { clientIdInput: string }).clientIdInput = 'acme-client';
      invokeHistory.length = 0;
      await (el as unknown as { handleStartOAuth: () => Promise<void> }).handleStartOAuth();
      await new Promise((r) => setTimeout(r, 50));

      const authCall = invokeHistory.find((h) => h.command === 'oauth_get_authorize_url');
      expect(authCall, 'oauth_get_authorize_url invoked').to.not.be.undefined;
      const args = authCall!.args as Record<string, string>;
      expect(args.provider).to.equal('oidc');
      expect(args.clientId).to.equal('acme-client');
      expect(args.instanceUrl).to.equal(ISSUER);
    });

    it('shows an error if issuer or client id is missing', async () => {
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      await (el as unknown as { handleStartOAuth: () => Promise<void> }).handleStartOAuth();
      await el.updateComplete;

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('required');
    });

    it('surfaces an error and a toast when the OAuth flow errors (not a silent dead-end)', async () => {
      // The spinner only renders for pending/exchanging; on 'error' the form
      // resets to the sign-in button. Without surfacing the error the user is
      // left with no feedback about why sign-in failed.
      mockInvoke = async (command: string) => {
        if (command === 'get_unified_profiles_config') {
          return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
        }
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return null;
      };

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await oauthService.startOAuth('oidc', 'acme-client', ISSUER);
      await el.updateComplete;

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl, 'error surfaced inline').to.not.be.null;
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error'), 'error toast shown').to.be.true;
    });
  });

  describe('OAuth complete', () => {
    it('creates an oidc account (save_global_account with oidc config) and stores the token', async () => {
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = ISSUER;
      (el as unknown as { clientIdInput: string }).clientIdInput = 'acme-client';
      (el as unknown as { nameInput: string }).nameInput = 'Acme SSO';
      await el.updateComplete;

      invokeHistory.length = 0;

      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'oidc',
            tokens: { accessToken: 'oidc-access', idToken: 'header.payload.sig' },
            instanceUrl: ISSUER,
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const saveCall = invokeHistory.find((h) => h.command === 'save_global_account');
      expect(saveCall, 'save_global_account was called').to.not.be.undefined;
      const account = (saveCall!.args as Record<string, unknown>).account as IntegrationAccount;
      expect(account.integrationType).to.equal('oidc');
      expect(account.config).to.deep.include({ type: 'oidc', issuerUrl: ISSUER, clientId: 'acme-client' });

      // Token stored in keyring.
      const stored = invokeHistory.some((h) => h.command === 'store_keyring_token');
      expect(stored, 'token stored').to.be.true;

      // Connected UI + identity from decoded ID token.
      expect((el as unknown as { connected: boolean }).connected).to.be.true;
      await el.updateComplete;
      const status = el.shadowRoot!.querySelector('.connection-status');
      expect(status).to.not.be.null;
      expect(status!.textContent).to.include('SSO User');
    });

    it('creates a NEW account (not clobbering an existing same-issuer account) when adding', async () => {
      // An account already exists for ISSUER. The user clicks "Add account" to
      // sign in with a SECOND identity on the same SSO. The OAuth-complete
      // find-existing fallback must NOT match the existing same-issuer account.
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;
      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = ISSUER;
      (el as unknown as { clientIdInput: string }).clientIdInput = 'acme-client';
      (el as unknown as { nameInput: string }).nameInput = 'Second SSO Identity';
      await el.updateComplete;

      invokeHistory.length = 0;
      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'oidc',
            tokens: { accessToken: 'oidc-access-2', idToken: 'header.payload.sig' },
            instanceUrl: ISSUER,
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const saveCall = invokeHistory.find((h) => h.command === 'save_global_account');
      expect(saveCall, 'save_global_account was called').to.not.be.undefined;
      const account = (saveCall!.args as Record<string, unknown>).account as IntegrationAccount;
      // A brand-new account — NOT the pre-existing one.
      expect(account.id).to.not.equal('oidc-acc-1');
      expect(account.config).to.deep.include({ type: 'oidc', issuerUrl: ISSUER });
    });

    it('ignores oauth-complete for other providers', async () => {
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);
      invokeHistory.length = 0;

      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: { provider: 'github', tokens: { accessToken: 'gh' } },
        })
      );
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(invokeHistory.some((h) => h.command === 'save_global_account')).to.be.false;
      expect((el as unknown as { connected: boolean }).connected).to.be.false;
    });

    it('surfaces an error when account persistence fails', async () => {
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'save_global_account') throw new Error('persist boom');
        return origMock(command, args);
      };

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);
      (el as unknown as { issuerUrlInput: string }).issuerUrlInput = ISSUER;
      (el as unknown as { clientIdInput: string }).clientIdInput = 'acme-client';
      await el.updateComplete;

      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: { provider: 'oidc', tokens: { accessToken: 'oidc-access' }, instanceUrl: ISSUER },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.include('persist boom');
    });
  });

  describe('Multi-account', () => {
    it('shows account selector and connected state when an account exists', async () => {
      unifiedProfileStore.getState().setAccounts([
        { ...mockAccount, cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null } },
      ]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      expect(el.shadowRoot!.querySelector('gn-account-selector')).to.not.be.null;
      const status = el.shadowRoot!.querySelector('.connection-status');
      expect(status).to.not.be.null;
      expect(status!.textContent).to.include('SSO User');
    });

    // Regression: the account-selector dispatches a bubbling/composed
    // `manage-accounts` event. The dialog must CONSUME it and re-emit its own,
    // so the host receives EXACTLY ONE event — not the selector's plus the
    // re-dispatch. The double-fire corrupted the manager's reversible-Back state.
    it('forwards manage-accounts to the host exactly once', async () => {
      unifiedProfileStore.getState().setAccounts([
        { ...mockAccount, cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null } },
      ]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const events: CustomEvent[] = [];
      el.addEventListener('manage-accounts', (e) => events.push(e as CustomEvent));

      const selector = el.shadowRoot!.querySelector('gn-account-selector')!;
      selector.dispatchEvent(
        new CustomEvent('manage-accounts', {
          detail: { integrationType: 'oidc' },
          bubbles: true,
          composed: true,
        })
      );

      expect(events).to.have.lengthOf(1);
      expect(events[0].detail.integrationType).to.equal('oidc');
    });
  });

  describe('Disconnect', () => {
    it('persists a cleared cachedUser so the account does not re-show Connected', async () => {
      const connectedAccount = {
        ...mockAccount,
        cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null },
      };
      unifiedProfileStore.getState().setAccounts([connectedAccount]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);
      expect((el as unknown as { connected: boolean }).connected).to.be.true;

      invokeHistory.length = 0;
      await (el as unknown as { handleDisconnect: () => Promise<void> }).handleDisconnect();
      await el.updateComplete;

      // Token deleted from keyring.
      expect(invokeHistory.some((h) => h.command === 'delete_keyring_token')).to.be.true;

      // cachedUser cleared via save_global_account (drives connected state on reopen).
      const saveCall = invokeHistory.find((h) => h.command === 'save_global_account');
      expect(saveCall, 'save_global_account called to clear cachedUser').to.not.be.undefined;
      const saved = (saveCall!.args as Record<string, unknown>).account as IntegrationAccount;
      expect(saved.cachedUser).to.equal(null);

      // UI reflects disconnected immediately.
      expect((el as unknown as { connected: boolean }).connected).to.be.false;
      expect((el as unknown as { connectedUser: unknown }).connectedUser).to.equal(null);
    });

    it('surfaces an error toast when disconnect fails', async () => {
      const connectedAccount = {
        ...mockAccount,
        cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null },
      };
      unifiedProfileStore.getState().setAccounts([connectedAccount]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        // saveGlobalAccount (clearing cachedUser) throws on the invoke layer.
        if (command === 'save_global_account') throw new Error('persist boom');
        return origMock(command, args);
      };

      uiStore.getState().toasts.length = 0;
      await (el as unknown as { handleDisconnect: () => Promise<void> }).handleDisconnect();
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.include('persist boom');
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.true;
    });
  });

  describe('Add account guard', () => {
    it('does not clobber a half-typed Add form when a background store emit fires', async () => {
      const connectedAccount = {
        ...mockAccount,
        cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null },
      };
      unifiedProfileStore.getState().setAccounts([connectedAccount]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      // User clicks "Add account": selection cleared, form blanked.
      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;

      // User starts typing a new issuer/client/name.
      const elState = el as unknown as {
        issuerUrlInput: string;
        clientIdInput: string;
        nameInput: string;
      };
      elState.issuerUrlInput = 'https://new-issuer.example.com';
      elState.clientIdInput = 'new-client';
      elState.nameInput = 'My New SSO';

      // A background validation emit (e.g. setAccountConnectionStatus) fires.
      unifiedProfileStore.getState().setAccountConnectionStatus('oidc-acc-1', 'connected');
      await el.updateComplete;

      // The half-typed form must be preserved (not overwritten by applyAccount).
      expect(elState.issuerUrlInput).to.equal('https://new-issuer.example.com');
      expect(elState.clientIdInput).to.equal('new-client');
      expect(elState.nameInput).to.equal('My New SSO');
      expect((el as unknown as { selectedAccountId: string | null }).selectedAccountId).to.equal(null);
    });

    it('does not clobber a half-typed Add form when the active profile changes', async () => {
      const connectedAccount = {
        ...mockAccount,
        cachedUser: { username: 'ssouser', displayName: 'SSO User', email: null, avatarUrl: null },
      };
      unifiedProfileStore.getState().setAccounts([connectedAccount]);

      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      // User clicks "Add account" and starts typing a new SSO config.
      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;
      const elState = el as unknown as {
        issuerUrlInput: string;
        clientIdInput: string;
        nameInput: string;
        selectedAccountId: string | null;
      };
      elState.issuerUrlInput = 'https://new-issuer.example.com';
      elState.clientIdInput = 'new-client';
      elState.nameInput = 'My New SSO';

      // A profile switch lands while the user is mid-typing (the active-profile
      // -change branch of the store subscription). It must respect isAddingAccount
      // and NOT apply the preferred account over the half-typed form.
      const newProfile = { ...createEmptyUnifiedProfile(), id: 'profile-2' };
      unifiedProfileStore.getState().setActiveProfile(newProfile);
      await el.updateComplete;

      expect(elState.issuerUrlInput).to.equal('https://new-issuer.example.com');
      expect(elState.clientIdInput).to.equal('new-client');
      expect(elState.nameInput).to.equal('My New SSO');
      expect(elState.selectedAccountId).to.equal(null);
    });
  });

  // The browser round-trip is asynchronous and the account selector renders
  // OUTSIDE the pending block, so it stays clickable throughout. The flow must
  // stay bound to the account it started on instead of writing the new token
  // onto whatever is selected when the callback lands.
  describe('OAuth target pinning (regression)', () => {
    interface OidcDialogInternals {
      oauthTargetAccountId: string | null | undefined;
      oauthTargetWasAddingAccount: boolean | undefined;
      oauthTargetIssuerUrl: string | undefined;
      oauthTargetClientId: string | undefined;
      selectedAccountId: string | null;
      isAddingAccount: boolean;
      issuerUrlInput: string;
      clientIdInput: string;
      error: string | null;
      oauthState: { status: string };
      handleStartOAuth(): Promise<void>;
      handleCancelOAuth(): void;
      handleOAuthComplete(event: CustomEvent): Promise<void>;
    }

    const SECOND_ISSUER = 'https://sso.other.example.com';

    const secondAccount = createTestAccount({
      id: 'oidc-acc-2',
      name: 'Other SSO',
      integrationType: 'oidc',
      config: { type: 'oidc', issuerUrl: SECOND_ISSUER, clientId: 'other-client' },
      isDefault: false,
    });

    function completeEvent(accessToken: string, issuerUrl?: string): CustomEvent {
      return new CustomEvent('oauth-complete', {
        detail: {
          provider: 'oidc',
          tokens: {
            accessToken,
            refreshToken: 'r-1',
            expiresIn: 3600,
            idToken: 'header.payload.sig',
          },
          instanceUrl: issuerUrl,
        },
      });
    }

    /**
     * Hold `decode_oidc_id_token` open so the test can mutate the dialog's
     * selection while an OAuth completion is still in flight.
     */
    function gateDecode(): { started: Promise<void>; release: () => void } {
      let release!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'decode_oidc_id_token') {
          markStarted();
          await gate;
        }
        return previous(command, args);
      };
      return { started, release };
    }

    it('pins the selected account, issuer and client when the sign-in flow starts', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.issuerUrlInput = ISSUER;
      internals.clientIdInput = 'acme-client';

      await internals.handleStartOAuth();

      expect(internals.oauthTargetAccountId, 'account pinned at start').to.equal('oidc-acc-1');
      expect(internals.oauthTargetWasAddingAccount, 'add-account pinned at start').to.be.false;
      expect(internals.oauthTargetIssuerUrl, 'issuer pinned at start').to.equal(ISSUER);
      expect(internals.oauthTargetClientId, 'client id pinned at start').to.equal('acme-client');
    });

    it('releases the pinned target when the sign-in flow fails to start', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return previous(command, args);
      };

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.issuerUrlInput = ISSUER;
      internals.clientIdInput = 'acme-client';
      // A pin left over from an earlier attempt must not survive a flow that
      // never started — a later completion would otherwise be attributed to it.
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      // `startOAuth` never rejects — it reports the failure through the OAuth
      // state subscriber, which is where the pin is released.
      await internals.handleStartOAuth();
      await el.updateComplete;

      expect(internals.oauthTargetAccountId, 'pin released').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;
      expect(internals.oauthTargetIssuerUrl, 'issuer pin released').to.be.undefined;
      expect(internals.oauthTargetClientId, 'client id pin released').to.be.undefined;
    });

    it('releases the pinned target and clears the spinner when the user cancels', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const internals = el as unknown as OidcDialogInternals;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';
      internals.oauthState = { status: 'pending' };
      internals.error = 'stale';

      internals.handleCancelOAuth();
      await el.updateComplete;

      expect(internals.oauthTargetAccountId, 'pin released on cancel').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;
      expect(internals.oauthTargetIssuerUrl, 'issuer pin released').to.be.undefined;
      expect(internals.oauthTargetClientId, 'client id pin released').to.be.undefined;
      expect(internals.oauthState.status, 'form no longer stuck pending').to.equal('idle');
      expect(internals.error, 'stale error cleared').to.equal(null);
      // The form is usable again instead of showing the pending spinner.
      expect(el.shadowRoot!.querySelector('.oauth-pending')).to.be.null;
      expect(el.shadowRoot!.querySelector('.token-form')).to.not.be.null;
    });

    it('writes the token to the account the flow started on, not a later selection', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount, secondAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      const gate = gateDecode();
      const completion = internals.handleOAuthComplete(
        completeEvent('oidc-access-pinned', ISSUER)
      );
      await gate.started;
      // The user switches to the other SSO account while the browser
      // round-trip is still outstanding.
      internals.selectedAccountId = 'oidc-acc-2';
      internals.issuerUrlInput = SECOND_ISSUER;
      internals.clientIdInput = 'other-client';
      gate.release();
      await completion;
      await el.updateComplete;

      expect(keyringStore.get('oidc_token_oidc-acc-1')).to.equal('oidc-access-pinned');
      expect(
        keyringStore.has('oidc_token_oidc-acc-2'),
        'the newly selected account is not overwritten'
      ).to.be.false;
      // The cachedUser of the account the user switched TO must be untouched.
      const cachedUserCalls = invokeHistory.filter(
        (h) => h.command === 'update_global_account_cached_user'
      );
      expect(
        cachedUserCalls.every(
          (h) => (h.args as Record<string, string>).accountId !== 'oidc-acc-2'
        ),
        'the newly selected account keeps its identity'
      ).to.be.true;
      expect(internals.selectedAccountId, 'newer selection preserved').to.equal('oidc-acc-2');
    });

    it('does not rewrite the pinned account config from a mid-flow form change', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount, secondAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      invokeHistory.length = 0;
      const gate = gateDecode();
      // No instanceUrl on the callback: the issuer must come from the pin, not
      // from whatever the mid-flow switch left in the form.
      const completion = internals.handleOAuthComplete(completeEvent('oidc-access-cfg'));
      await gate.started;
      // The user switches account AND retypes the issuer while the round-trip
      // is outstanding. Reading the form live here would persist this typo onto
      // the account they switched to.
      internals.selectedAccountId = 'oidc-acc-2';
      internals.issuerUrlInput = 'https://typo.example.com';
      internals.clientIdInput = 'typo-client';
      gate.release();
      await completion;
      await el.updateComplete;

      // The pinned account's issuer/clientId were already correct, so nothing
      // should have been rewritten — on either account.
      const rewrites = invokeHistory.filter((h) => h.command === 'save_global_account');
      expect(rewrites, 'no account config rewritten from the stale form').to.have.lengthOf(0);
      expect(keyringStore.get('oidc_token_oidc-acc-1')).to.equal('oidc-access-cfg');
    });

    it('refuses to write when the pinned account was deleted mid-flow', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      // The account is gone by the time the callback lands.
      unifiedProfileStore.getState().setAccounts([]);
      uiStore.getState().toasts.length = 0;
      invokeHistory.length = 0;

      await internals.handleOAuthComplete(completeEvent('oidc-access-orphan', ISSUER));
      await el.updateComplete;

      expect(keyringStore.has('oidc_token_oidc-acc-1'), 'no orphaned keyring entry').to.be.false;
      expect(
        invokeHistory.some((h) => h.command === 'save_global_account'),
        'no surprise replacement account created'
      ).to.be.false;
      expect(internals.error, 'user told why').to.include('removed before sign-in completed');
      expect(uiStore.getState().toasts.some((t) => t.type === 'error'), 'error toast shown').to.be
        .true;
    });

    it('cleans up the written token when the account is deleted and a later step throws', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      // The token write and the post-write existence check both succeed; the
      // account is then deleted and the very next await rejects, so the throw
      // jumps past every in-try guard straight to the catch.
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'update_global_account_cached_user') {
          unifiedProfileStore.getState().setAccounts([]);
          throw new Error('Profile store write failed');
        }
        return previous(command, args);
      };

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      await internals.handleOAuthComplete(completeEvent('oidc-access-late-fail', ISSUER));
      await el.updateComplete;

      expect(
        keyringStore.has('oidc_token_oidc-acc-1'),
        'no orphaned keyring entry for the deleted account'
      ).to.be.false;
      expect(
        keyringStore.has('oidc_token_oidc-acc-1_oauth'),
        'no orphaned OAuth blob for the deleted account'
      ).to.be.false;
      expect(internals.error, 'failure surfaced to the user').to.equal(
        'Profile store write failed'
      );
    });

    it('keeps the stored token when a later step throws but the account still exists', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnOidcDialog>(html`<gn-oidc-dialog .open=${true}></gn-oidc-dialog>`);
      await waitForLoad(el);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'update_global_account_cached_user') {
          throw new Error('Profile store write failed');
        }
        return previous(command, args);
      };

      const internals = el as unknown as OidcDialogInternals;
      internals.selectedAccountId = 'oidc-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'oidc-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetIssuerUrl = ISSUER;
      internals.oauthTargetClientId = 'acme-client';

      await internals.handleOAuthComplete(completeEvent('oidc-access-keep', ISSUER));
      await el.updateComplete;

      // The cleanup is scoped to accounts that no longer exist — a live account
      // must keep the token it just signed in with.
      expect(
        keyringStore.get('oidc_token_oidc-acc-1'),
        'the surviving account keeps its token'
      ).to.equal('oidc-access-keep');
      expect(internals.error, 'failure surfaced to the user').to.equal(
        'Profile store write failed'
      );
    });
  });
});
