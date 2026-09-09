/**
 * Unified Profile Service (v3)
 * Provides operations for managing unified profiles (git identity) and global integration accounts
 *
 * Architecture (v3):
 * - Profiles contain git identity + default account preferences
 * - Accounts are GLOBAL - available to all profiles, not owned by profiles
 */

import { invokeCommand } from './tauri-api.ts';
import { unifiedProfileStore } from '../stores/unified-profile.store.ts';
import { AccountCredentials } from './credential.service.ts';
import {
  checkAdoConnectionWithToken,
  checkBitbucketConnectionWithToken,
  checkGitHubConnectionWithToken,
  checkGitLabConnectionWithToken,
} from './git.service.ts';
import { loggers } from '../utils/logger.ts';

const log = loggers.profile;
import type {
  UnifiedProfile,
  UnifiedProfilesConfig,
  IntegrationAccount,
  CurrentGitIdentity,
  SaveProfileResult,
  MigrationPreview,
  MigrationBackupInfo,
  UnifiedMigrationResult,
  IntegrationType,
  CachedUser,
} from '../types/unified-profile.types.ts';

// =============================================================================
// Profile CRUD Operations
// =============================================================================

/**
 * Get the unified profiles configuration
 */
export async function getUnifiedProfilesConfig(): Promise<UnifiedProfilesConfig> {
  const result = await invokeCommand<UnifiedProfilesConfig>('get_unified_profiles_config', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get unified profiles config');
  }
  return result.data!;
}

/**
 * Get all unified profiles
 */
export async function getUnifiedProfiles(): Promise<UnifiedProfile[]> {
  const result = await invokeCommand<UnifiedProfile[]>('get_unified_profiles', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get unified profiles');
  }
  return result.data!;
}

/**
 * Get a single unified profile by ID
 */
export async function getUnifiedProfile(profileId: string): Promise<UnifiedProfile | null> {
  const result = await invokeCommand<UnifiedProfile | null>('get_unified_profile', {
    profileId,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get unified profile');
  }
  return result.data!;
}

/**
 * Save a unified profile (create or update)
 *
 * The backend also re-applies the identity to every repository assigned to this
 * profile; repositories it could not rewrite come back in `failedRepositories`.
 */
export async function saveUnifiedProfile(profile: UnifiedProfile): Promise<SaveProfileResult> {
  const result = await invokeCommand<SaveProfileResult>('save_unified_profile', { profile });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to save unified profile');
  }

  // Update store
  const { profile: saved, failedRepositories } = result.data!;
  const store = unifiedProfileStore.getState();
  const existingProfile = store.profiles.find((p) => p.id === saved.id);
  if (existingProfile) {
    store.updateProfile(saved);
  } else {
    store.addProfile(saved);
  }

  // The Rust backend clears isDefault on all OTHER profiles when one is saved as
  // default, but the store only knows about the single saved entry. Mirror the
  // backend so stale "Default" badges disappear immediately without a full
  // loadUnifiedProfiles() reload.
  if (saved.isDefault) {
    for (const p of unifiedProfileStore.getState().profiles) {
      if (p.id !== saved.id && p.isDefault) {
        unifiedProfileStore.getState().updateProfile({ ...p, isDefault: false });
      }
    }
  }

  return { profile: saved, failedRepositories };
}

/**
 * Delete a unified profile
 */
export async function deleteUnifiedProfile(profileId: string): Promise<void> {
  const result = await invokeCommand<void>('delete_unified_profile', { profileId });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to delete unified profile');
  }

  // Update store
  unifiedProfileStore.getState().removeProfile(profileId);
}

/**
 * Set a profile as the default
 */
export async function setDefaultUnifiedProfile(profileId: string): Promise<void> {
  const result = await invokeCommand<void>('set_default_unified_profile', { profileId });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to set default profile');
  }

  // Update store - mark the profile as default and unmark others
  const { profiles, updateProfile } = unifiedProfileStore.getState();
  for (const profile of profiles) {
    if (profile.isDefault !== (profile.id === profileId)) {
      updateProfile({ ...profile, isDefault: profile.id === profileId });
    }
  }
}

// =============================================================================
// Global Account Operations (v3)
// =============================================================================

/**
 * Get all global accounts
 */
export async function getGlobalAccounts(): Promise<IntegrationAccount[]> {
  const result = await invokeCommand<IntegrationAccount[]>('get_global_accounts', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get global accounts');
  }
  return result.data!;
}

