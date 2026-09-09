/**
 * Unified Profile Service - Refresh Account Cached User Tests
 *
 * Tests refreshAccountCachedUser and validateAllAccountTokens including
 * connection check for each integration type, CachedUser field mapping,
 * store connection status updates, and token validation counts.
 */

import { expect } from '@open-wc/testing';

// Mock Tauri API - must be set up before any imports that use Tauri
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args: unknown }> = [];

// Token store for simulating OS keyring
const tokenStore = new Map<string, string>();

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import { refreshAccountCachedUser, validateAllAccountTokens } from '../unified-profile.service.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { createEmptyIntegrationAccount } from '../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';

// Helper: create a test account with all required fields
function createTestAccount(
  overrides: Partial<IntegrationAccount> & { id: string }
): IntegrationAccount {
  const base = createEmptyIntegrationAccount(overrides.integrationType ?? 'github');
  return {
    ...base,
    name: 'Test Account',
    isDefault: false,
    cachedUser: null,
    ...overrides,
  } as IntegrationAccount;
}

// Helper: store a mock token in the simulated keyring
function setMockToken(integrationType: string, accountId: string, token: string): void {
  const key = `${integrationType}_token_${accountId}`;
  tokenStore.set(key, token);
}

// Default mock responses for connection checks
const githubConnectionResponse = {
  connected: true,
  user: {
    login: 'testuser',
    id: 12345,
    name: 'Test User',
    email: 'test@test.com',
    avatarUrl: 'https://avatar.com/test',
  },
  scopes: ['repo'],
};

// A REAL `GitLabConnectionStatus`: the backend's `GitLabUser`
// (`src-tauri/src/commands/gitlab.rs:102`) carries no email, so one here would
// pin a field the frontend can never receive.
const gitlabConnectionResponse = {
  connected: true,
  user: {
    id: 7,
    username: 'gluser',
    name: 'GL User',
    avatarUrl: null,
    webUrl: 'https://gitlab.com/gluser',
  },
  instanceUrl: 'https://gitlab.com',
};

const adoConnectionResponse = {
  connected: true,
  user: {
    displayName: 'ADO User',
    uniqueName: 'adouser@org.com',
    imageUrl: null,
  },
  organization: 'testorg',
};

const bitbucketConnectionResponse = {
  connected: true,
  user: {
    uuid: '{bb-uuid}',
    username: 'bbuser',
    displayName: 'BB User',
    avatarUrl: null,
  },
};

/** Raw result of `oauth_refresh_token`; null → the refresh fails. */
let refreshResponse: unknown = null;

/** Seed an OAuth bundle whose access token is inside the 5-minute expiry window. */
function setExpiringOAuthToken(
  integrationType: string,
  accountId: string,
  accessToken: string
): void {
  const key = `${integrationType}_token_${accountId}`;
  tokenStore.set(key, accessToken);
  tokenStore.set(
    `${key}_oauth`,
    JSON.stringify({ accessToken, refreshToken: 'r1', expiresAt: Date.now() + 60_000 })
  );
}

function setupDefaultMockInvoke(): void {
  mockInvoke = async (command: string, args?: unknown) => {
    const params = args as Record<string, unknown> | undefined;

    // Credential service (OS keyring)
    if (command === 'get_keyring_token') {
      const key = params?.key as string;
      return tokenStore.get(key) ?? null;
    }
    if (command === 'store_keyring_token') {
      const key = params?.key as string;
      const value = params?.value as string;
      tokenStore.set(key, value);
      return null;
    }
    if (command === 'delete_keyring_token') {
      const key = params?.key as string;
      tokenStore.delete(key);
      return null;
    }

    // Connection checks (these are raw invoke results, invokeCommand wraps them)
    if (command === 'check_github_connection') {
      return githubConnectionResponse;
    }
    if (command === 'check_gitlab_connection') {
      return gitlabConnectionResponse;
    }
    if (command === 'check_ado_connection') {
      return adoConnectionResponse;
    }
    if (command === 'check_bitbucket_connection_with_token') {
      return bitbucketConnectionResponse;
    }

    if (command === 'oauth_refresh_token') {
      return refreshResponse;
    }

    // Update cached user and config reload
    if (command === 'update_global_account_cached_user') {
      return null;
    }
    if (command === 'get_unified_profiles_config') {
      return {
        version: 3,
        profiles: unifiedProfileStore.getState().profiles,
        accounts: unifiedProfileStore.getState().accounts,
        repositoryAssignments: {},
      };
    }

    return null;
  };
}

