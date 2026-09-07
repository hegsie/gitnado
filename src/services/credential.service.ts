/**
 * Credential Service
 *
 * Provides secure credential storage using the OS system keyring
 * (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * Accessed via Tauri backend commands that use the `keyring` crate.
 */

import { invokeCommand } from './tauri-api.ts';
import { loggers } from '../utils/logger.ts';

const log = loggers.credential;

// Credential keys (used for legacy single-account storage)
export const CredentialKeys = {
  GITHUB_TOKEN: 'github_token',
  GITLAB_TOKEN: 'gitlab_token',
  BITBUCKET_USERNAME: 'bitbucket_username',
  BITBUCKET_PASSWORD: 'bitbucket_password',
  AZURE_DEVOPS_TOKEN: 'azure_devops_token',
} as const;

export type CredentialKey = (typeof CredentialKeys)[keyof typeof CredentialKeys];

/**
 * Sentinel prefix for a per-account token slot that stores a Bitbucket
 * app-password credential (as opposed to an OAuth access token). The stored
 * value has the form `bbapp:<username>:<appPassword>`. App passwords must be
 * sent to Bitbucket via HTTP Basic auth, not as a Bearer token, so the backend
 * detects this prefix and switches auth schemes accordingly.
 *
 * Must stay in sync with `APP_PASSWORD_PREFIX` in
 * `src-tauri/src/commands/bitbucket.rs`.
 */
export const BITBUCKET_APP_PASSWORD_PREFIX = 'bbapp:';

/**
 * Format a Bitbucket username + app password into the prefixed credential
 * stored in a per-account token slot. See {@link BITBUCKET_APP_PASSWORD_PREFIX}.
 */
export function formatBitbucketAppPasswordCredential(
  username: string,
  appPassword: string
): string {
  return `${BITBUCKET_APP_PASSWORD_PREFIX}${username}:${appPassword}`;
}

// =============================================================================
// Core keyring operations (via Tauri backend)
// =============================================================================

async function keyringStore(key: string, value: string): Promise<void> {
  const result = await invokeCommand<void>('store_keyring_token', { key, value });
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to store credential');
  }
  log.debug(`Stored credential: ${key}`);
}

async function keyringGet(key: string): Promise<string | null> {
  const result = await invokeCommand<string | null>('get_keyring_token', { key });
  if (result.success && result.data) {
    log.debug(`Retrieved credential: ${key}`);
    return result.data;
  }
  return null;
}

async function keyringDelete(key: string): Promise<void> {
  const result = await invokeCommand<void>('delete_keyring_token', { key });
  if (result.success) {
    log.debug(`Deleted credential: ${key}`);
  } else {
    log.debug(`Credential not found for deletion: ${key}`);
  }
}

// =============================================================================
// Legacy single-credential functions (now backed by keyring)
// =============================================================================

/**
 * Store a credential
 */
export async function storeCredential(
  key: CredentialKey,
  value: string
): Promise<void> {
  return keyringStore(key, value);
}

/**
 * Retrieve a credential
 */
export async function getCredential(
  key: CredentialKey
): Promise<string | null> {
  return keyringGet(key);
}

/**
 * Delete a credential
 */
export async function deleteCredential(key: CredentialKey): Promise<void> {
  return keyringDelete(key);
}

/**
 * Check if a credential exists
 */
export async function hasCredential(key: CredentialKey): Promise<boolean> {
  const value = await getCredential(key);
  return value !== null && value.length > 0;
}

// Convenience functions for specific integrations

export const GitHubCredentials = {
  async getToken(): Promise<string | null> {
    return getCredential(CredentialKeys.GITHUB_TOKEN);
  },
  async setToken(token: string): Promise<void> {
    return storeCredential(CredentialKeys.GITHUB_TOKEN, token);
  },
  async deleteToken(): Promise<void> {
    return deleteCredential(CredentialKeys.GITHUB_TOKEN);
  },
  async hasToken(): Promise<boolean> {
    return hasCredential(CredentialKeys.GITHUB_TOKEN);
  },
};

export const GitLabCredentials = {
  async getToken(): Promise<string | null> {
    return getCredential(CredentialKeys.GITLAB_TOKEN);
  },
  async setToken(token: string): Promise<void> {
    return storeCredential(CredentialKeys.GITLAB_TOKEN, token);
  },
  async deleteToken(): Promise<void> {
    return deleteCredential(CredentialKeys.GITLAB_TOKEN);
  },
  async hasToken(): Promise<boolean> {
    return hasCredential(CredentialKeys.GITLAB_TOKEN);
  },
};

