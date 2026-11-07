import { invokeCommand } from "../tauri-api.ts";
import { commitSignatureCache, createCacheKey } from "../cache.service.ts";
import * as unifiedProfileService from "../unified-profile.service.ts";
import type {
  CommandResult,
} from "../../types/api.types.ts";
import {
  blockedResult,
  checkNetworkPermission,
  invokeProviderCommand,
  surfaceBackendRefusal,
} from "./shared.ts";

/**
 * GPG operations
 */
export interface GpgKey {
  keyId: string;
  keyIdLong: string;
  userId: string;
  email: string;
  created: string | null;
  expires: string | null;
  isSigningKey: boolean;
  keyType: string;
  keySize: number;
  trust: string;
}

export interface GpgConfig {
  gpgAvailable: boolean;
  gpgVersion: string | null;
  signingKey: string | null;
  signCommits: boolean;
  signTags: boolean;
  gpgProgram: string | null;
  /** Signature format (gpg.format): "openpgp" (default), "ssh", or "x509". */
  gpgFormat: string | null;
}

export interface CommitSignature {
  signed: boolean;
  status: string | null;
  keyId: string | null;
  signer: string | null;
  valid: boolean;
  trust: string | null;
}

export async function getGpgConfig(
  repoPath: string,
): Promise<CommandResult<GpgConfig>> {
  return invokeCommand<GpgConfig>("get_gpg_config", { path: repoPath });
}

export async function getGpgKeys(
  repoPath: string,
): Promise<CommandResult<GpgKey[]>> {
  return invokeCommand<GpgKey[]>("get_gpg_keys", { path: repoPath });
}

export async function setSigningKey(
  repoPath: string,
  keyId: string | null,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_signing_key", {
    path: repoPath,
    keyId,
    global,
  });
}

export async function setCommitSigning(
  repoPath: string,
  enabled: boolean,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_commit_signing", {
    path: repoPath,
    enabled,
    global,
  });
}

export async function setTagSigning(
  repoPath: string,
  enabled: boolean,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_tag_signing", {
    path: repoPath,
    enabled,
    global,
  });
}

export async function getCommitsSignatures(
  repoPath: string,
  commitOids: string[],
): Promise<CommandResult<Array<[string, CommitSignature]>>> {
  // Check cache for already-fetched signatures
  const cachedSigs: Array<[string, CommitSignature]> = [];
  const uncachedOids: string[] = [];

  for (const oid of commitOids) {
    const cacheKey = createCacheKey(repoPath, oid);
    const cached = commitSignatureCache.get(cacheKey);
    if (cached) {
      cachedSigs.push([oid, cached as CommitSignature]);
    } else {
      uncachedOids.push(oid);
    }
  }

  // If all are cached, return immediately
  if (uncachedOids.length === 0) {
    return { success: true, data: cachedSigs };
  }

  // Fetch uncached signatures
  const result = await invokeCommand<Array<[string, CommitSignature]>>(
    "get_commits_signatures",
    {
      path: repoPath,
      commitOids: uncachedOids,
    },
  );

  if (!result.success || !result.data) {
    // Return cached ones even if fetch fails
    if (cachedSigs.length > 0) {
      return { success: true, data: cachedSigs };
    }
    return result;
  }

  // Cache the new signatures
  for (const [oid, sig] of result.data) {
    const cacheKey = createCacheKey(repoPath, oid);
    commitSignatureCache.set(cacheKey, sig);
  }

  // Combine cached and newly fetched
  return {
    success: true,
    data: [...cachedSigs, ...result.data],
  };
}

/**
 * Signing status for a repository - indicates if signing is configured and available
 */
export interface SigningStatus {
  /** Whether commit signing is enabled (commit.gpgsign = true) */
  gpgSignEnabled: boolean;
  /** The configured signing key (user.signingkey) */
  signingKey: string | null;
  /** The configured GPG program (gpg.program) */
  gpgProgram: string | null;
  /** Whether signing is possible (GPG available and key configured) */
  canSign: boolean;
}