describe('unified-profile.service - refreshAccountCachedUser', () => {
  beforeEach(() => {
    unifiedProfileStore.getState().reset();
    invokeHistory.length = 0;
    tokenStore.clear();
    refreshResponse = null;
    setupDefaultMockInvoke();
  });

  it('returns CachedUser with mapped fields for a GitHub account', async () => {
    const account = createTestAccount({
      id: 'gh-acc-1',
      name: 'My GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('github', 'gh-acc-1', 'ghp_testtoken123');

    const result = await refreshAccountCachedUser(account);

    expect(result).to.not.be.null;
    expect(result!.username).to.equal('testuser');
    expect(result!.displayName).to.equal('Test User');
    expect(result!.avatarUrl).to.equal('https://avatar.com/test');
    expect(result!.email).to.equal('test@test.com');
  });

  it('returns CachedUser with mapped fields for a GitLab account', async () => {
    const account = createTestAccount({
      id: 'gl-acc-1',
      name: 'My GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('gitlab', 'gl-acc-1', 'glpat-testtoken123');

    const result = await refreshAccountCachedUser(account);

    expect(result).to.not.be.null;
    expect(result!.username).to.equal('gluser');
    expect(result!.displayName).to.equal('GL User');
    // GitLab's connection check does not report an email; the account keeps
    // none rather than an `undefined` read off a field that never arrives.
    expect(result!.email).to.equal(null);
  });

  it('returns CachedUser with mapped fields for an Azure DevOps account', async () => {
    const account = createTestAccount({
      id: 'ado-acc-1',
      name: 'My ADO',
      integrationType: 'azure-devops',
      config: { type: 'azure-devops', organization: 'testorg' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('azure-devops', 'ado-acc-1', 'ado-pat-token123');

    const result = await refreshAccountCachedUser(account);

    expect(result).to.not.be.null;
    expect(result!.username).to.equal('adouser');
    expect(result!.displayName).to.equal('ADO User');
    expect(result!.email).to.equal('adouser@org.com');
  });

  // Regression: this background validator is what marks an account disconnected
  // app-wide. It only refreshed Azure DevOps tokens, so GitLab/Bitbucket OAuth
  // accounts were reported disconnected on startup once their ~2h access token
  // lapsed, despite a valid stored refresh token.
  it('refreshes an expiring GitLab OAuth token before validating the account', async () => {
    const account = createTestAccount({
      id: 'gl-oauth-1',
      name: 'OAuth GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setExpiringOAuthToken('gitlab', 'gl-oauth-1', 'stale-access');
    refreshResponse = { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 };

    const result = await refreshAccountCachedUser(account);

    const check = invokeHistory.find((h) => h.command === 'check_gitlab_connection');
    expect(check, 'the account was validated').to.not.be.undefined;
    expect((check!.args as { token: string }).token).to.equal('fresh-access');
    expect(result).to.not.be.null;
    expect(
      unifiedProfileStore.getState().accountConnectionStatus['gl-oauth-1']?.status
    ).to.equal('connected');
  });

  it('refreshes an expiring GitHub OAuth token before validating the account', async () => {
    const account = createTestAccount({
      id: 'gh-oauth-1',
      name: 'OAuth GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setExpiringOAuthToken('github', 'gh-oauth-1', 'stale-access');
    refreshResponse = { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 };

    const result = await refreshAccountCachedUser(account);

    const check = invokeHistory.find((h) => h.command === 'check_github_connection');
    expect(check, 'the account was validated').to.not.be.undefined;
    expect((check!.args as { token: string }).token).to.equal('fresh-access');
    expect(result).to.not.be.null;
    expect(
      unifiedProfileStore.getState().accountConnectionStatus['gh-oauth-1']?.status
    ).to.equal('connected');
  });

  it('refreshes an expiring Bitbucket OAuth token before validating the account', async () => {
    const account = createTestAccount({
      id: 'bb-oauth-1',
      name: 'OAuth Bitbucket',
      integrationType: 'bitbucket',
      config: { type: 'bitbucket', workspace: 'myworkspace' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setExpiringOAuthToken('bitbucket', 'bb-oauth-1', 'stale-access');
    refreshResponse = { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 };

    const result = await refreshAccountCachedUser(account);

    const check = invokeHistory.find(
      (h) => h.command === 'check_bitbucket_connection_with_token'
    );
    expect(check, 'the account was validated').to.not.be.undefined;
    expect((check!.args as { token: string }).token).to.equal('fresh-access');
    expect(result).to.not.be.null;
    expect(
      unifiedProfileStore.getState().accountConnectionStatus['bb-oauth-1']?.status
    ).to.equal('connected');
  });

  it('returns CachedUser with mapped fields for a Bitbucket account', async () => {
    const account = createTestAccount({
      id: 'bb-acc-1',
      name: 'My Bitbucket',
      integrationType: 'bitbucket',
      config: { type: 'bitbucket', workspace: 'myworkspace' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('bitbucket', 'bb-acc-1', 'bb-app-password123');

    const result = await refreshAccountCachedUser(account);

    expect(result).to.not.be.null;
    expect(result!.username).to.equal('bbuser');
    expect(result!.displayName).to.equal('BB User');
    expect(result!.email).to.be.null;
  });

  it('returns null when connection check fails (connected: false)', async () => {
    const account = createTestAccount({
      id: 'gh-fail-1',
      name: 'Disconnected GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('github', 'gh-fail-1', 'ghp_expiredtoken');

    // Override the GitHub connection response to return disconnected
    const originalMock = mockInvoke;
    mockInvoke = async (command: string, args?: unknown) => {
      if (command === 'check_github_connection') {
        return { connected: false, user: null, scopes: [] };
      }
      return originalMock(command, args);
    };

    const result = await refreshAccountCachedUser(account);
    expect(result).to.be.null;
  });

  it('updates accountConnectionStatus in store to connected', async () => {
    const account = createTestAccount({
      id: 'gh-status-1',
      name: 'Status GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('github', 'gh-status-1', 'ghp_validtoken');

    await refreshAccountCachedUser(account);

    const status = unifiedProfileStore.getState().accountConnectionStatus['gh-status-1'];
    expect(status).to.not.be.undefined;
    expect(status.status).to.equal('connected');
  });

  it('updates accountConnectionStatus in store to disconnected on failure', async () => {
    const account = createTestAccount({
      id: 'gh-disc-1',
      name: 'Disc GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('github', 'gh-disc-1', 'ghp_badtoken');

    const originalMock = mockInvoke;
    mockInvoke = async (command: string, args?: unknown) => {
      if (command === 'check_github_connection') {
        return { connected: false, user: null, scopes: [] };
      }
      return originalMock(command, args);
    };

    await refreshAccountCachedUser(account);

    const status = unifiedProfileStore.getState().accountConnectionStatus['gh-disc-1'];
    expect(status).to.not.be.undefined;
    expect(status.status).to.equal('disconnected');
  });

  it('returns null and sets disconnected when no token exists', async () => {
    const account = createTestAccount({
      id: 'gh-notoken-1',
      name: 'No Token GitHub',
      integrationType: 'github',
    });
    unifiedProfileStore.getState().setAccounts([account]);
    // Do NOT set a token in the mock store

    const result = await refreshAccountCachedUser(account);
    expect(result).to.be.null;

    const status = unifiedProfileStore.getState().accountConnectionStatus['gh-notoken-1'];
    expect(status).to.not.be.undefined;
    expect(status.status).to.equal('disconnected');
  });

  it('marks an OIDC account with a stored token as connected and keeps cachedUser', async () => {
    const cachedUser = {
      username: 'ssouser',
      displayName: 'SSO User',
      avatarUrl: null,
      email: 'sso@example.com',
    };
    const account = createTestAccount({
      id: 'oidc-token-1',
      name: 'Enterprise SSO',
      integrationType: 'oidc',
      config: { type: 'oidc', issuerUrl: 'https://auth.example.com', clientId: 'cid' },
      cachedUser,
    });
    unifiedProfileStore.getState().setAccounts([account]);
    setMockToken('oidc', 'oidc-token-1', 'oidc-access-token');

    const result = await refreshAccountCachedUser(account);

    // OIDC has no cheap server ping — a present token means "connected" and the
    // existing cachedUser must NOT be wiped.
    expect(result).to.not.be.null;
    expect(result!.username).to.equal('ssouser');
    expect(result!.email).to.equal('sso@example.com');

    const status = unifiedProfileStore.getState().accountConnectionStatus['oidc-token-1'];
    expect(status.status).to.equal('connected');
  });

  it('marks an OIDC account without a token as disconnected', async () => {
    const account = createTestAccount({
      id: 'oidc-notoken-1',
      name: 'Enterprise SSO',
      integrationType: 'oidc',
      config: { type: 'oidc', issuerUrl: 'https://auth.example.com', clientId: 'cid' },
    });
    unifiedProfileStore.getState().setAccounts([account]);
    // No token stored

    const result = await refreshAccountCachedUser(account);
    expect(result).to.be.null;

    const status = unifiedProfileStore.getState().accountConnectionStatus['oidc-notoken-1'];
    expect(status.status).to.equal('disconnected');
  });
});

describe('unified-profile.service - validateAllAccountTokens', () => {
  beforeEach(() => {
    unifiedProfileStore.getState().reset();
    invokeHistory.length = 0;
    tokenStore.clear();
    refreshResponse = null;
    setupDefaultMockInvoke();
  });

  it('returns correct counts for all valid accounts', async () => {
    const ghAccount = createTestAccount({
      id: 'gh-valid-1',
      name: 'Valid GitHub',
      integrationType: 'github',
    });
    const glAccount = createTestAccount({
      id: 'gl-valid-1',
      name: 'Valid GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    });
    unifiedProfileStore.getState().setAccounts([ghAccount, glAccount]);

    setMockToken('github', 'gh-valid-1', 'ghp_valid');
    setMockToken('gitlab', 'gl-valid-1', 'glpat-valid');

    const result = await validateAllAccountTokens();

    expect(result.valid).to.equal(2);
    expect(result.invalid).to.equal(0);
    expect(result.invalidAccounts).to.have.lengthOf(0);
  });

  it('returns correct counts when some accounts are invalid', async () => {
    const ghAccount = createTestAccount({
      id: 'gh-mixed-1',
      name: 'Valid GitHub',
      integrationType: 'github',
    });
    const glAccount = createTestAccount({
      id: 'gl-mixed-1',
      name: 'Invalid GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    });
    unifiedProfileStore.getState().setAccounts([ghAccount, glAccount]);

    // Only set token for GitHub, GitLab has no token -> will be invalid
    setMockToken('github', 'gh-mixed-1', 'ghp_valid');

    const result = await validateAllAccountTokens();

    expect(result.valid).to.equal(1);
    expect(result.invalid).to.equal(1);
  });

  it('returns invalidAccounts list with account names and types', async () => {
    const ghAccount = createTestAccount({
      id: 'gh-inv-1',
      name: 'My GitHub Account',
      integrationType: 'github',
    });
    const glAccount = createTestAccount({
      id: 'gl-inv-1',
      name: 'My GitLab Account',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    });
    unifiedProfileStore.getState().setAccounts([ghAccount, glAccount]);

    // No tokens set -> both invalid

    const result = await validateAllAccountTokens();

    expect(result.invalid).to.equal(2);
    expect(result.invalidAccounts).to.have.lengthOf(2);

    const ghInvalid = result.invalidAccounts.find((a) => a.integrationType === 'github');
    expect(ghInvalid).to.not.be.undefined;
    expect(ghInvalid!.accountName).to.equal('My GitHub Account');
    expect(ghInvalid!.integrationType).to.equal('github');

    const glInvalid = result.invalidAccounts.find((a) => a.integrationType === 'gitlab');
    expect(glInvalid).to.not.be.undefined;
    expect(glInvalid!.accountName).to.equal('My GitLab Account');
    expect(glInvalid!.integrationType).to.equal('gitlab');
  });

  it('counts an OIDC account with a token but no cachedUser as valid (matches connected status)', async () => {
    // OIDC has no cheap server-side identity ping, so refreshAccountCachedUser
    // returns null when cachedUser is null even though it marks the account
    // 'connected'. The tally must follow the connection status, not the returned
    // cachedUser, or a perfectly valid SSO account is reported as invalid.
    const oidcAccount = createTestAccount({
      id: 'oidc-valid-1',
      name: 'Enterprise SSO',
      integrationType: 'oidc',
      config: { type: 'oidc', issuerUrl: 'https://auth.example.com', clientId: 'cid' },
      cachedUser: null,
    });
    unifiedProfileStore.getState().setAccounts([oidcAccount]);
    setMockToken('oidc', 'oidc-valid-1', 'oidc-access-token');

    const result = await validateAllAccountTokens();

    expect(result.valid).to.equal(1);
    expect(result.invalid).to.equal(0);
    expect(result.invalidAccounts).to.have.lengthOf(0);
  });

  it('counts an OIDC account without a token as invalid', async () => {
    const oidcAccount = createTestAccount({
      id: 'oidc-invalid-1',
      name: 'Enterprise SSO',
      integrationType: 'oidc',
      config: { type: 'oidc', issuerUrl: 'https://auth.example.com', clientId: 'cid' },
      cachedUser: null,
    });
    unifiedProfileStore.getState().setAccounts([oidcAccount]);
    // No token stored -> disconnected -> invalid

    const result = await validateAllAccountTokens();

    expect(result.valid).to.equal(0);
    expect(result.invalid).to.equal(1);
    expect(result.invalidAccounts[0].integrationType).to.equal('oidc');
  });
});