/**
 * Get global accounts by integration type
 */
export async function getGlobalAccountsByType(
  integrationType: IntegrationType
): Promise<IntegrationAccount[]> {
  const result = await invokeCommand<IntegrationAccount[]>('get_global_accounts_by_type', {
    integrationType,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get accounts by type');
  }
  return result.data!;
}

/**
 * Get a single global account by ID
 */
export async function getGlobalAccount(accountId: string): Promise<IntegrationAccount | null> {
  const result = await invokeCommand<IntegrationAccount | null>('get_global_account', {
    accountId,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get account');
  }
  return result.data!;
}

/**
 * Save a global account (create or update)
 */
export async function saveGlobalAccount(account: IntegrationAccount): Promise<IntegrationAccount> {
  const result = await invokeCommand<IntegrationAccount>('save_global_account', { account });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to save account');
  }

  // Update store
  const saved = result.data!;
  const store = unifiedProfileStore.getState();
  const existingAccount = store.accounts.find((a) => a.id === saved.id);
  if (existingAccount) {
    store.updateAccount(saved);
  } else {
    store.addAccount(saved);
  }

  // The Rust backend clears isDefault on all OTHER accounts of the same
  // integration type when one is saved as default. The store only updated the
  // single saved entry, so mirror the backend here to keep "Default" badges in
  // sync without a full loadUnifiedProfiles() reload.
  if (saved.isDefault) {
    for (const a of unifiedProfileStore.getState().accounts) {
      if (a.id !== saved.id && a.integrationType === saved.integrationType && a.isDefault) {
        unifiedProfileStore.getState().updateAccount({ ...a, isDefault: false });
      }
    }
  }

  return saved;
}

/**
 * Delete a global account
 */
export async function deleteGlobalAccount(accountId: string): Promise<void> {
  const result = await invokeCommand<void>('delete_global_account', { accountId });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to delete account');
  }

  // Update store
  unifiedProfileStore.getState().removeAccount(accountId);
}

/**
 * Set the default global account for an integration type
 */