export const BitbucketCredentials = {
  async getCredentials(): Promise<{ username: string; password: string } | null> {
    const username = await getCredential(CredentialKeys.BITBUCKET_USERNAME);
    const password = await getCredential(CredentialKeys.BITBUCKET_PASSWORD);
    if (username && password) {
      return { username, password };
    }
    return null;
  },
  async setCredentials(username: string, password: string): Promise<void> {
    await storeCredential(CredentialKeys.BITBUCKET_USERNAME, username);
    await storeCredential(CredentialKeys.BITBUCKET_PASSWORD, password);
  },
  async deleteCredentials(): Promise<void> {
    await deleteCredential(CredentialKeys.BITBUCKET_USERNAME);
    await deleteCredential(CredentialKeys.BITBUCKET_PASSWORD);
  },
  async hasCredentials(): Promise<boolean> {
    return (
      (await hasCredential(CredentialKeys.BITBUCKET_USERNAME)) &&
      (await hasCredential(CredentialKeys.BITBUCKET_PASSWORD))
    );
  },
};

export const AzureDevOpsCredentials = {
  async getToken(): Promise<string | null> {
    return getCredential(CredentialKeys.AZURE_DEVOPS_TOKEN);
  },
  async setToken(token: string): Promise<void> {
    return storeCredential(CredentialKeys.AZURE_DEVOPS_TOKEN, token);
  },
  async deleteToken(): Promise<void> {
    return deleteCredential(CredentialKeys.AZURE_DEVOPS_TOKEN);
  },
  async hasToken(): Promise<boolean> {
    return hasCredential(CredentialKeys.AZURE_DEVOPS_TOKEN);
  },
};

// =============================================================================
// Multi-Account Credential Support
// =============================================================================

import type { IntegrationType } from '../types/integration-accounts.types.ts';
import type { OAuthProvider } from '../types/oauth.types.ts';
import type { GitHubConnectionStatus } from './git.service.ts';

/**
 * Generate a namespaced credential key for an account
 */
export function getAccountCredentialKey(
  integrationType: IntegrationType,
  accountId: string
): string {
  return `${integrationType}_token_${accountId}`;
}

/**
 * Account-based credential management
 * Use these for the new multi-account system
 */
export const AccountCredentials = {
  /**
   * Get a token for a specific account
   */
  async getToken(integrationType: IntegrationType, accountId: string): Promise<string | null> {
    const key = getAccountCredentialKey(integrationType, accountId);
    return keyringGet(key);
  },

  /**
   * Store a token for a specific account.
   *
   * Also removes the `${key}_oauth` companion blob written by
   * storeAccountOAuthToken: this token supersedes any earlier OAuth sign-in for
   * the account (e.g. the user switched it to a PAT / app password), and a
   * leftover bundle would make getFreshAccountToken keep handing back the
   * superseded access token.
   */
  async setToken(
    integrationType: IntegrationType,
    accountId: string,
    token: string
  ): Promise<void> {
    const key = getAccountCredentialKey(integrationType, accountId);
    await keyringStore(key, token);
    await keyringDelete(`${key}_oauth`);
  },

  /**
   * Delete a token for a specific account.
   *
   * Removes BOTH the main credential key and the `${key}_oauth` companion blob
   * written by storeAccountOAuthToken. Deleting only the main key would orphan
   * the refresh-token blob in the keyring, accumulating stale secrets on every
   * disconnect/delete for OAuth providers.
   */
  async deleteToken(integrationType: IntegrationType, accountId: string): Promise<void> {
    const key = getAccountCredentialKey(integrationType, accountId);
    await keyringDelete(key);
    await keyringDelete(`${key}_oauth`);
  },

  /**
   * Check if a token exists for a specific account
   */
  async hasToken(integrationType: IntegrationType, accountId: string): Promise<boolean> {
    const key = getAccountCredentialKey(integrationType, accountId);
    const value = await keyringGet(key);
    return value !== null && value.length > 0;
  },

  /**
   * Migrate a legacy token to an account
   * Copies the legacy token to the new namespaced key
   */
  async migrateLegacyToken(
    integrationType: IntegrationType,
    accountId: string
  ): Promise<boolean> {
    // Map integration type to legacy credential key
    let legacyKey: CredentialKey;
    switch (integrationType) {
      case 'github':
        legacyKey = CredentialKeys.GITHUB_TOKEN;
        break;
      case 'gitlab':
        legacyKey = CredentialKeys.GITLAB_TOKEN;
        break;
      case 'azure-devops':
        legacyKey = CredentialKeys.AZURE_DEVOPS_TOKEN;
        break;
      default:
        return false;
    }

    const legacyToken = await getCredential(legacyKey);
    if (!legacyToken) {
      return false;
    }

    // Store the token with the new namespaced key
    await this.setToken(integrationType, accountId, legacyToken);
    log.debug(` Migrated legacy ${integrationType} token to account ${accountId}`);
    return true;
  },
};