/**
 * Get signing status for a repository
 * @param repoPath Repository path
 * @returns SigningStatus indicating if signing is enabled and possible
 */
export async function getSigningStatus(
  repoPath: string,
): Promise<CommandResult<SigningStatus>> {
  return invokeCommand<SigningStatus>("get_signing_status", { path: repoPath });
}

// ============================================================================
// SSH Key Management
// ============================================================================

export interface SshKey {
  name: string;
  path: string;
  publicPath: string;
  keyType: string;
  fingerprint: string | null;
  comment: string | null;
  publicKey: string | null;
}

export interface SshConfig {
  sshAvailable: boolean;
  sshVersion: string | null;
  sshDir: string;
  gitSshCommand: string | null;
}

export interface SshTestResult {
  success: boolean;
  host: string;
  message: string;
  username: string | null;
}

export async function getSshConfig(): Promise<CommandResult<SshConfig>> {
  return invokeCommand<SshConfig>("get_ssh_config", {});
}

export async function getSshKeys(): Promise<CommandResult<SshKey[]>> {
  return invokeCommand<SshKey[]>("get_ssh_keys", {});
}

export async function generateSshKey(
  keyType: string,
  email: string,
  filename?: string,
  passphrase?: string,
): Promise<CommandResult<SshKey>> {
  return invokeCommand<SshKey>("generate_ssh_key", {
    keyType,
    email,
    filename,
    passphrase,
  });
}

export async function testSshConnection(
  host: string,
): Promise<CommandResult<SshTestResult>> {
  return invokeProviderCommand<SshTestResult>("test_ssh_connection", { host });
}

export async function addKeyToAgent(
  keyPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("add_key_to_agent", { keyPath });
}

export async function listAgentKeys(): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("list_agent_keys", {});
}

export async function getPublicKeyContent(
  keyName: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_public_key_content", { keyName });
}

export async function deleteSshKey(
  keyName: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_ssh_key", { keyName });
}

// ============================================================================
// Git Configuration
// ============================================================================

export interface ConfigEntry {
  key: string;
  value: string;
  scope: string;
}

export interface GitAlias {
  name: string;
  command: string;
  isGlobal: boolean;
}

export interface UserIdentity {
  name: string | null;
  email: string | null;
  nameIsGlobal: boolean;
  emailIsGlobal: boolean;
}

export async function getConfigValue(
  path: string | null,
  key: string,
  global?: boolean,
): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>("get_config_value", {
    path,
    key,
    global,
  });
}

export async function setConfigValue(
  path: string | null,
  key: string,
  value: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_config_value", { path, key, value, global });
}

export async function unsetConfigValue(
  path: string | null,
  key: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unset_config_value", { path, key, global });
}

export async function getConfigList(
  path: string | null,
  global?: boolean,
): Promise<CommandResult<ConfigEntry[]>> {
  return invokeCommand<ConfigEntry[]>("get_config_list", { path, global });
}

export async function getUserIdentity(
  path: string,
): Promise<CommandResult<UserIdentity>> {
  return invokeCommand<UserIdentity>("get_user_identity", { path });
}

export async function setUserIdentity(
  path: string | null,
  name: string | null,
  email: string | null,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_user_identity", {
    path,
    name,
    email,
    global,
  });
}

export async function getAliases(
  path?: string,
): Promise<CommandResult<GitAlias[]>> {
  return invokeCommand<GitAlias[]>("get_aliases", { path });
}

export async function setAlias(
  path: string | null,
  name: string,
  command: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_alias", { path, name, command, global });
}

export async function deleteAlias(
  path: string | null,
  name: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_alias", { path, name, global });
}

export async function getCommonSettings(
  path: string,
): Promise<CommandResult<ConfigEntry[]>> {
  return invokeCommand<ConfigEntry[]>("get_common_settings", { path });
}

// ============================================================================
// Line Ending & Encoding Configuration
// ============================================================================