export async function setDefaultGlobalAccount(
  integrationType: IntegrationType,
  accountId: string
): Promise<void> {
  const result = await invokeCommand<void>('set_default_global_account', {
    integrationType,
    accountId,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to set default account');
  }

  // Reload accounts to get updated defaults
  await loadUnifiedProfiles();
}

/**
 * Set the default account for a profile (profile preference)
 */
export async function setProfileDefaultAccount(
  profileId: string,
  integrationType: IntegrationType,
  accountId: string
): Promise<void> {
  const result = await invokeCommand<void>('set_profile_default_account', {
    profileId,
    integrationType,
    accountId,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to set profile default account');
  }

  // Update profile in store
  const { profiles, updateProfile } = unifiedProfileStore.getState();
  const profile = profiles.find((p) => p.id === profileId);
  if (profile) {
    updateProfile({
      ...profile,
      defaultAccounts: { ...profile.defaultAccounts, [integrationType]: accountId },
    });
  }
}

/**
 * Remove the default account preference for a profile
 */
export async function removeProfileDefaultAccount(
  profileId: string,
  integrationType: IntegrationType
): Promise<void> {
  const result = await invokeCommand<void>('remove_profile_default_account', {
    profileId,
    integrationType,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to remove profile default account');
  }

  // Update profile in store
  const { profiles, updateProfile } = unifiedProfileStore.getState();
  const profile = profiles.find((p) => p.id === profileId);
  if (profile) {
    const defaultAccounts = { ...profile.defaultAccounts };
    delete defaultAccounts[integrationType];
    updateProfile({ ...profile, defaultAccounts });
  }
}

/**
 * Update cached user info for a global account
 */
export async function updateGlobalAccountCachedUser(
  accountId: string,
  user: CachedUser
): Promise<void> {
  const result = await invokeCommand<void>('update_global_account_cached_user', {
    accountId,
    user,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to update cached user');
  }

  // V7: Update only the single account in the store instead of reloading the
  // entire config. Callers like validateAllAccountTokens loop over every
  // account, so a full reload here was O(N) full config reloads.
  const { accounts, updateAccount } = unifiedProfileStore.getState();
  const existing = accounts.find((a) => a.id === accountId);
  if (existing) {
    updateAccount({ ...existing, cachedUser: user });
  }
}

/**
 * V5: Tauri wrapper (scope: "fetch" — round-trips to the backend).
 * Get the profile's preferred account for an integration type.
 * Renamed from getProfilePreferredAccount to disambiguate from the store
 * selector (selectProfilePreferredAccount) and pure helper
 * (resolveProfilePreferredAccount).
 */
export async function fetchProfilePreferredAccount(
  profileId: string,
  integrationType: IntegrationType
): Promise<IntegrationAccount | null> {
  const result = await invokeCommand<IntegrationAccount | null>('get_profile_preferred_account', {
    profileId,
    integrationType,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get preferred account');
  }
  return result.data!;
}

/**
 * V5: Tauri wrapper (scope: "fetch" — round-trips to the backend).
 * Resolve the preferred account for a repository, accounting for account-level
 * URL patterns.
 *
 * Precedence (most repo-specific first):
 * 1. An account of `integrationType` whose `urlPatterns` match `repoUrl`.
 * 2. The profile's explicit default account for the type.
 * 3. The global default account for the type.
 */
export async function fetchRepositoryPreferredAccount(
  profileId: string,
  integrationType: IntegrationType,
  repoUrl: string | null
): Promise<IntegrationAccount | null> {
  const result = await invokeCommand<IntegrationAccount | null>(
    'get_repository_preferred_account',
    {
      profileId,
      integrationType,
      repoUrl,
    }
  );
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get repository preferred account');
  }
  return result.data!;
}

// =============================================================================
// Profile Detection and Assignment
// =============================================================================

/**
 * Detect which profile should be used for a repository based on URL patterns
 */
export async function detectUnifiedProfileForRepository(
  path: string
): Promise<UnifiedProfile | null> {
  const result = await invokeCommand<UnifiedProfile | null>(
    'detect_unified_profile_for_repository',
    { path }
  );
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to detect profile');
  }
  return result.data!;
}

/**
 * Get the assigned profile for a repository
 */
export async function getAssignedUnifiedProfile(path: string): Promise<UnifiedProfile | null> {
  const result = await invokeCommand<UnifiedProfile | null>('get_assigned_unified_profile', {
    path,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get assigned profile');
  }
  return result.data!;
}

/**
 * Manually assign a profile to a repository
 */
export async function assignUnifiedProfileToRepository(
  path: string,
  profileId: string
): Promise<void> {
  const result = await invokeCommand<void>('assign_unified_profile_to_repository', {
    path,
    profileId,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to assign profile');
  }
}

/**
 * Remove profile assignment from a repository
 */
export async function unassignUnifiedProfileFromRepository(path: string): Promise<void> {
  const result = await invokeCommand<void>('unassign_unified_profile_from_repository', { path });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to unassign profile');
  }
}

/**
 * Apply a profile to a repository (set git config)
 */
export async function applyUnifiedProfile(path: string, profileId: string): Promise<void> {
  const result = await invokeCommand<void>('apply_unified_profile', { path, profileId });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to apply profile');
  }

  // The Rust command also persists the repo→profile assignment
  // (config.assign_profile). Mirror it here — must run AFTER the success check
  // so a rejected apply never records an assignment the backend did not save —
  // otherwise the dashboard's "Manually assigned" badge and the profile
  // manager's assigned-repository list stay stale until the next full
  // loadUnifiedProfiles().
  unifiedProfileStore.getState().setRepositoryAssignment(path, profileId);

  // Update active profile in store
  const profile = unifiedProfileStore.getState().profiles.find((p) => p.id === profileId);
  if (profile) {
    unifiedProfileStore.getState().setActiveProfile(profile);
  }
}

/**
 * Get the current git identity for a repository
 */
export async function getCurrentGitIdentity(path: string): Promise<CurrentGitIdentity> {
  const result = await invokeCommand<CurrentGitIdentity>('get_current_git_identity', { path });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get current identity');
  }
  return result.data!;
}

// =============================================================================
// Repository Account Helpers
// =============================================================================

/**
 * Get account for a repository by integration type (from the assigned/detected profile)
 */
export async function getRepositoryAccount(
  path: string,
  integrationType: IntegrationType
): Promise<IntegrationAccount | null> {
  const result = await invokeCommand<IntegrationAccount | null>('get_repository_account', {
    path,
    integrationType,
  });
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get repository account');
  }
  return result.data!;
}

// =============================================================================
// Migration Operations
// =============================================================================

/**
 * Check if migration to unified profiles is needed
 */
export async function needsUnifiedProfilesMigration(): Promise<boolean> {
  const result = await invokeCommand<boolean>('needs_unified_profiles_migration', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to check migration status');
  }
  return result.data!;
}

/**
 * Preview migration - shows how accounts would be matched to profiles
 */
export async function previewUnifiedProfilesMigration(): Promise<MigrationPreview> {
  const result = await invokeCommand<MigrationPreview>('preview_unified_profiles_migration', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to preview migration');
  }
  return result.data!;
}

/**
 * Execute migration with custom account-to-profile assignments
 */
export async function executeUnifiedProfilesMigration(
  accountAssignments: Record<string, string> // account_id -> profile_id
): Promise<UnifiedMigrationResult> {
  const result = await invokeCommand<UnifiedMigrationResult>(
    'execute_unified_profiles_migration',
    { accountAssignments }
  );
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to execute migration');
  }

  // Reload profiles after migration
  await loadUnifiedProfiles();

  return result.data!;
}