// =============================================================================
// Convenience Exports for Account Tokens
// =============================================================================

/**
 * Get a token for a specific integration account
 */
export async function getAccountToken(
  integrationType: IntegrationType,
  accountId: string
): Promise<string | null> {
  return AccountCredentials.getToken(integrationType, accountId);
}

/**
 * Store a token for a specific integration account
 */
export async function storeAccountToken(
  integrationType: IntegrationType,
  accountId: string,
  token: string
): Promise<void> {
  return AccountCredentials.setToken(integrationType, accountId, token);
}

/**
 * Delete a token for a specific integration account
 */
export async function deleteAccountToken(
  integrationType: IntegrationType,
  accountId: string
): Promise<void> {
  return AccountCredentials.deleteToken(integrationType, accountId);
}

/**
 * Check if a token exists for a specific integration account
 */
export async function hasAccountToken(
  integrationType: IntegrationType,
  accountId: string
): Promise<boolean> {
  return AccountCredentials.hasToken(integrationType, accountId);
}

// =============================================================================
// OAuth Token Support
// =============================================================================

interface OAuthTokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Store an OAuth token for a specific integration account.
 * Stores access token, refresh token, and calculates expiry time.
 */
export async function storeAccountOAuthToken(
  integrationType: IntegrationType,
  accountId: string,
  accessToken: string,
  refreshToken?: string,
  expiresIn?: number
): Promise<void> {
  // Calculate expiry timestamp if expiresIn is provided
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

  // Store as JSON with all OAuth data
  const tokenData: OAuthTokenData = {
    accessToken,
    refreshToken,
    expiresAt,
  };

  const key = getAccountCredentialKey(integrationType, accountId);
  const oauthKey = `${key}_oauth`;

  // Store the access token as the main credential (for backward compatibility)
  await keyringStore(key, accessToken);

  // Store the full OAuth data separately for refresh handling
  await keyringStore(oauthKey, JSON.stringify(tokenData));

  log.debug(` Stored OAuth token for ${integrationType} account ${accountId}`);
}

/**
 * Get the full OAuth token data for an account (including refresh token and expiry)
 */
export async function getAccountOAuthToken(
  integrationType: IntegrationType,
  accountId: string
): Promise<OAuthTokenData | null> {
  const key = getAccountCredentialKey(integrationType, accountId);
  const oauthKey = `${key}_oauth`;

  const data = await keyringGet(oauthKey);
  if (!data) {
    // Fall back to just the access token if no OAuth data exists
    const accessToken = await keyringGet(key);
    if (accessToken) {
      return { accessToken };
    }
    return null;
  }

  try {
    return JSON.parse(data) as OAuthTokenData;
  } catch {
    log.warn(` Failed to parse OAuth token data for ${integrationType} account ${accountId}`);
    return null;
  }
}

/**
 * Check if an OAuth token needs refresh (within 5 minutes of expiry)
 */
export async function isOAuthTokenExpiring(
  integrationType: IntegrationType,
  accountId: string
): Promise<boolean> {
  const tokenData = await getAccountOAuthToken(integrationType, accountId);
  if (!tokenData?.expiresAt) {
    return false; // No expiry data, assume token is valid
  }

  // Check if token expires within 5 minutes
  const fiveMinutes = 5 * 60 * 1000;
  return Date.now() > tokenData.expiresAt - fiveMinutes;
}

/**
 * Get a valid access token for an account, transparently refreshing it first if
 * it is an OAuth token within 5 minutes of expiry. The rotated bundle (access +
 * refresh + expiry) is persisted so subsequent calls reuse it.
 *
 * Falls back to the stored access token when there is no refresh token or the
 * refresh fails, so callers still get something to try. Non-OAuth (PAT) accounts
 * return their stored token unchanged.
 *
 * @param provider OAuth provider used for the refresh grant (e.g. 'azure').
 * @param instanceUrl Optional instance/tenant forwarded to the refresh endpoint.
 */