export interface LineEndingConfig {
  coreAutocrlf: string | null;
  coreEol: string | null;
  coreSafecrlf: string | null;
}

export interface GitConfig {
  key: string;
  value: string;
  scope: string;
}

export async function getLineEndingConfig(
  path: string,
): Promise<CommandResult<LineEndingConfig>> {
  return invokeCommand<LineEndingConfig>("get_line_ending_config", { path });
}

export async function setLineEndingConfig(
  path: string,
  autocrlf?: string | null,
  eol?: string | null,
  safecrlf?: string | null,
): Promise<CommandResult<LineEndingConfig>> {
  return invokeCommand<LineEndingConfig>("set_line_ending_config", {
    path,
    autocrlf,
    eol,
    safecrlf,
  });
}

export async function getGitConfig(
  path: string,
  key: string,
): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>("get_git_config", { path, key });
}

export async function setGitConfig(
  path: string,
  key: string,
  value: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_git_config", { path, key, value, global });
}

export async function getAllGitConfig(
  path: string,
): Promise<CommandResult<GitConfig[]>> {
  return invokeCommand<GitConfig[]>("get_all_git_config", { path });
}

export async function unsetGitConfig(
  path: string,
  key: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unset_git_config", { path, key, global });
}

// ============================================================================
// Credential Management
// ============================================================================

export interface CredentialHelper {
  name: string;
  command: string;
  scope: string;
  /** Config file the helper lives in: "system" | "global" | "local" | ... */
  configScope: string;
  urlPattern: string | null;
}

export interface CredentialTestResult {
  success: boolean;
  host: string;
  protocol: string;
  username: string | null;
  message: string;
  /**
   * Whether `host` is the remote AS TYPED — a path standing in for a host
   * there is none of — rather than a hostname to connect to. Mirrors
   * `CredentialTestResult::is_path_target` in
   * `src-tauri/src/commands/credentials.rs`.
   *
   * The dialog used to answer this from `protocol === 'file'` alone, which is
   * not the rule: `file://server/share/repo.git` keeps its `file` scheme while
   * resolving a real host — the very target the network gate refuses as one
   * that leaves the machine — and was drawn as a local path anyway. Only the
   * backend knows whether the target resolved.
   */
  isPathTarget: boolean;
}

export interface AvailableHelper {
  name: string;
  description: string;
  available: boolean;
}

export async function getCredentialHelpers(
  path: string,
): Promise<CommandResult<CredentialHelper[]>> {
  return invokeCommand<CredentialHelper[]>("get_credential_helpers", { path });
}

export async function setCredentialHelper(
  path: string | null,
  helper: string,
  global?: boolean,
  urlPattern?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_credential_helper", {
    path,
    helper,
    global,
    urlPattern,
  });
}

export async function unsetCredentialHelper(
  path: string | null,
  global?: boolean,
  urlPattern?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unset_credential_helper", {
    path,
    global,
    urlPattern,
  });
}

export async function getAvailableHelpers(): Promise<
  CommandResult<AvailableHelper[]>
> {
  return invokeCommand<AvailableHelper[]>("get_available_helpers", {});
}

/**
 * Testing an SSH remote's credentials runs `ssh -T git@host`, which opens a
 * real connection to that host — the same handshake `test_ssh_connection`
 * already gates. This one had no gate on either side, so offline mode let it
 * out. The remote's own URL is the destination, so it is what the allowlist
 * judges; the HTTPS branch only reads a credential helper, and refusing that
 * under a configured policy is the fail-closed side to err on.
 */