/**
 * Get information about the migration backup (for rollback)
 */
export async function getMigrationBackupInfo(): Promise<MigrationBackupInfo> {
  const result = await invokeCommand<MigrationBackupInfo>('get_migration_backup_info', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to get backup info');
  }
  return result.data!;
}

/**
 * Restore from migration backup (rollback to pre-migration state)
 * This will remove the unified profiles config and restore the legacy files
 */
export async function restoreMigrationBackup(): Promise<MigrationBackupInfo> {
  const result = await invokeCommand<MigrationBackupInfo>('restore_migration_backup', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to restore backup');
  }

  // Reset the store since we've rolled back
  unifiedProfileStore.getState().reset();

  // Check migration status again (should now need migration)
  await checkMigrationNeeded();

  return result.data!;
}

/**
 * Delete migration backup files (after user confirms rollback is not needed)
 */
export async function deleteMigrationBackup(): Promise<void> {
  const result = await invokeCommand('delete_migration_backup', {});
  if (!result.success) {
    throw new Error(result.error?.message || 'Failed to delete backup');
  }
}

// =============================================================================
// Store Loading Functions
// =============================================================================

/**
 * Load unified profiles and update the store
 */
export async function loadUnifiedProfiles(): Promise<void> {
  const store = unifiedProfileStore.getState();
  store.setLoading(true);

  // V6: Always clear loading via finally so a rejected getUnifiedProfilesConfig()
  // can never leave the store stuck in the loading state. On error we still set
  // the error message (consistent with sibling loaders).
  try {
    const config = await getUnifiedProfilesConfig();
    store.setConfig(config);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to load profiles');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Load the profile for a specific repository and set it as active
 * Falls back to default profile if no specific assignment exists
 */
export async function loadUnifiedProfileForRepository(path: string): Promise<void> {
  const store = unifiedProfileStore.getState();
  store.setCurrentRepositoryPath(path);

  try {
    let profile = await getAssignedUnifiedProfile(path);

    // If no profile is assigned, fall back to default or first profile
    if (!profile) {
      const { profiles } = store;
      profile = profiles.find(p => p.isDefault) || profiles[0] || null;
    }

    store.setActiveProfile(profile);
  } catch (error) {
    log.error('Failed to load profile for repository:', error);
    store.setActiveProfile(null);
  }
}

/**
 * Check if migration is needed and update store
 */
export async function checkMigrationNeeded(): Promise<boolean> {
  try {
    const needs = await needsUnifiedProfilesMigration();
    unifiedProfileStore.getState().setNeedsMigration(needs);
    return needs;
  } catch (error) {
    log.error('Failed to check migration status:', error);
    return false;
  }
}

/**
 * Initialize unified profiles - load config and check migration
 */
export async function initializeUnifiedProfiles(): Promise<void> {
  const store = unifiedProfileStore.getState();
  store.setLoading(true);

  try {
    // Check if migration is needed first
    const needsMigration = await checkMigrationNeeded();

    if (!needsMigration) {
      // Load existing unified profiles
      await loadUnifiedProfiles();

      // Validate all account tokens and update connection status in background (don't await)
      validateAllAccountTokens().catch((error) => {
        log.error('Failed to validate account tokens:', error);
      });
    }

    store.setLoading(false);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to initialize profiles');
  }
}

// =============================================================================
// Cached User Refresh (v3 - Global Accounts)
// =============================================================================

/**
 * Refresh cached user info for a single global account
 * Returns the updated CachedUser or null if unable to fetch
 */
export async function refreshAccountCachedUser(
  account: IntegrationAccount
): Promise<CachedUser | null> {
  const store = unifiedProfileStore.getState();

  try {
    // Get the token for this account. For OAuth accounts, refresh an expiring
    // access token first — otherwise the short expiry (~1h Entra, ~2h GitLab /
    // Bitbucket) makes this path (periodic validation, "Refresh account", the
    // profile manager) mark the account disconnected even though a valid
    // refresh token exists.
    let token: string | null;
    const { getFreshAccountToken } = await import('./credential.service.ts');
    switch (account.integrationType) {
      case 'github':
        token = await getFreshAccountToken('github', account.id, 'github');
        break;
      case 'azure-devops':
        token = await getFreshAccountToken('azure-devops', account.id, 'azure');
        break;
      case 'gitlab':
        token = await getFreshAccountToken(
          'gitlab',
          account.id,
          'gitlab',
          account.config.type === 'gitlab' ? account.config.instanceUrl : undefined
        );
        break;
      case 'bitbucket':
        token = await getFreshAccountToken('bitbucket', account.id, 'bitbucket');
        break;
      default:
        token = await AccountCredentials.getToken(account.integrationType, account.id);
    }
    if (!token) {
      log.debug(` No token for account ${account.id}, skipping refresh`);
      store.setAccountConnectionStatus(account.id, 'disconnected');
      return null;
    }

    // Mark as checking
    store.setAccountConnectionStatus(account.id, 'checking');

    let cachedUser: CachedUser | null = null;
    let isConnected = false;

    switch (account.integrationType) {
      case 'github': {
        const result = await checkGitHubConnectionWithToken(token);
        if (result.success && result.data?.connected && result.data.user) {
          isConnected = true;
          cachedUser = {
            username: result.data.user.login,
            displayName: result.data.user.name,
            avatarUrl: result.data.user.avatarUrl,
            email: result.data.user.email,
          };
        }
        break;
      }
      case 'gitlab': {
        // Through the gated wrapper, like the GitHub branch above: this runs
        // unattended every five minutes, and offline mode (or an allowlist that
        // does not name this instance) has to stop it here rather than leave the
        // Rust backstop as the only thing between a background timer and the
        // network.
        const instanceUrl = account.config.type === 'gitlab' ? account.config.instanceUrl : 'https://gitlab.com';
        const result = await checkGitLabConnectionWithToken(instanceUrl, token);
        if (result.success && result.data?.connected && result.data.user) {
          isConnected = true;
          cachedUser = {
            username: result.data.user.username,
            displayName: result.data.user.name,
            avatarUrl: result.data.user.avatarUrl,
            // GitLab's user payload carries no email (`gitlab.rs:102`); the
            // inline type this used to declare claimed one, so this field was
            // always undefined.
            email: null,
          };
        }
        break;
      }
      case 'azure-devops': {
        const organization = account.config.type === 'azure-devops' ? account.config.organization : '';
        if (organization) {
          const result = await checkAdoConnectionWithToken(organization, token);
          if (result.success && result.data?.connected && result.data.user) {
            isConnected = true;
            cachedUser = {
              username: result.data.user.uniqueName?.split('@')[0] || organization,
              displayName: result.data.user.displayName || null,
              avatarUrl: null,
              email: result.data.user.uniqueName || null,
            };
            // Token verified for this org — keep the keyring git credential fresh
            // too, so external git push/pull work after a background refresh even
            // without an in-app git operation. (token is non-null here.)
            const { syncAdoGitCredentials } = await import('./git.service.ts');
            await syncAdoGitCredentials(organization, token);
          }
        }
        break;
      }
      case 'bitbucket': {
        const result = await checkBitbucketConnectionWithToken(token);
        if (result.success && result.data?.connected && result.data.user) {
          isConnected = true;
          cachedUser = {
            username: result.data.user.username,
            displayName: result.data.user.displayName,
            avatarUrl: result.data.user.avatarUrl || null,
            email: null, // Bitbucket API doesn't return email in user endpoint
          };
        }
        break;
      }
      case 'oidc': {
        // OIDC has no cheap server-side identity ping (the id_token is decoded
        // once at sign-in and cached). Treat the presence of a stored token as
        // "connected" and keep the existing cachedUser rather than wiping it.
        // We already early-returned 'disconnected' above when no token exists,
        // so reaching here means a token is present.
        isConnected = true;
        cachedUser = account.cachedUser;
        break;
      }
    }

    // Update connection status
    store.setAccountConnectionStatus(account.id, isConnected ? 'connected' : 'disconnected');

    // If we got user info, update it in the store
    if (cachedUser) {
      await updateGlobalAccountCachedUser(account.id, cachedUser);
      log.debug(` Refreshed cached user for ${account.integrationType} account ${account.id}: @${cachedUser.username}`);
    }

    return cachedUser;
  } catch (error) {
    log.error(` Failed to refresh cached user for account ${account.id}:`, error);
    store.setAccountConnectionStatus(account.id, 'disconnected');
    return null;
  }
}

// =============================================================================
// Periodic Token Validation
// =============================================================================

let tokenValidationInterval: ReturnType<typeof setInterval> | null = null;
const TOKEN_VALIDATION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

/**
 * Validate all account tokens and update connection status
 * Returns accounts that have become disconnected
 */
export async function validateAllAccountTokens(): Promise<{
  valid: number;
  invalid: number;
  invalidAccounts: Array<{ accountName: string; integrationType: string }>;
}> {
  const accounts = unifiedProfileStore.getState().accounts;
  const result = {
    valid: 0,
    invalid: 0,
    invalidAccounts: [] as Array<{ accountName: string; integrationType: string }>,
  };

  log.debug('Validating all account tokens');

  for (const account of accounts) {
    await refreshAccountCachedUser(account);
    // Tally on the authoritative connection status that refreshAccountCachedUser
    // just wrote, NOT on the returned cachedUser. An OIDC account with a stored
    // token but no cachedUser is marked 'connected' (there's no cheap identity
    // ping for OIDC) yet returns null — counting that as invalid was a false
    // negative. Using the status keeps the tally consistent across all providers.
    const status = unifiedProfileStore.getState().accountConnectionStatus[account.id]?.status;
    if (status === 'connected') {
      result.valid++;
    } else {
      result.invalid++;
      result.invalidAccounts.push({
        accountName: account.name,
        integrationType: account.integrationType,
      });
    }
  }

  log.debug(`Token validation complete: ${result.valid} valid, ${result.invalid} invalid`);
  return result;
}

/**
 * Start periodic token validation
 * Will check tokens at regular intervals and update connection status
 */
export function startPeriodicTokenValidation(): void {
  if (tokenValidationInterval) {
    return; // Already running
  }

  log.debug('Starting periodic token validation');

  // Run validation periodically
  tokenValidationInterval = setInterval(async () => {
    await validateAllAccountTokens();
  }, TOKEN_VALIDATION_INTERVAL_MS);
}

/**
 * Stop periodic token validation
 */
export function stopPeriodicTokenValidation(): void {
  if (tokenValidationInterval) {
    clearInterval(tokenValidationInterval);
    tokenValidationInterval = null;
    log.debug('Stopped periodic token validation');
  }
}

// =============================================================================
// Deprecated Functions (kept for backward compatibility)
// =============================================================================

/**
 * @deprecated Use saveGlobalAccount instead
 */
export async function addAccountToProfile(
  _profileId: string,
  account: IntegrationAccount
): Promise<IntegrationAccount> {
  return saveGlobalAccount(account);
}

/**
 * @deprecated Use saveGlobalAccount instead
 */
export async function updateAccountInProfile(
  _profileId: string,
  account: IntegrationAccount
): Promise<IntegrationAccount> {
  return saveGlobalAccount(account);
}

/**
 * @deprecated Use deleteGlobalAccount instead
 */
export async function removeAccountFromProfile(
  _profileId: string,
  accountId: string
): Promise<void> {
  return deleteGlobalAccount(accountId);
}

/**
 * @deprecated Use setProfileDefaultAccount instead
 */
export async function setDefaultAccountInProfile(
  profileId: string,
  accountId: string
): Promise<void> {
  // Get the account to find its type
  const account = unifiedProfileStore.getState().accounts.find((a) => a.id === accountId);
  if (account) {
    return setProfileDefaultAccount(profileId, account.integrationType, accountId);
  }
}

/**
 * @deprecated Use updateGlobalAccountCachedUser instead
 */
export async function updateProfileAccountCachedUser(
  _profileId: string,
  accountId: string,
  user: CachedUser
): Promise<void> {
  return updateGlobalAccountCachedUser(accountId, user);
}