export async function getFreshAccountToken(
  integrationType: IntegrationType,
  accountId: string,
  provider: OAuthProvider,
  instanceUrl?: string
): Promise<string | null> {
  const bundle = await getAccountOAuthToken(integrationType, accountId);
  // No OAuth bundle (PAT / legacy) — return the plain stored token.
  if (!bundle) {
    return getAccountToken(integrationType, accountId);
  }
  // Compute expiry inline from the bundle we already have (avoid a second read).
  const fiveMinutes = 5 * 60 * 1000;
  const expiring = bundle.expiresAt ? Date.now() > bundle.expiresAt - fiveMinutes : false;
  // Fresh enough, or nothing to refresh with — use the stored access token.
  if (!bundle.refreshToken || !expiring) {
    return bundle.accessToken;
  }

  // Single-flight per account: concurrent callers (e.g. a git push and the
  // background token validator) share one refresh so rotated refresh tokens
  // aren't lost to an overwrite.
  const inFlightKey = `${integrationType}:${accountId}`;
  const existing = inFlightTokenRefreshes.get(inFlightKey);
  if (existing) return existing;

  const refreshTokenValue = bundle.refreshToken;
  const fallbackToken = bundle.accessToken;
  const refreshPromise = (async (): Promise<string | null> => {
    try {
      const { refreshToken: refreshOAuthToken } = await import('./oauth.service.ts');
      const refreshed = await refreshOAuthToken(provider, refreshTokenValue, instanceUrl);
      // The stored credential may have changed while the refresh was in flight:
      // setToken (a PAT / app password saved over this account) retires the OAuth
      // bundle, and deleteToken removes it outright. Persisting the rotated bundle
      // now would recreate the blob and overwrite the main key, resurrecting the
      // OAuth credential the user just superseded or deleted. Only write back when
      // the bundle we refreshed from is still the one on disk.
      const current = await getAccountOAuthToken(integrationType, accountId);
      if (current?.refreshToken !== refreshTokenValue) {
        log.debug(
          ` Discarding refreshed OAuth token for ${integrationType} account ${accountId}; the stored credential changed mid-refresh`
        );
        return getAccountToken(integrationType, accountId);
      }
      await storeAccountOAuthToken(
        integrationType,
        accountId,
        refreshed.accessToken,
        // Entra rotates refresh tokens; keep the previous one if none was returned.
        refreshed.refreshToken ?? refreshTokenValue,
        refreshed.expiresIn
      );
      log.debug(` Refreshed OAuth token for ${integrationType} account ${accountId}`);
      return refreshed.accessToken;
    } catch (err) {
      log.warn(
        ` OAuth token refresh failed for ${integrationType} account ${accountId}; using existing token`,
        err
      );
      return fallbackToken;
    } finally {
      inFlightTokenRefreshes.delete(inFlightKey);
    }
  })();
  inFlightTokenRefreshes.set(inFlightKey, refreshPromise);
  return refreshPromise;
}

/** In-flight OAuth refreshes keyed by `${integrationType}:${accountId}` (single-flight). */
const inFlightTokenRefreshes = new Map<string, Promise<string | null>>();

// ========================================================================
// GitHub App Installation
// ========================================================================

export interface GitHubAppConfig {
  appId: number;
  installationId: number;
}

export interface AppInstallation {
  id: number;
  account: { login: string; id: number; type: string; avatarUrl: string | null };
  appId: number;
  targetType: string;
}

export async function configureGitHubApp(
  appId: number,
  privateKeyPem: string,
  installationId: number,
): Promise<GitHubConnectionStatus> {
  const result = await invokeCommand<GitHubConnectionStatus>('configure_github_app', {
    appId,
    privateKeyPem,
    installationId,
  });
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to configure GitHub App');
  }
  return result.data;
}

export async function getGitHubAppConfig(): Promise<GitHubAppConfig | null> {
  const result = await invokeCommand<GitHubAppConfig | null>('get_github_app_config');
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to get GitHub App config');
  }
  return result.data ?? null;
}

export async function removeGitHubAppConfig(): Promise<void> {
  const result = await invokeCommand<void>('remove_github_app_config');
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to remove GitHub App config');
  }
}

export async function listGitHubAppInstallations(
  appId: number,
  privateKeyPem: string,
): Promise<AppInstallation[]> {
  const result = await invokeCommand<AppInstallation[]>('list_github_app_installations', { appId, privateKeyPem });
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to list GitHub App installations');
  }
  return result.data ?? [];
}

// ========================================================================
// Git Credential Manager Detection
// ========================================================================

export interface CredentialManagerStatus {
  gcmAvailable: boolean;
  gcmVersion: string | null;
  configuredHelper: string | null;
  usingGitnadoFallback: boolean;
}

export async function detectCredentialManager(
  repoPath: string,
): Promise<CredentialManagerStatus> {
  const result = await invokeCommand<CredentialManagerStatus>('detect_credential_manager', { path: repoPath });
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to detect credential manager');
  }
  return result.data!;
}