export async function testCredentials(
  path: string,
  remoteUrl: string,
): Promise<CommandResult<CredentialTestResult>> {
  // The URL goes in the RESOLVED slot, not the name slot: it IS the
  // destination, and routing it through the name lookup sent an scp-form
  // remote whose login is not `git` (`deploy@host:team/app.git`) down the
  // "not a URL" path, where it matched no remote name and fell back to the
  // first remote in the list — refusing the test with a toast naming a host
  // the operation would never have contacted.
  if (!await checkNetworkPermission('test credentials', path, remoteUrl, remoteUrl)) {
    return blockedResult();
  }
  // The backend guards this one too, and the two allowlists can disagree —
  // `security-sync.service.ts` warns about exactly that state. Without this
  // the backend's `NetworkBlocked` reached the dialog as a bare `BLOCKED`,
  // which every dialog suppresses on the understanding that the gate has
  // already explained itself: the button flipped to "Testing...", flipped
  // back, and the user was told nothing at all. Its siblings all wrap.
  return surfaceBackendRefusal(
    await invokeCommand<CredentialTestResult>("test_credentials", {
      path,
      remoteUrl,
    }),
  );
}

export async function eraseCredentials(
  path: string,
  host: string,
  protocol: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("erase_credentials", { path, host, protocol });
}

/**
 * Store git credentials in the system keyring for HTTPS authentication
 */
export async function storeGitCredentials(
  url: string,
  username: string,
  password: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("store_git_credentials", {
    url,
    username,
    password,
  });
}

/**
 * Delete git credentials from the system keyring
 */
export async function deleteGitCredentials(
  url: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_git_credentials", { url });
}


// ============================================================================
// Integration Token Storage (Keyring)
// ============================================================================

/**
 * Store an integration token in the system keyring.
 * Primary storage for integration tokens.
 */
export async function storeKeyringToken(
  key: string,
  value: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("store_keyring_token", { key, value });
}

/**
 * Retrieve an integration token from the system keyring.
 */
export async function getKeyringToken(
  key: string,
): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>("get_keyring_token", { key });
}

/**
 * Delete an integration token from the system keyring.
 */
export async function deleteKeyringToken(
  key: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_keyring_token", { key });
}


// ============================================================================
// Git Profiles
// ============================================================================

/**
 * Load profiles from backend and update store
 */
export async function loadProfiles(): Promise<void> {
  await unifiedProfileService.loadUnifiedProfiles();
}

/**
 * Load and detect profile for a repository
 */
export async function loadProfileForRepository(
  repoPath: string,
): Promise<void> {
  await unifiedProfileService.loadUnifiedProfileForRepository(repoPath);
}


// ============================================================================
// Commit Signature Verification
// ============================================================================

/**
 * Signature verification status
 */
export type SignatureStatus = "good" | "bad" | "unknown" | "unsigned" | "error";

/**
 * Detailed commit signature information
 */
export interface CommitSignatureInfo {
  commitId: string;
  isSigned: boolean;
  signatureStatus: SignatureStatus;
  signerName: string | null;
  signerEmail: string | null;
  keyId: string | null;
  signatureType: string | null; // "gpg", "ssh", "x509"
}

/**
 * Repository signing configuration
 */
export interface SigningConfig {
  signingEnabled: boolean;
  signingKey: string | null;
  signingFormat: string | null; // "gpg", "ssh", "x509"
}

/**
 * Verify the signature of a single commit
 */
export async function verifyCommitSignature(
  repoPath: string,
  commitId: string,
): Promise<CommandResult<CommitSignatureInfo>> {
  return invokeCommand<CommitSignatureInfo>("verify_commit_signature", {
    path: repoPath,
    commitId,
  });
}

/**
 * Verify signatures for multiple commits in a batch
 */
export async function getCommitsSignatureInfo(
  repoPath: string,
  commitIds: string[],
): Promise<CommandResult<CommitSignatureInfo[]>> {
  return invokeCommand<CommitSignatureInfo[]>("get_commits_signature_info", {
    path: repoPath,
    commitIds,
  });
}

/**
 * Get the signing configuration for a repository
 */
export async function getSigningConfig(
  repoPath: string,
): Promise<CommandResult<SigningConfig>> {
  return invokeCommand<SigningConfig>("get_signing_config", {
    path: repoPath,
  });
}

