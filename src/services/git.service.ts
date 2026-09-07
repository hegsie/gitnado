/**
 * Git Service
 * Provides high-level Git operations via Tauri commands
 */

import { invokeCommand, listenToEvent } from "./tauri-api.ts";
import { showToast } from "./notification.service.ts";
import { showErrorWithSuggestion } from "./error-suggestion.service.ts";
import { showConfirm } from "./dialog.service.ts";
import { commitStatsCache, commitSignatureCache, createCacheKey } from "./cache.service.ts";
import { settingsStore } from "../stores/settings.store.ts";

/** Why a network operation was refused. */
export type NetworkBlockReason = 'offline' | 'allowlist' | 'declined';

/**
 * Resolve a remote *name* to its URL so the allowlist has a domain to match.
 *
 * The allowlist compares against a domain, but almost every caller only knows
 * a short name ("origin") — and `"origin".includes("github.com")` is false, so
 * configuring an allowlist used to refuse the very remotes it was meant to
 * permit. Callers that already hold a URL (clone, add submodule) pass it
 * through unchanged.
 *
 * `get_remotes` reads the local config; it does not touch the network, so this
 * is safe to call from inside the gate.
 */
async function resolveRemoteUrl(repoPath: string, remote?: string): Promise<string | null> {
  if (remote && /^([a-z][a-z0-9+.-]*:\/\/|git@|ssh:\/\/)/i.test(remote)) {
    return remote;
  }
  const result = await invokeCommand<Remote[]>("get_remotes", { path: repoPath });
  if (!result.success || !result.data) return null;
  // No name given means the operation targets the repo's default remote.
  const wanted = remote ?? 'origin';
  const match = result.data.find((r) => r.name === wanted) ?? result.data[0];
  return match?.url ?? null;
}

async function resolveRemotePushUrl(repoPath: string, remote?: string): Promise<string | null> {
  if (remote && /^([a-z][a-z0-9+.-]*:\/\/|[^@/]+@[^:/]+:|ssh:\/\/)/i.test(remote)) {
    return remote;
  }
  const result = await invokeCommand<Remote[]>("get_remotes", { path: repoPath });
  if (!result.success || !result.data) return null;
  const wanted = remote ?? 'origin';
  const match =
    result.data.find((r) => r.name === wanted) ??
    (remote === undefined ? result.data[0] : undefined);
  return match?.pushUrl ?? match?.url ?? null;
}

/**
 * Hard blocks only: offline mode and the remote allowlist. No confirm prompt.
 *
 * Used for network calls the user did not just ask for — background provider
 * lookups, the auto-fetch loop — where a modal appearing out of nowhere would
 * be worse than useless. `checkNetworkPermission` layers the confirm on top for
 * explicit gestures.
 *
 * Returns null when allowed, or the reason it was refused.
 */
async function checkNetworkAllowed(
  repoPath: string | null,
  remote?: string,
  /** Unattended callers (the auto-fetch loop, the graph's PR lookup) pass true.
   * They run on every refresh, so toasting each refusal stacks a fresh
   * "Offline mode is enabled" on the user for every commit, stage and
   * checkout. The refusal still happens — it just doesn't shout. */
  silent = false,
  /** The URL the caller already resolved for `remote`. The prune-all path holds
   * every remote's URL from the single `get_remotes` it makes; without this the
   * allowlist check would resolve each bare name over IPC again, one round trip
   * per remote for a value already in hand. */
  resolvedUrl?: string | null,
): Promise<NetworkBlockReason | null> {
  const settings = settingsStore.getState();

  if (settings.offlineMode) {
    if (!silent) {
      showToast('Offline mode is enabled. Disable in Settings > Security.', 'warning');
    }
    return 'offline';
  }

  if (settings.remoteAllowlist.length === 0) return null;

  // An allowlist that cannot see the URL must refuse, not wave the operation
  // through: silently allowing is the failure mode that made this setting
  // decorative.
  const url =
    resolvedUrl ?? (repoPath ? await resolveRemoteUrl(repoPath, remote) : (remote ?? null));
  // Try the string as it stands, then as an https URL. Branching on '@'
  // instead broke the bare `git@host` form the SSH connection test hands over:
  // `cloneUrlHost`'s scheme-less branch only matches the scp shape
  // `user@host:path`, so `git@github.com` resolved to nothing and was refused
  // while `github.com`, `git@github.com:22` and `ssh://git@github.com` were
  // all allowed. Parsing `https://git@github.com` yields `github.com`, and the
  // fallback only ever runs where the direct parse already yielded nothing.
  const host = url ? (cloneUrlHost(url) ?? cloneUrlHost(`https://${url}`)) : null;
  // Entries are domains (the settings field says so, and offers "github.com,
  // gitlab.com"), so they are compared against the URL's HOST. A substring
  // match over the whole URL — what this used to do — let a look-alike host
  // through, since "https://github.com.evil.test/x.git" literally contains
  // "github.com", and let any URL merely NAMING an allowed domain in its path
  // through too. A leading "*." is accepted and means the domain and its
  // subdomains, which is what a bare entry already means.
  const allowed =
    !!host &&
    settings.remoteAllowlist.some((entry) => {
      const normalized = entry.trim().toLowerCase().replace(/^\*\./, '');
      const allowedHost =
        cloneUrlHost(normalized.includes('://') ? normalized : `https://${normalized}`) ??
        normalized;
      return host === allowedHost || host.endsWith(`.${allowedHost}`);
    });
  if (!allowed) {
    if (!silent) {
      showToast(
        url
          ? `Remote "${url}" is not in your allowlist`
          : 'Could not determine the remote URL, and an allowlist is configured',
        'error',
      );
    }
    return 'allowlist';
  }
  return null;
}

/**
 * A fetch the user did not ask for — the window-focus refresh. Hard blocks
 * apply; the confirm does not, and neither does the block toast. Routing this
 * through the confirm-capable gate popped a native modal every time the user
 * alt-tabbed back into the app.
 */
export async function fetchInBackground(
  repoPath: string,
): Promise<CommandResult<void>> {
  const resolved = await invokeCommand<string>('get_fetch_remote', { path: repoPath });
  if (!resolved.success || !resolved.data) {
    return { success: false, error: resolved.error };
  }
  const remote = resolved.data;
  if (await checkNetworkAllowed(repoPath, remote, true)) {
    return blockedResult();
  }
  const token = await getRemoteToken(repoPath, remote);

  // Same timeout its sibling `fetch` applies. Without it the backend's
  // `timeout_secs: None` branch awaits forever, so a hung remote left one
  // unbounded fetch alive per window focus — and nothing reports them, by
  // design, so they pile up invisibly.
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  return invokeCommand<void>("fetch", {
    path: repoPath,
    remote,
    token,
    // Suppresses the backend's success event, which
    // setupRemoteOperationListeners toasts. Without it this "silent" fetch
    // popped "Fetched from origin" every time the user alt-tabbed back in.
    quiet: true,
    ...(timeoutSecs > 0 ? { timeoutSecs } : {}),
  });
}

/** One remote in a multi-remote gate check: its name, and its URL when the
 * caller already has one to hand. */
interface NetworkRemoteTarget {
  name?: string;
  url?: string | null;
}

/**
 * Check if a network operation is allowed based on security settings.
 * Returns false if the operation should be blocked.
 */
async function checkNetworkPermission(
  operation: string,
  repoPath: string | null,
  remote?: string,
  /** The URL the caller already resolved for the single `remote` — the tag
   * push and remote-tag delete paths pin their destination this way. */
  resolvedUrl?: string | null,
  /** An operation that touches SEVERAL remotes in one gesture — the prune-all
   * path. Every remote is checked against the allowlist, and the user is asked
   * once for the whole set rather than once per remote. The name labels the
   * confirm; the URL, when the caller already resolved one, spares the
   * allowlist check a `get_remotes` round trip per remote. */
  remotes?: NetworkRemoteTarget[],
): Promise<boolean> {
  for (const target of remotes ?? [{ name: remote, url: resolvedUrl }]) {
    if (await checkNetworkAllowed(repoPath, target.name, false, target.url)) return false;
  }

  if (settingsStore.getState().confirmNetworkOps) {
    // A declined confirm is the user's own decision, not a failure — callers
    // distinguish it from a block so they don't report it back as a red error.
    const label = remotes ? remotes.map((t) => t.name).join(', ') : remote;
    const ok = await showConfirm(
      'Network Operation',
      `Allow ${operation}${label ? ` to ${label}` : ''}?`,
    );
    if (!ok) {
      lastNetworkBlockReason = 'declined';
      return false;
    }
  }

  return true;
}

/**
 * A hosting-provider API call (GitHub / GitLab / Bitbucket / Azure DevOps).
 *
 * These reach `https://api.github.com` and friends over reqwest, so "offline
 * mode" that does not cover them is not offline. They are gated with the
 * hard-block check rather than `checkNetworkPermission`: several run
 * unprompted — the graph loads pull requests whenever a repo opens — and a
 * confirm dialog on a background refresh would be worse than useless.
 *
 * Routing them all through one function is deliberate: a per-function guard
 * list has to be remembered, and the enumeration test below fails if a new
 * provider command starts using bare `invokeCommand`.
 */
async function invokeProviderCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<CommandResult<T>> {
  // Pass the API host so the allowlist has a domain to match. Without it every
  // provider call refused the moment ANY allowlist existed — `checkNetworkAllowed`
  // fails closed when it cannot see a URL, which is right for a git remote and
  // wrong here, because these calls never had a repo-relative remote to resolve.
  // With the host supplied, allowlisting "github.com" permits GitHub and still
  // blocks GitLab, which is what setting an allowlist means.
  if (await checkNetworkAllowed(null, providerApiHost(command, args), true)) {
    return blockedResult();
  }
  return invokeCommand<T>(command, args);
}

/**
 * The host a provider command talks to. GitLab is self-hostable, so its
 * instance URL travels in the arguments; the rest have fixed API hosts
 * (`github.rs:9`, `bitbucket.rs:12`, and dev.azure.com for Azure DevOps).
 */
function providerApiHost(command: string, args?: Record<string, unknown>): string {
  if (command === 'test_ssh_connection') {
    return String(args?.host ?? '');
  }
  if (command.includes('gitlab')) {
    return String(args?.instanceUrl ?? 'https://gitlab.com');
  }
  if (command.includes('bitbucket')) {
    return 'https://api.bitbucket.org';
  }
  if (command.includes('ado') || command.includes('azure')) {
    return 'https://dev.azure.com';
  }
  return 'https://api.github.com';
}

/**
 * True when a failed result is the security gate refusing, or the user
 * declining its confirm. Both are already accounted for — the gate toasts its
 * own reason, and a decline is the user's own choice — so callers must not
 * report either back as an error.
 */
export function isNetworkGateRefusal(error?: { code?: string }): boolean {
  return error?.code === 'BLOCKED' || error?.code === 'CANCELLED';
}

/**
 * The user pressed Cancel on the operation's progress row and the backend
 * really stopped the transfer.
 *
 * Not a failure, and deliberately NOT folded into `isNetworkGateRefusal`:
 * that one means the operation never started and has already been announced,
 * whereas this one has to say "Fetch cancelled" so the user knows the click
 * they made took effect. A push that could not be stopped in time still
 * reports its real success, because the backend only returns this code when it
 * actually aborted.
 */
export function isOperationCancelled(error?: { code?: string }): boolean {
  return error?.code === 'OPERATION_CANCELLED';
}

/** Set by the most recent refusal so `blockedResult` can label it. */
let lastNetworkBlockReason: NetworkBlockReason = 'offline';

/**
 * The refusal a gated operation returns. `CANCELLED` means the user declined
 * the confirm; `BLOCKED` means a setting refused it and the gate already said
 * so in a toast. Callers must not toast either one again.
 */
function blockedResult<T>(): CommandResult<T> {
  const declined = lastNetworkBlockReason === 'declined';
  lastNetworkBlockReason = 'offline';
  return {
    success: false,
    error: declined
      ? { code: 'CANCELLED', message: 'Cancelled' }
      : { code: 'BLOCKED', message: 'Operation blocked by security settings' },
  };
}
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  Repository,
  Commit,
  FileHistoryEntry,
  Branch,
  BranchTrackingInfo,
  Remote,
  Tag,
  TagDetails,
  Stash,
  StashShowResult,
  RebaseCommit,
  RebasePlan,
  RebaseState,
  RebaseTodo,
  RebaseTodoEntry,
  SquashResult,
  DropCommitResult,
  ReorderResult,
  ConflictFile,
  ConflictMarkerFile,
  ConflictDetails,
  StatusEntry,
  DiffFile,
  RefsByCommit,
  CommitFileEntry,
  CommitStats,
  BlameResult,
  ReflogEntry,
  UndoAction,
  UndoHistory,
  ImageVersions,
  AvatarInfo,
  FileHunks,
  FileAtCommitResult,
  FileEncodingInfo,
  ConvertEncodingResult,
  SortedFileStatus,
  FileStatusSortBy,
  SortDirection,
  CloneFilterInfo,
  CleanupCandidate,
} from "../types/git.types.ts";
import type {
  OpenRepositoryCommand,
  CloneRepositoryCommand,
  InitRepositoryCommand,
  CreateBranchCommand,
  CreateOrphanBranchCommand,
  RenameBranchCommand,
  CheckoutCommand,
  CreateCommitCommand,
  GetCommitHistoryCommand,
  AmendCommitCommand,
  AmendResult,
  EditCommitDateCommand,
  StageFilesCommand,
  UnstageFilesCommand,
  FetchCommand,
  FetchAllRemotesCommand,
  FetchAllResult,
  RemoteFetchStatus,
  PullCommand,
  PushCommand,
  PushToMultipleRemotesCommand,
  MultiPushResult,
  MergeCommand,
  AbortMergeCommand,
  RebaseCommand,
  ContinueRebaseCommand,
  AbortRebaseCommand,
  CherryPickCommand,
  ContinueCherryPickCommand,
  AbortCherryPickCommand,
  SkipCherryPickCommand,
  CherryPickFromBranchCommand,
  RevertCommand,
  ContinueRevertCommand,
  AbortRevertCommand,
  SkipRevertCommand,
  ResetCommand,
  CreateStashCommand,
  ApplyStashCommand,
  DropStashCommand,
  PopStashCommand,
  StashShowCommand,
  CreateTagCommand,
  DeleteTagCommand,
  PushTagCommand,
  DeleteRemoteTagCommand,
  GetTagDetailsCommand,
  EditTagMessageCommand,
  DescribeOptions,
  DescribeResult,
  GetDiffCommand,
  GetDiffWithOptionsCommand,
  GetAvatarUrlCommand,
  GetAvatarUrlsCommand,
  CheckoutFileFromCommitCommand,
  CheckoutFileFromBranchCommand,
  GetFileAtCommitCommand,
  RunGcCommand,
  RunFsckCommand,
  RunPruneCommand,
  MaintenanceResult,
  CommandResult,
  InteractiveRebaseOutcome,
} from "../types/api.types.ts";
import type {
  IntegrationType,
  IntegrationAccount,
} from "../types/unified-profile.types.ts";

/**
 * Repository operations
 */
export async function openRepository(
  args: OpenRepositoryCommand,
): Promise<CommandResult<Repository>> {
  return invokeCommand<Repository>("open_repository", args);
}

/**
 * Host of a clone URL. Covers the forms the clone dialog accepts:
 * `https://host/path`, `ssh://git@host/path`, and the scp-like
 * `git@host:owner/repo.git`.
 *
 * Matching on the host — not on a substring of the whole URL, as this used to —
 * keeps a stored token off a look-alike host (`github.com.example.net`) and off
 * a repo whose PATH merely names a provider.
 */
function cloneUrlHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.includes("://")) {
    const scpLike = /^[^@/]+@([^:/]+):/.exec(trimmed);
    return scpLike ? scpLike[1].toLowerCase() : null;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a stored token may ride this clone URL.
 *
 * The token is sent as the HTTPS password, and `validate_clone_url` also
 * accepts `http://` and `git://` — plaintext transports that would put the
 * credential on the wire in clear. SSH URLs (`ssh://` and the scheme-less scp
 * form) authenticate with a key and never transmit it, so they stay eligible.
 */
function cloneUrlIsCredentialSafe(url: string): boolean {
  const trimmed = url.trim();
  // scp-like `git@host:owner/repo.git` — always the ssh transport.
  if (!trimmed.includes("://")) return true;
  return /^(?:https|ssh):\/\//i.test(trimmed);
}

/**
 * The Azure DevOps organization a clone URL names. Every connected ADO account
 * is scoped to exactly one organization, so this is what picks the right one:
 *
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}@dev.azure.com/{org}/...        (userinfo ignored by URL)
 *   https://ssh.dev.azure.com/v3/{org}/{project}/{repo}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}
 */
function adoUrlOrganization(url: string, host: string): string | undefined {
  if (host.endsWith(".visualstudio.com")) {
    return host.slice(0, -".visualstudio.com".length) || undefined;
  }
  const trimmed = url.trim();
  let path: string;
  if (trimmed.includes("://")) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  } else {
    path = /^[^@/]+@[^:/]+:(.*)$/.exec(trimmed)?.[1] ?? "";
  }
  const segments = path.split("/").filter(Boolean);
  // ssh.dev.azure.com paths carry a `v3` protocol-version prefix.
  return segments[segments[0] === "v3" ? 1 : 0];
}

/**
 * The connected Azure DevOps account for `organization`. Matching on the
 * organization the URL names — rather than taking the global default account —
 * keeps one org's token off another org's clone in a multi-account setup.
 */
async function findAdoAccountForOrg(organization: string) {
  const { getAccountsByType } = await import("../stores/unified-profile.store.ts");
  const wanted = organization.toLowerCase();
  const matches = getAccountsByType("azure-devops").filter(
    (account) =>
      account.config.type === "azure-devops" &&
      account.config.organization.toLowerCase() === wanted,
  );
  return matches.find((account) => account.isDefault) ?? matches[0];
}

/**
 * The connected GitLab account whose instance serves `host`. GitLab is
 * self-hostable, so the instance URL — not a fixed domain — identifies it, and
 * a repo on `git.acme.dev` must clone with THAT instance's token even when a
 * gitlab.com account is the global default.
 */
async function findGitLabAccountForHost(host: string) {
  const { getAccountsByType } = await import("../stores/unified-profile.store.ts");
  const matches = getAccountsByType("gitlab").filter(
    (account) =>
      account.config.type === "gitlab" &&
      cloneUrlHost(account.config.instanceUrl) === host,
  );
  return matches.find((account) => account.isDefault) ?? matches[0];
}

/**
 * The stored token to clone `url` with. Provider coverage mirrors
 * `getRepoToken` (GitHub, Azure DevOps, GitLab) so the first clone
 * authenticates against the same connected account every later fetch, pull and
 * push will use — previously only GitHub resolved, so a private clone from a
 * connected GitLab or Azure DevOps account failed with no way forward (the
 * clone dialog has no token field to work around it with).
 *
 * There is no repository on disk yet, so the remote-based detection
 * `getRepoToken` relies on cannot run here; the URL's host is all we have.
 *
 * Bitbucket is absent for the same reason it is absent from `getRepoToken`: no
 * git network operation resolves Bitbucket credentials, and an app password is
 * a username/password pair the single-token clone command cannot carry.
 */
async function getCloneToken(url: string): Promise<string | undefined> {
  const host = cloneUrlHost(url);
  if (!host || !cloneUrlIsCredentialSafe(url)) return undefined;

  try {
    if (host === "github.com" || host.endsWith(".github.com")) {
      const result = await getGitHubToken();
      return result.success && result.data ? result.data : undefined;
    }

    if (
      host === "dev.azure.com" ||
      host === "ssh.dev.azure.com" ||
      host.endsWith(".visualstudio.com")
    ) {
      const org = adoUrlOrganization(url, host);
      const adoAccount = org ? await findAdoAccountForOrg(org) : undefined;
      if (adoAccount) {
        const { getFreshAccountToken } = await import("./credential.service.ts");
        // Refreshes an expiring Entra OAuth token, so a long-lived session
        // still clones with a valid credential.
        const token = await getFreshAccountToken("azure-devops", adoAccount.id, "azure");
        if (token) return token;
      }
      // Legacy single-token storage, for a user who never created an account.
      // Deliberately not getAdoToken(): that falls back to the default account
      // whatever its organization, which would hand another org's token over.
      const { AzureDevOpsCredentials } = await import("./credential.service.ts");
      const token = await AzureDevOpsCredentials.getToken();
      return token ?? undefined;
    }

    const gitlabAccount = await findGitLabAccountForHost(host);
    if (gitlabAccount) {
      const { getFreshAccountToken } = await import("./credential.service.ts");
      // Refresh-aware for the same reason the Azure DevOps branch is: a GitLab
      // account connected by OAuth holds an access token that expires, and the
      // stored one may already be dead. A PAT account has no OAuth bundle, so
      // this returns its stored token unchanged.
      const token = await getFreshAccountToken(
        "gitlab",
        gitlabAccount.id,
        "gitlab",
        gitlabAccount.config.type === "gitlab" ? gitlabAccount.config.instanceUrl : undefined,
      );
      if (token) return token;
    }
    if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
      // Legacy single-token storage, for a user who never created an account.
      // Deliberately not getGitLabToken(): that falls back to the default
      // account whatever its instance, which would hand a self-hosted
      // instance's token to gitlab.com.
      const { GitLabCredentials } = await import("./credential.service.ts");
      const token = await GitLabCredentials.getToken();
      if (token) return token;
    }
  } catch (err) {
    // Same posture as getRepoToken: a credential lookup failure must not stop
    // the clone — it just proceeds unauthenticated, as it does today.
    console.error("Failed to auto-detect clone token:", err);
  }
  return undefined;
}

export async function cloneRepository(
  args: CloneRepositoryCommand,
): Promise<CommandResult<Repository>> {
  if (!await checkNetworkPermission('clone', null, args.url)) {
    return blockedResult();
  }

  // No token supplied: fall back to the one stored for the account that owns
  // this URL's host.
  if (args && !args.token) {
    const token = await getCloneToken(args.url);
    if (token) {
      args.token = token;
    }
  }
  // Apply the same network timeout fetch/pull/push use. Without it a clone
  // against an unreachable host hangs forever, and the dialog cannot be closed
  // while one is in flight.
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  if (args && timeoutSecs > 0) {
    args.timeoutSecs = timeoutSecs;
  }

  return invokeCommand<Repository>("clone_repository", args);
}

/**
 * Cancel the clone currently in flight.
 *
 * Kills the `git clone` child process on the CLI path and aborts the transfer
 * on the git2 path, then clears the partial destination directory.
 */
export async function cancelClone(): Promise<CommandResult<void>> {
  return invokeCommand<void>("cancel_clone", {});
}

export async function initRepository(
  args: InitRepositoryCommand,
): Promise<CommandResult<Repository>> {
  return invokeCommand<Repository>("init_repository", args);
}

export async function getCloneFilterInfo(
  path: string,
): Promise<CommandResult<CloneFilterInfo>> {
  return invokeCommand<CloneFilterInfo>("get_clone_filter_info", { path });
}

export async function deepenRepository(
  path: string,
  depth: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("deepen_repository", { path, depth });
}

export async function unshallowRepository(
  path: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unshallow_repository", { path });
}

export async function listTrackedFiles(
  path: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("list_tracked_files", { path });
}

/**
 * Branch operations
 */
export async function getBranches(
  path: string,
): Promise<CommandResult<Branch[]>> {
  return invokeCommand<Branch[]>("get_branches", { path });
}

export async function createBranch(
  path: string,
  args: CreateBranchCommand,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("create_branch", { path, ...args });
}

/**
 * Create an orphan branch (a branch with no parent commits).
 *
 * `checkout` must be true. An orphan branch has no commits, so it is not a ref
 * until its first commit is made — git cannot create one without switching to
 * it, and the backend refuses `checkout: false` rather than stranding HEAD on
 * an unborn branch.
 */
export async function createOrphanBranch(
  path: string,
  args: CreateOrphanBranchCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("create_orphan_branch", { path, ...args });
}

export async function deleteBranch(
  path: string,
  name: string,
  force?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_branch", { path, name, force });
}

/**
 * Get branches that are candidates for cleanup (merged, stale, gone).
 * Uses server-side graph_descendant_of for accurate merge detection.
 */
export async function getCleanupCandidates(
  path: string,
  staleDays?: number,
): Promise<CommandResult<CleanupCandidate[]>> {
  return invokeCommand<CleanupCandidate[]>("get_cleanup_candidates", {
    path,
    staleDays,
  });
}

export async function renameBranch(
  path: string,
  args: RenameBranchCommand,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("rename_branch", { path, ...args });
}

export async function checkout(
  path: string,
  args: CheckoutCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("checkout", { path, ...args });
}

/**
 * Set the upstream branch for a local branch
 */
export async function setUpstreamBranch(
  path: string,
  branch: string,
  upstream: string,
): Promise<CommandResult<BranchTrackingInfo>> {
  return invokeCommand<BranchTrackingInfo>("set_upstream_branch", {
    path,
    branch,
    upstream,
  });
}

/**
 * Remove the upstream tracking for a local branch
 */
export async function unsetUpstreamBranch(
  path: string,
  branch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unset_upstream_branch", { path, branch });
}

/**
 * Get detailed tracking information for a branch
 */
export async function getBranchTrackingInfo(
  path: string,
  branch: string,
): Promise<CommandResult<BranchTrackingInfo>> {
  return invokeCommand<BranchTrackingInfo>("get_branch_tracking_info", {
    path,
    branch,
  });
}

/**
 * Result of checkout with auto-stash
 */
export interface CheckoutWithStashResult {
  success: boolean;
  stashed: boolean;
  stashApplied: boolean;
  stashConflict: boolean;
  /** The auto-stash's oid. Identifies the entry to drop without trusting a position. */
  stashOid: string | null;
  message: string;
}

/**
 * Checkout with automatic stash handling
 * 1. Stashes uncommitted changes before checkout
 * 2. Performs checkout
 * 3. Re-applies stash after checkout
 * 4. Reports if stash apply had conflicts
 */
export async function checkoutWithAutoStash(
  path: string,
  refName: string,
): Promise<CommandResult<CheckoutWithStashResult>> {
  // The "Auto-Stash on Checkout" setting was persisted and rendered but never
  // read by anything: every checkout stashed, switched and popped regardless,
  // and a conflicting pop dropped the user into the conflict dialog they had
  // explicitly opted out of. With the setting off, let git refuse a checkout
  // that would clobber uncommitted work, the way `git checkout` does.
  const autoStash = settingsStore.getState().autoStashOnCheckout;
  return invokeCommand<CheckoutWithStashResult>("checkout_with_autostash", {
    path,
    refName,
    autoStash,
  });
}

/**
 * Commit operations
 */
export async function getCommitHistory(
  args: GetCommitHistoryCommand,
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("get_commit_history", args);
}

/**
 * Total number of commits reachable from any ref (size of the all-branches
 * graph walk). Cheap when the backend walk cache is warm.
 */
export async function getCommitTotal(
  repoPath: string,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("get_commit_total", { path: repoPath });
}

export async function getCommit(
  repoPath: string,
  oid: string,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("get_commit", { path: repoPath, oid });
}

/**
 * Search commits with filters
 */
export async function searchCommits(
  repoPath: string,
  options: {
    query?: string;
    author?: string;
    dateFrom?: number;
    dateTo?: number;
    filePath?: string;
    branch?: string;
    limit?: number;
  },
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("search_commits", {
    path: repoPath,
    query: options.query,
    author: options.author,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    filePath: options.filePath,
    branch: options.branch,
    limit: options.limit,
  });
}

/**
 * Whether HEAD is already on its upstream, so amending would rewrite history
 * other people may already have.
 *
 * A failure to find out answers false: the check exists to add a warning, and
 * a broken check must not become a wall in front of an ordinary local amend.
 */
async function amendWouldRewritePublishedHistory(path: string): Promise<boolean> {
  const result = await invokeCommand<boolean>("is_head_published", { path });
  return result.success && result.data === true;
}

export async function createCommit(
  path: string,
  args: CreateCommitCommand,
): Promise<CommandResult<Commit>> {
  // Amend rewrites HEAD. When HEAD is already published, that rewrites history
  // the remote and everyone else already has: the branch and its upstream
  // diverge, the next push is rejected, and the only way on is a force push
  // that discards whatever anyone based on that commit.
  //
  // No amend surface said so — not the commit panel's Amend checkbox, not the
  // graph's Quick Amend, not the reword-HEAD route. The confirm goes HERE, at
  // the one call all three share, so none of them can be forgotten.
  if (args.amend && (await amendWouldRewritePublishedHistory(path))) {
    const proceed = await showConfirm(
      "Amend a pushed commit?",
      "This commit is already on the remote. Amending replaces it, so your " +
        "branch and its upstream will diverge and the next push will be " +
        "rejected until you force push — which discards any work others based " +
        "on it.\n\nAmend anyway?",
      "warning",
    );
    if (!proceed) {
      // The SAME shape a declined network gate returns, so isNetworkGateRefusal
      // recognises it and callers do not report the user's own choice back to
      // them as a failure.
      return { success: false, error: { code: "CANCELLED", message: "Cancelled" } };
    }
  }
  return invokeCommand<Commit>("create_commit", { path, ...args });
}

/**
 * Amend the HEAD commit
 * @param path Repository path
 * @param args Options for amending (message, resetAuthor, and/or signAmend)
 */
export async function amendCommit(
  path: string,
  args?: AmendCommitCommand,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("amend_commit", {
    path,
    message: args?.message,
    resetAuthor: args?.resetAuthor,
    signAmend: args?.signAmend,
  });
}

/**
 * Get the full commit message for a commit
 * @param path Repository path
 * @param oid Commit OID
 */
export async function getCommitMessage(
  path: string,
  oid: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_commit_message", { path, oid });
}

/**
 * Edit the author and/or committer date of an existing commit
 * For HEAD commits, this recreates the commit with updated signatures.
 * For non-HEAD commits, this uses interactive rebase with GIT_AUTHOR_DATE/GIT_COMMITTER_DATE.
 * @param path Repository path
 * @param args Options including oid and date(s) to set (ISO 8601 or unix timestamp)
 */
export async function editCommitDate(
  path: string,
  args: EditCommitDateCommand,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("edit_commit_date", {
    path,
    oid: args.oid,
    authorDate: args.authorDate,
    committerDate: args.committerDate,
  });
}

/**
 * Reword a commit (change its message)
 * For HEAD commits, this uses amend. For non-HEAD commits, this uses interactive rebase.
 * @param path Repository path
 * @param oid Commit OID to reword
 * @param message New commit message
 */
export async function rewordCommit(
  path: string,
  oid: string,
  message: string,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("reword_commit", { path, oid, message });
}

/**
 * Staging operations
 */
export async function getStatus(
  path: string,
): Promise<CommandResult<StatusEntry[]>> {
  return invokeCommand<StatusEntry[]>("get_status", { path });
}

/**
 * Get sorted file status with enriched metadata for file tree display
 * @param path Repository path
 * @param sortBy Sort criteria: "name", "status", "path", or "extension"
 * @param sortDirection Sort direction: "asc" or "desc" (default "asc")
 * @param groupByDirectory Whether to group files by directory
 */
export async function getSortedFileStatus(
  path: string,
  sortBy: FileStatusSortBy,
  sortDirection?: SortDirection,
  groupByDirectory: boolean = false,
): Promise<CommandResult<SortedFileStatus>> {
  return invokeCommand<SortedFileStatus>("get_sorted_file_status", {
    path,
    sortBy,
    sortDirection,
    groupByDirectory,
  });
}

export async function stageFiles(
  repoPath: string,
  args: StageFilesCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_files", { path: repoPath, ...args });
}

export async function unstageFiles(
  repoPath: string,
  args: UnstageFilesCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_files", { path: repoPath, ...args });
}

export async function discardChanges(
  repoPath: string,
  paths: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("discard_changes", { path: repoPath, paths });
}

/**
 * Stage a specific hunk from a diff
 * @param repoPath Repository path
 * @param patch The patch content for the hunk (with proper diff headers)
 */
export async function stageHunk(
  repoPath: string,
  patch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_hunk", { repoPath, patch });
}

/**
 * Unstage a specific hunk from the index
 * @param repoPath Repository path
 * @param patch The patch content for the hunk (with proper diff headers)
 */
export async function unstageHunk(
  repoPath: string,
  patch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_hunk", { repoPath, patch });
}

/**
 * Get hunks for a file (staged or unstaged)
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param staged Whether to get staged (true) or unstaged (false) hunks
 */
export async function getFileHunks(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<CommandResult<FileHunks>> {
  return invokeCommand<FileHunks>("get_file_hunks", {
    path: repoPath,
    filePath,
    staged,
  });
}

/**
 * Stage a specific hunk by its index
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param hunkIndex Index of the hunk to stage
 */
export async function stageHunkByIndex(
  repoPath: string,
  filePath: string,
  hunkIndex: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_hunk_by_index", {
    path: repoPath,
    filePath,
    hunkIndex,
  });
}

/**
 * Unstage a specific hunk by its index
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param hunkIndex Index of the hunk to unstage
 */
export async function unstageHunkByIndex(
  repoPath: string,
  filePath: string,
  hunkIndex: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_hunk_by_index", {
    path: repoPath,
    filePath,
    hunkIndex,
  });
}

/**
 * Stage specific lines from a diff
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param startLine Start line index (0-indexed in the diff output)
 * @param endLine End line index (inclusive, 0-indexed in the diff output)
 */
export async function stageLines(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_lines", {
    path: repoPath,
    filePath,
    startLine,
    endLine,
  });
}

/**
 * Write content to a file in the working directory
 * @param repoPath Repository path
 * @param filePath Path to the file relative to repo root
 * @param content Content to write
 * @param stageAfter Whether to stage the file after writing
 */
export async function writeFileContent(
  repoPath: string,
  filePath: string,
  content: string,
  stageAfter?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("write_file_content", {
    repoPath,
    filePath,
    content,
    stageAfter,
  });
}

/**
 * Read file content from working directory or index
 * @param repoPath Repository path
 * @param filePath Path to the file relative to repo root
 * @param fromIndex Whether to read from index instead of working directory
 */
export async function readFileContent(
  repoPath: string,
  filePath: string,
  fromIndex?: boolean,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("read_file_content", {
    repoPath,
    filePath,
    fromIndex,
  });
}

/**
 * Remote operations
 */
export async function getRemotes(
  path: string,
): Promise<CommandResult<Remote[]>> {
  return invokeCommand<Remote[]>("get_remotes", { path });
}

export async function addRemote(
  repoPath: string,
  name: string,
  url: string,
): Promise<CommandResult<Remote>> {
  return invokeCommand<Remote>("add_remote", { path: repoPath, name, url });
}

export async function removeRemote(
  repoPath: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_remote", { path: repoPath, name });
}

export async function renameRemote(
  repoPath: string,
  oldName: string,
  newName: string,
): Promise<CommandResult<Remote>> {
  return invokeCommand<Remote>("rename_remote", {
    path: repoPath,
    oldName,
    newName,
  });
}

export async function setRemoteUrl(
  repoPath: string,
  name: string,
  url: string,
  push?: boolean,
): Promise<CommandResult<Remote>> {
  return invokeCommand<Remote>("set_remote_url", {
    path: repoPath,
    name,
    url,
    push,
  });
}

export async function fetch(
  args?: FetchCommand & { silent?: boolean },
): Promise<CommandResult<void>> {
  if (args?.path && !args.remote) {
    const resolved = await invokeCommand<string>('get_fetch_remote', { path: args.path });
    if (resolved.success && resolved.data) {
      args.remote = resolved.data;
    }
  }
  if (!await checkNetworkPermission('fetch', args?.path ?? null, args?.remote)) {
    return blockedResult();
  }

  // If no token is provided, try to find one for the repository
  if (args && !args.token) {
    const token = args.remote
      ? await getRemoteToken(args.path, args.remote)
      : await getRepoToken(args.path);
    if (token) {
      args.token = token;
    }
  }

  // Apply network operation timeout from settings
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  if (args && timeoutSecs > 0) {
    args.timeoutSecs = timeoutSecs;
  }

  const result = await invokeCommand<void>("fetch", args);
  if (!args?.silent) {
    if (result.success) {
      showToast("Fetch completed successfully", "success");
    } else {
      showToast(
        `Fetch failed: ${result.error?.message ?? "Unknown error"}`,
        "error",
      );
    }
  }
  return result;
}

export async function pull(
  args?: PullCommand & { silent?: boolean },
): Promise<CommandResult<void>> {
  // Same reason `fetch` resolves first: no pull surface in the app names a
  // remote, and the backend pulls from the branch's UPSTREAM. Gating on the
  // "origin" fallback checked the allowlist against the wrong host and handed
  // origin's token to whatever host the upstream actually lives on.
  if (args?.path && !args.remote) {
    const resolved = await invokeCommand<string>('get_pull_remote', {
      path: args.path,
      ...(args.branch ? { branch: args.branch } : {}),
    });
    if (resolved.success && resolved.data) {
      args.remote = resolved.data;
    }
  }
  if (!await checkNetworkPermission('pull', args?.path ?? null, args?.remote)) {
    return blockedResult();
  }

  // If no token is provided, try to find one for the repository
  if (args && !args.token) {
    const token = args.remote
      ? await getRemoteToken(args.path, args.remote)
      : await getRepoToken(args.path);
    if (token) {
      args.token = token;
    }
  }

  // Apply network operation timeout from settings
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  if (args && timeoutSecs > 0) {
    args.timeoutSecs = timeoutSecs;
  }

  const result = await invokeCommand<void>("pull", args);
  if (!args?.silent) {
    if (result.success) {
      showToast("Pull completed successfully", "success");
    } else {
      showToast(
        `Pull failed: ${result.error?.message ?? "Unknown error"}`,
        "error",
      );
    }
  }
  return result;
}

export async function push(
  args?: PushCommand & { silent?: boolean },
): Promise<CommandResult<void>> {
  // No push surface names a remote either, and the backend follows
  // branch.<n>.pushRemote / remote.pushDefault / branch.<n>.remote — none of
  // which need be origin. Resolve it up front so the gate and the credential
  // are scoped to the host this push will really reach.
  if (args?.path && !args.remote) {
    const resolved = await invokeCommand<string>('get_push_remote', { path: args.path });
    if (resolved.success && resolved.data) {
      args.remote = resolved.data;
    }
  }
  if (!await checkNetworkPermission('push', args?.path ?? null, args?.remote)) {
    return blockedResult();
  }

  // If no token is provided, try to find one for the repository
  if (args && !args.token) {
    const token = args.remote
      ? await getRemoteToken(args.path, args.remote)
      : await getRepoToken(args.path);
    if (token) {
      args.token = token;
    }
  }

  // Apply network operation timeout from settings
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  if (args && timeoutSecs > 0) {
    args.timeoutSecs = timeoutSecs;
  }

  const result = await invokeCommand<void>("push", args);
  if (!args?.silent) {
    if (result.success) {
      showToast("Push completed successfully", "success");
    } else {
      showToast(
        `Push failed: ${result.error?.message ?? "Unknown error"}`,
        "error",
      );
    }
  }
  return result;
}

/**
 * Push to multiple remotes at once
 */
export async function pushToMultipleRemotes(
  args: PushToMultipleRemotesCommand & { silent?: boolean },
): Promise<CommandResult<MultiPushResult>> {
  if (!await checkNetworkPermission('push', args?.path ?? null)) {
    return blockedResult();
  }
  // If no token is provided, try to find one for the repository
  if (args && !args.token) {
    const token = await getRepoToken(args.path);
    if (token) {
      args.token = token;
    }
  }

  const result = await invokeCommand<MultiPushResult>(
    "push_to_multiple_remotes",
    args,
  );
  if (!args?.silent) {
    if (result.success && result.data) {
      const { totalSuccess, totalFailed } = result.data;
      if (totalFailed === 0) {
        showToast(
          `Pushed to ${totalSuccess} remote(s) successfully`,
          "success",
        );
      } else {
        showToast(
          `Pushed to ${totalSuccess} remote(s), ${totalFailed} failed`,
          "warning",
        );
      }
    } else {
      showToast(
        `Multi-push failed: ${result.error?.message ?? "Unknown error"}`,
        "error",
      );
    }
  }
  return result;
}

/**
 * Fetch from all remotes at once
 */
export async function fetchAllRemotes(
  args: FetchAllRemotesCommand & { silent?: boolean },
): Promise<CommandResult<FetchAllResult>> {
  if (!await checkNetworkPermission('fetch', args?.path ?? null)) {
    return blockedResult();
  }
  // If no token is provided, try to find one for the repository
  if (args && !args.token) {
    const token = await getRepoToken(args.path);
    if (token) {
      args.token = token;
    }
  }

  const result = await invokeCommand<FetchAllResult>("fetch_all_remotes", args);
  if (!args?.silent) {
    if (result.success && result.data) {
      const { totalFetched, totalFailed } = result.data;
      if (totalFailed === 0) {
        showToast(`Fetched from ${totalFetched} remote(s) successfully`, "success");
      } else {
        showToast(
          `Fetched from ${totalFetched} remote(s), ${totalFailed} failed`,
          "warning",
        );
      }
    } else {
      showToast(
        `Fetch all failed: ${result.error?.message ?? "Unknown error"}`,
        "error",
      );
    }
  }
  return result;
}

/**
 * Get fetch status for all remotes
 */
export async function getFetchStatus(
  path: string,
): Promise<CommandResult<RemoteFetchStatus[]>> {
  return invokeCommand<RemoteFetchStatus[]>("get_fetch_status", { path });
}

/** Last `${org}::${token}` written to the keyring ADO git credential (dedup). */
let lastSyncedAdoGitCredKey: string | null = null;

/**
 * Reset the ADO git-credential sync dedup cache. Call this after deleting the
 * keyring credential (disconnect/delete) so a subsequent connect with the same
 * token value re-writes the (now-deleted) keyring entry instead of being skipped.
 */
export function resetAdoGitCredentialSyncCache(): void {
  lastSyncedAdoGitCredKey = null;
}

/**
 * Write the Azure DevOps git credentials to the OS keyring for both dev.azure.com
 * and {org}.visualstudio.com so external git CLI operations use a valid token.
 * Best-effort and deduped by (org, token); storeGitCredentials never throws.
 * Only call with a token verified to work for `org`.
 */
export async function syncAdoGitCredentials(org: string, token: string): Promise<void> {
  const key = `${org}::${token}`;
  if (key === lastSyncedAdoGitCredKey) return;
  const c1 = await storeGitCredentials("https://dev.azure.com", "pat", token);
  const c2 = await storeGitCredentials(`https://${org}.visualstudio.com`, "pat", token);
  if (c1.success && c2.success) {
    lastSyncedAdoGitCredKey = key;
  }
}

/**
 * Resolve which integration account's token a repository's network operations
 * should use.
 *
 * `selectDefaultGlobalAccount` knows nothing about the repository, so on its own
 * it hands a Work repo the Personal account's token in any multi-account setup.
 * The backend resolver owns the real precedence — account `urlPatterns`, then
 * the repo's assigned profile default, then the global default — so delegate to
 * it and keep the global default purely as the fallback for when it cannot
 * answer (no accounts configured, or the command failed).
 *
 * `repoSpecific` reports which tier answered: `true` when the resolver matched
 * this repository to an account, `false` when we fell back to the global
 * default. Callers need the distinction because a repo-specific match rules out
 * authenticating with any other account's credentials.
 */
async function resolveRepoAccount(
  repoPath: string,
  integrationType: IntegrationType,
  remoteName: string | undefined,
  /** The remote's URL when the caller already resolved it. Saves a second
   * `get_remotes` round trip on paths that walk every remote in the repo. */
  knownRemoteUrl?: string | null,
): Promise<{ account: IntegrationAccount | undefined; repoSpecific: boolean }> {
  const { selectDefaultGlobalAccount } = await import("../stores/unified-profile.store.ts");
  try {
    // Dynamic import: unified-profile.service.ts statically imports this module,
    // so a static import back would close a runtime cycle.
    const { getAssignedUnifiedProfile, fetchRepositoryPreferredAccount } = await import(
      "./unified-profile.service.ts"
    );
    const [profile, repoUrl] = await Promise.all([
      // A failed profile lookup must not cost us the account-level urlPatterns
      // tier or the global default — resolve with no profile instead.
      getAssignedUnifiedProfile(repoPath).catch(() => null),
      knownRemoteUrl ?? resolveRemoteUrl(repoPath, remoteName),
    ]);
    // An unknown profile id resolves to no profile on the backend, which simply
    // falls through to the remaining tiers.
    const account = await fetchRepositoryPreferredAccount(
      profile?.id ?? "",
      integrationType,
      repoUrl,
    );
    if (account) return { account, repoSpecific: true };
  } catch (err) {
    // Must be caught here: letting it reach getRepoToken's outer catch would
    // skip the remaining providers and every legacy fallback below.
    console.error("Failed to resolve the repository's preferred account:", err);
  }
  return { account: selectDefaultGlobalAccount(integrationType), repoSpecific: false };
}

/**
 * The token for a repository AND the remote it was resolved against.
 *
 * The remote matters to any caller that hands the token to the git CLI: the
 * lookup below probes EVERY remote and returns a token for the first one a
 * provider claims, so the remote it settles on is routinely not `origin`. A
 * caller that assumed `origin` would scope the credential to the wrong host —
 * offering the token to a host it does not belong to, and withholding it from
 * the one it does.
 */
interface ResolvedRepoToken {
  token?: string;
  remoteName?: string;
  credentialHost?: string;
  refused?: boolean;
  /**
   * The account the token belongs to, when one resolved it. Absent for the
   * legacy single-token fallbacks, which have no account to speak of.
   */
  accountId?: string;
  integrationType?: IntegrationType;
}

/**
 * Helper to get authentication token for a repository, with the remote it came
 * from. Resolves the account the way the profile UI does — account URL
 * patterns, then the repo's assigned profile, then the global default —
 * before falling back to the legacy single-token methods.
 */
async function resolveRepoToken(
  repoPath: string,
  remoteName?: string,
): Promise<ResolvedRepoToken> {
  try {
    // --- Multi-account system (preferred) ---
    // GitHub
    const ghRepoResult = await detectGitHubRepo(repoPath, remoteName);
    if (
      ghRepoResult.success &&
      ghRepoResult.data &&
      (!remoteName || ghRepoResult.data.remoteName === remoteName)
    ) {
      const resolvedRemote = ghRepoResult.data.remoteName;
      const { account, repoSpecific } = await resolveRepoAccount(
        repoPath,
        "github",
        resolvedRemote,
      );
      if (account) {
        const { getFreshAccountToken } = await import("./credential.service.ts");
        const token = await getFreshAccountToken("github", account.id, "github");
        if (token) {
          return {
            token,
            remoteName: resolvedRemote,
            credentialHost: "github.com",
            accountId: account.id,
            integrationType: "github",
          };
        }
        // This repo resolves to THIS account, but its keyring entry is gone. Every
        // fallback below re-resolves the global default, so continuing would push
        // as a different identity. Fail instead and let the user reconnect it.
        if (repoSpecific) return { refused: true };
      }
      // Legacy fallback for GitHub
      const tokenResult = await getGitHubToken();
      if (tokenResult.success && tokenResult.data) {
        return {
          token: tokenResult.data,
          remoteName: resolvedRemote,
          credentialHost: "github.com",
        };
      }
    }

    // Azure DevOps
    const adoRepoResult = await detectAdoRepo(repoPath, remoteName);
    if (
      adoRepoResult.success &&
      adoRepoResult.data &&
      (!remoteName || adoRepoResult.data.remoteName === remoteName)
    ) {
      const resolvedRemote = adoRepoResult.data.remoteName;
      const { account, repoSpecific } = await resolveRepoAccount(
        repoPath,
        "azure-devops",
        resolvedRemote,
      );
      if (account) {
        // Refresh the Entra OAuth access token if it is expiring, so push/pull/
        // fetch (which pass this token directly) keep working past the ~1h expiry.
        const { getFreshAccountToken } = await import("./credential.service.ts");
        const token = await getFreshAccountToken("azure-devops", account.id, "azure");
        if (token) {
          // Keep the OS keyring git credential fresh too, so EXTERNAL git CLI
          // operations (which read the keyring, not this returned token) also work
          // after a refresh. Only sync when the resolved account actually belongs
          // to THIS repo's org — otherwise, in a multi-account setup, a different
          // org's token would clobber the keyring credential for the repo's org.
          const accountOrg =
            account.config.type === "azure-devops" ? account.config.organization : undefined;
          if (accountOrg && accountOrg === adoRepoResult.data.organization) {
            await syncAdoGitCredentials(adoRepoResult.data.organization, token);
          }
          return {
            token,
            remoteName: resolvedRemote,
            accountId: account.id,
            integrationType: "azure-devops",
          };
        }
        // See the GitHub branch: a repo-specific account with no usable token
        // must not silently borrow the global default's.
        if (repoSpecific) return { refused: true };
      }
      // Legacy fallback for Azure DevOps
      const tokenResult = await getAdoToken();
      if (tokenResult.success && tokenResult.data) {
        return { token: tokenResult.data, remoteName: resolvedRemote };
      }
    }

    // GitLab
    const gitlabRepoResult = await detectGitLabRepo(repoPath, remoteName);
    if (
      gitlabRepoResult.success &&
      gitlabRepoResult.data &&
      (!remoteName || gitlabRepoResult.data.remoteName === remoteName)
    ) {
      const resolvedRemote = gitlabRepoResult.data.remoteName;
      const { account, repoSpecific } = await resolveRepoAccount(
        repoPath,
        "gitlab",
        resolvedRemote,
      );
      if (account) {
        // main refreshes an expiring OAuth access token before use; this branch
        // additionally pins the credential host, so keep both.
        const { getFreshAccountToken } = await import("./credential.service.ts");
        const token = await getFreshAccountToken(
          "gitlab",
          account.id,
          "gitlab",
          account.config.type === "gitlab" ? account.config.instanceUrl : undefined,
        );
        const credentialHost =
          account.config.type === "gitlab"
            ? cloneUrlHost(account.config.instanceUrl)
            : null;
        if (token && credentialHost) {
          return {
            token,
            remoteName: resolvedRemote,
            credentialHost,
            accountId: account.id,
            integrationType: "gitlab",
          };
        }
        // See the GitHub branch: a repo-specific account with no usable token
        // must not silently borrow the global default's.
        if (repoSpecific) return { refused: true };
      }
      // Legacy fallback for GitLab
      const detectedHost = cloneUrlHost(gitlabRepoResult.data.instanceUrl);
      if (detectedHost === "gitlab.com" || detectedHost?.endsWith(".gitlab.com")) {
        const tokenResult = await getGitLabToken();
        if (tokenResult.success && tokenResult.data) {
          return {
            token: tokenResult.data,
            remoteName: resolvedRemote,
            credentialHost: detectedHost,
          };
        }
      }
    }
  } catch (err) {
    console.error("Failed to auto-detect repository token:", err);
  }
  return {};
}

/**
 * Helper to get authentication token for a repository.
 *
 * Callers that pass the token straight to a backend command which authenticates
 * with git2 need only the token; callers that hand it to the git CLI want
 * `resolveRepoToken`, so the credential can be scoped to the right host.
 */
async function getRepoToken(
  repoPath: string,
  remoteName?: string,
): Promise<string | undefined> {
  return (await resolveRepoToken(repoPath, remoteName)).token;
}

async function getRemoteToken(
  repoPath: string,
  remoteName: string,
): Promise<string | undefined> {
  let resolved = await resolveRepoToken(repoPath, remoteName);
  if (!resolved.token && !resolved.refused) {
    resolved = await resolveRepoToken(repoPath);
  }
  if (!resolved.token || resolved.refused || !resolved.remoteName) return undefined;

  const [sourceUrl, targetUrl] = await Promise.all([
    resolveRemoteUrl(repoPath, resolved.remoteName),
    resolveRemoteUrl(repoPath, remoteName),
  ]);
  const sourceHost = sourceUrl ? cloneUrlHost(sourceUrl) : null;
  const targetHost = targetUrl ? cloneUrlHost(targetUrl) : null;
  return sourceHost &&
    targetHost &&
    sourceHost === targetHost &&
    (!resolved.credentialHost || resolved.credentialHost === targetHost) &&
    targetUrl &&
    cloneUrlIsCredentialSafe(targetUrl)
    ? resolved.token
    : undefined;
}

/**
 * Does the account an UNFILTERED lookup landed on also own `pushUrl`?
 *
 * The unfiltered fallback resolves the account for whichever remote the
 * provider detectors found first, which is routinely NOT the remote being
 * pushed to. Same host is not the same identity: two github.com remotes
 * (`origin` = the company repo, `personal-fork` = your own) belong to
 * different accounts, and an account's `urlPatterns` are matched per URL. So
 * ask the resolver who owns the push URL and only lend the token when the
 * answer is the same account.
 *
 * A lookup that cannot answer withholds the token, which is exactly what the
 * remote-scoped lookup did before this fallback existed.
 */
async function fallbackAccountOwnsPushUrl(
  repoPath: string,
  integrationType: IntegrationType,
  accountId: string,
  pushUrl: string,
): Promise<boolean> {
  try {
    // Dynamic import for the same cycle reason as resolveRepoAccount's.
    const { getAssignedUnifiedProfile, fetchRepositoryPreferredAccount } = await import(
      "./unified-profile.service.ts"
    );
    const profile = await getAssignedUnifiedProfile(repoPath).catch(() => null);
    const account = await fetchRepositoryPreferredAccount(
      profile?.id ?? "",
      integrationType,
      pushUrl,
    );
    return !!account && account.id === accountId;
  } catch (err) {
    console.error("Failed to resolve the push URL's account:", err);
    return false;
  }
}

async function getPushUrlToken(
  repoPath: string,
  remoteName: string,
  pushUrl: string,
): Promise<string | undefined> {
  let resolved = await resolveRepoToken(repoPath, remoteName);
  // The provider detectors report the FIRST remote they recognise, so a push to
  // any other remote never matches the name filter and resolves nothing. Retry
  // unfiltered so those pushes still get a credential — guarded below, because
  // an unfiltered answer is about a different remote.
  let unfiltered = false;
  if (!resolved.token && !resolved.refused) {
    resolved = await resolveRepoToken(repoPath);
    unfiltered = true;
  }
  if (!resolved.token || resolved.refused || !resolved.remoteName) return undefined;

  const fetchUrl = await resolveRemoteUrl(repoPath, resolved.remoteName);
  const fetchHost = fetchUrl ? cloneUrlHost(fetchUrl) : null;
  const pushHost = cloneUrlHost(pushUrl);
  // The plaintext gate applies to the UNFILTERED answer only. A remote-name
  // match resolved the token for the very remote being pushed to, which is
  // exactly what `push`, `fetch` and `pull` do with no transport check — gating
  // it here would break Push Tag and Delete tag on remote on a self-hosted
  // `http://` remote while the toolbar Push kept working, with nothing telling
  // the user why. The unfiltered fallback lends a token resolved for a
  // DIFFERENT remote, so it stays off cleartext transports.
  if (
    !fetchHost ||
    !pushHost ||
    fetchHost !== pushHost ||
    (unfiltered && !cloneUrlIsCredentialSafe(pushUrl))
  ) {
    return undefined;
  }
  if (
    unfiltered &&
    resolved.accountId &&
    resolved.integrationType &&
    !(await fallbackAccountOwnsPushUrl(
      repoPath,
      resolved.integrationType,
      resolved.accountId,
      pushUrl,
    ))
  ) {
    return undefined;
  }
  return resolved.token;
}

/**
 * Merge operations
 */
export async function merge(args: MergeCommand): Promise<CommandResult<void>> {
  return invokeCommand<void>("merge", args);
}

export async function abortMerge(
  args: AbortMergeCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_merge", args);
}

/**
 * Complete an in-progress merge after all conflicts are resolved: creates
 * the merge commit (HEAD + MERGE_HEAD parents) and clears the MERGING state.
 * When `squash` is true, a single-parent commit is created instead so a
 * conflicted gitflow squash finish completes as a squash rather than a merge.
 */
export async function commitMerge(
  path: string,
  message?: string,
  squash?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("commit_merge", { path, message, squash });
}

/**
 * Rebase operations
 */
/**
 * Resolves with the number of commits the rebase skipped because their patch
 * was already applied on the target — see `rebasedOntoMessage`.
 */
export async function rebase(
  args: RebaseCommand,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("rebase", args);
}

export interface RebasePreview {
  totalCommits: number;
  cleanCommits: number;
  conflictingCommits: number;
  conflicts: PredictedConflict[];
}

export interface PredictedConflict {
  filePath: string;
  commitSummary: string;
}

export async function previewRebase(
  path: string,
  onto: string,
): Promise<CommandResult<RebasePreview>> {
  return invokeCommand<RebasePreview>("preview_rebase", { path, onto });
}

/** Resolves with how many commits the rebase dropped as already applied. */
export async function continueRebase(
  args: ContinueRebaseCommand,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("continue_rebase", args);
}

export async function abortRebase(
  args: AbortRebaseCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_rebase", args);
}

export async function getRebaseCommits(
  path: string,
  onto: string,
): Promise<CommandResult<RebasePlan>> {
  return invokeCommand<RebasePlan>("get_rebase_commits", { path, onto });
}

/** Is `oid` reachable from HEAD? Gates the reword/amend rebase route. */
export async function isAncestorOfHead(
  path: string,
  oid: string,
): Promise<CommandResult<boolean>> {
  return invokeCommand<boolean>("is_ancestor_of_head", { path, oid });
}

export async function executeInteractiveRebase(
  path: string,
  onto: string,
  todo: string,
): Promise<CommandResult<InteractiveRebaseOutcome>> {
  return invokeCommand<InteractiveRebaseOutcome>("execute_interactive_rebase", {
    path,
    onto,
    todo,
  });
}

/**
 * Interactive rebase state management
 */
export async function getRebaseState(
  path: string,
): Promise<CommandResult<RebaseState>> {
  return invokeCommand<RebaseState>("get_rebase_state", { path });
}

export async function getRebaseTodo(
  path: string,
): Promise<CommandResult<RebaseTodo>> {
  return invokeCommand<RebaseTodo>("get_rebase_todo", { path });
}

export async function updateRebaseTodo(
  path: string,
  entries: RebaseTodoEntry[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("update_rebase_todo", { path, entries });
}

export async function skipRebaseCommit(
  path: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("skip_rebase_commit", { path });
}

/**
 * Conflict resolution operations
 */
export async function getConflicts(
  path: string,
): Promise<CommandResult<ConflictFile[]>> {
  return invokeCommand<ConflictFile[]>("get_conflicts", { path });
}

export async function getBlobContent(
  path: string,
  oid: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_blob_content", { path, oid });
}

export async function resolveConflict(
  path: string,
  filePath: string,
  content: string,
  deleteFile?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("resolve_conflict", {
    path,
    filePath,
    content,
    deleteFile,
  });
}

/**
 * Resolve a conflict by taking one side's blob verbatim (binary-safe).
 * If the chosen side deleted the file, the resolution is the file's removal.
 */
export async function resolveConflictTakeSide(
  path: string,
  filePath: string,
  side: "ours" | "theirs",
): Promise<CommandResult<void>> {
  return invokeCommand<void>("resolve_conflict_take_side", {
    path,
    filePath,
    side,
  });
}

/**
 * Detect conflict markers in files
 *
 * Scans for Git conflict markers (<<<<<<< ======= >>>>>>>) in working directory files.
 * @param path Repository path
 * @param filePath Optional specific file to scan. If not provided, scans all conflicted files.
 */
export async function detectConflictMarkers(
  path: string,
  filePath?: string,
): Promise<CommandResult<ConflictMarkerFile[]>> {
  return invokeCommand<ConflictMarkerFile[]>("detect_conflict_markers", {
    path,
    filePath,
  });
}

/**
 * Get detailed conflict information for a specific file
 *
 * Returns conflict details including ref names and marker positions
 * @param path Repository path
 * @param filePath Path to the conflicted file
 */
export async function getConflictDetails(
  path: string,
  filePath: string,
): Promise<CommandResult<ConflictDetails>> {
  return invokeCommand<ConflictDetails>("get_conflict_details", {
    path,
    filePath,
  });
}

/**
 * Cherry-pick operations
 */
export async function cherryPick(
  args: CherryPickCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("cherry_pick", args);
}

export async function continueCherryPick(
  args: ContinueCherryPickCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("continue_cherry_pick", args);
}

export async function abortCherryPick(
  args: AbortCherryPickCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_cherry_pick", args);
}

/**
 * Skip the stopped pick and resume the rest of the sequence
 * (`git cherry-pick --skip`). Resolves with the last commit the resumed
 * sequence created, or `null` when there was nothing left to apply.
 */
export async function skipCherryPick(
  args: SkipCherryPickCommand,
): Promise<CommandResult<Commit | null>> {
  return invokeCommand<Commit | null>("skip_cherry_pick", args);
}

/**
 * Revert operations
 */
export async function revert(
  args: RevertCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("revert", args);
}

export async function continueRevert(
  args: ContinueRevertCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("continue_revert", args);
}

export async function abortRevert(
  args: AbortRevertCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_revert", args);
}

/** Skip the stopped revert (`git revert --skip`). */
export async function skipRevert(
  args: SkipRevertCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("skip_revert", args);
}

/**
 * Reset operations
 */
export async function reset(args: ResetCommand): Promise<CommandResult<void>> {
  return invokeCommand<void>("reset", args);
}

/**
 * Squash operations
 */

/**
 * Squash a range of commits into a single commit
 * @param path - Repository path
 * @param fromOid - Parent commit (exclusive - commits after this are squashed)
 * @param toOid - Newest commit to squash (inclusive)
 * @param message - New commit message for the squashed commit
 */
export async function squashCommits(
  path: string,
  fromOid: string,
  toOid: string,
  message: string,
): Promise<CommandResult<SquashResult>> {
  return invokeCommand<SquashResult>("squash_commits", {
    path,
    fromOid,
    toOid,
    message,
  });
}

/**
 * Fixup staged changes into a specific commit
 * @param path - Repository path
 * @param targetOid - The commit to amend changes into
 * @param amendMessage - Optional new message for the commit (if not provided, keeps original)
 */
export async function fixupCommit(
  path: string,
  targetOid: string,
  amendMessage?: string,
): Promise<CommandResult<SquashResult>> {
  return invokeCommand<SquashResult>("fixup_commit", {
    path,
    targetOid,
    amendMessage,
  });
}

/**
 * Drop (remove) a commit from history
 * @param path - Repository path
 * @param commitOid - The OID of the commit to drop
 */
export async function dropCommit(
  path: string,
  commitOid: string,
): Promise<CommandResult<DropCommitResult>> {
  return invokeCommand<DropCommitResult>("drop_commit", {
    path,
    commitOid,
  });
}

/**
 * Reorder commits by replaying them in a new order (drag-and-drop reordering)
 * @param path - Repository path
 * @param baseCommit - Parent of the oldest commit to reorder (exclusive base)
 * @param commitOrder - New order of commit OIDs from oldest to newest
 */
export async function reorderCommits(
  path: string,
  baseCommit: string,
  commitOrder: string[],
): Promise<CommandResult<ReorderResult>> {
  return invokeCommand<ReorderResult>("reorder_commits", {
    path,
    baseCommit,
    commitOrder,
  });
}

/**
 * Stash operations
 */
export async function getStashes(
  path: string,
): Promise<CommandResult<Stash[]>> {
  return invokeCommand<Stash[]>("get_stashes", { path });
}

export async function createStash(
  args: CreateStashCommand,
): Promise<CommandResult<Stash | null>> {
  // Returns null when the working tree is clean (nothing to stash) — a benign
  // no-op mirroring `git stash push` ("No local changes to save"), not an error.
  return invokeCommand<Stash | null>("create_stash", args);
}

export async function applyStash(
  args: ApplyStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_stash", args);
}

export async function dropStash(
  args: DropStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("drop_stash", args);
}

export async function popStash(
  args: PopStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("pop_stash", args);
}

export async function stashShow(
  args: StashShowCommand,
): Promise<CommandResult<StashShowResult>> {
  return invokeCommand<StashShowResult>("stash_show", args);
}

/**
 * Tag operations
 */
export async function getTags(path: string): Promise<CommandResult<Tag[]>> {
  return invokeCommand<Tag[]>("get_tags", { path });
}

export async function createTag(
  args: CreateTagCommand,
): Promise<CommandResult<Tag>> {
  return invokeCommand<Tag>("create_tag", args);
}

export async function deleteTag(
  args: DeleteTagCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_tag", args);
}

export async function pushTag(
  args: PushTagCommand,
): Promise<CommandResult<void>> {
  const pushUrl = args.remote ? await resolveRemotePushUrl(args.path, args.remote) : null;
  if (!await checkNetworkPermission('push tag', args.path, args.remote, pushUrl)) {
    return blockedResult();
  }

  // push_tag takes a token and feeds it to the same credentials helper `push`
  // uses, but nothing ever supplied one — so on a token-authenticated HTTPS
  // remote the toolbar Push worked and "Push tag" failed with "No valid
  // credentials found".
  if (!args.token) {
    let token: string | undefined;
    if (args.remote && pushUrl) {
      token = await getPushUrlToken(args.path, args.remote, pushUrl);
    } else {
      // No push URL to scope against — `get_remotes` failed, or the remote is
      // not in the list. Dropping the credential here would fail the push with
      // "No valid credentials found"; fall back to the remote-scoped lookup,
      // which never needed the URL to reach a token.
      token = await getRepoToken(args.path, args.remote);
    }
    if (token) {
      args.token = token;
    }
  }

  return invokeCommand<void>("push_tag", args);
}

export async function getPushRemote(
  path: string,
  remote?: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_push_remote", {
    path,
    ...(remote ? { remote } : {}),
  });
}

/**
 * Delete a tag on a remote (`git push <remote> :refs/tags/<name>`).
 *
 * The local `deleteTag` above removes the local ref only, and the tag fetch
 * refspec copies a pushed tag straight back — so without this a "deleted" tag
 * reappeared on the next fetch.
 */
export async function deleteRemoteTag(
  args: DeleteRemoteTagCommand,
): Promise<CommandResult<void>> {
  const pushUrl = args.remote ? await resolveRemotePushUrl(args.path, args.remote) : null;
  if (!await checkNetworkPermission('delete remote tag', args.path, args.remote, pushUrl)) {
    return blockedResult();
  }

  // Same credential plumbing push_tag needs: without a token this fails with
  // "No valid credentials found" on a token-authenticated HTTPS remote.
  if (!args.token) {
    let token: string | undefined;
    if (args.remote && pushUrl) {
      token = await getPushUrlToken(args.path, args.remote, pushUrl);
    } else {
      // No push URL to scope against — `get_remotes` failed, or the remote is
      // not in the list. Dropping the credential here would fail the push with
      // "No valid credentials found"; fall back to the remote-scoped lookup,
      // which never needed the URL to reach a token.
      token = await getRepoToken(args.path, args.remote);
    }
    if (token) {
      args.token = token;
    }
  }

  return invokeCommand<void>("delete_remote_tag", args);
}

export async function getTagDetails(
  args: GetTagDetailsCommand,
): Promise<CommandResult<TagDetails>> {
  return invokeCommand<TagDetails>("get_tag_details", args);
}

export async function editTagMessage(
  args: EditTagMessageCommand,
): Promise<CommandResult<TagDetails>> {
  return invokeCommand<TagDetails>("edit_tag_message", args);
}

/**
 * Describe operations
 */

/**
 * Describe a commit using tags
 *
 * Returns the most recent tag reachable from a commit, with additional
 * information about commits since the tag and the commit hash.
 *
 * @param path - Repository path
 * @param options - Describe options
 * @returns Describe result with tag info, commits ahead, and commit hash
 */
export async function describeCommit(
  path: string,
  options?: DescribeOptions,
): Promise<CommandResult<DescribeResult>> {
  return invokeCommand<DescribeResult>("describe", {
    path,
    commitish: options?.commitish,
    tags: options?.tags,
    all: options?.all,
    long: options?.long,
    abbrev: options?.abbrev,
    matchPattern: options?.matchPattern,
    excludePattern: options?.excludePattern,
    firstParent: options?.firstParent,
    dirty: options?.dirty,
  });
}

/**
 * Diff operations
 */
export async function getDiff(
  args?: GetDiffCommand,
): Promise<CommandResult<DiffFile[]>> {
  return invokeCommand<DiffFile[]>("get_diff", args);
}

/**
 * Get diff with advanced options including whitespace handling,
 * custom context lines, and diff algorithm selection.
 *
 * @param options - Advanced diff options
 * @returns Array of diff files with hunks
 */
export async function getDiffWithOptions(
  options: GetDiffWithOptionsCommand,
): Promise<CommandResult<DiffFile[]>> {
  return invokeCommand<DiffFile[]>("get_diff_with_options", options);
}

export async function getFileDiff(
  repoPath: string,
  filePath: string,
  staged?: boolean,
  maxLines?: number,
): Promise<CommandResult<DiffFile>> {
  return invokeCommand<DiffFile>("get_file_diff", {
    path: repoPath,
    filePath,
    staged,
    maxLines,
  });
}

export async function getCommitFiles(
  repoPath: string,
  commitOid: string,
): Promise<CommandResult<CommitFileEntry[]>> {
  return invokeCommand<CommitFileEntry[]>("get_commit_files", {
    path: repoPath,
    commitOid,
  });
}

export async function getCommitFileDiff(
  repoPath: string,
  commitOid: string,
  filePath: string,
  maxLines?: number,
): Promise<CommandResult<DiffFile>> {
  return invokeCommand<DiffFile>("get_commit_file_diff", {
    path: repoPath,
    commitOid,
    filePath,
    maxLines,
  });
}

/**
 * Get stats (additions/deletions) for multiple commits in bulk
 * Optimized for graph view to show commit sizes
 * Uses caching to avoid redundant API calls
 */
export async function getCommitsStats(
  repoPath: string,
  commitOids: string[],
): Promise<CommandResult<CommitStats[]>> {
  // Check cache for already-fetched stats
  const cachedStats: CommitStats[] = [];
  const uncachedOids: string[] = [];

  for (const oid of commitOids) {
    const cacheKey = createCacheKey(repoPath, oid);
    const cached = commitStatsCache.get(cacheKey);
    if (cached) {
      cachedStats.push({
        oid,
        additions: cached.additions,
        deletions: cached.deletions,
        filesChanged: cached.filesChanged,
      });
    } else {
      uncachedOids.push(oid);
    }
  }

  // If all are cached, return immediately
  if (uncachedOids.length === 0) {
    return { success: true, data: cachedStats };
  }

  // Fetch uncached stats
  const result = await invokeCommand<CommitStats[]>("get_commits_stats", {
    path: repoPath,
    commitOids: uncachedOids,
  });

  if (!result.success || !result.data) {
    // Return cached ones even if fetch fails
    if (cachedStats.length > 0) {
      return { success: true, data: cachedStats };
    }
    return result;
  }

  // Cache the new stats
  for (const stat of result.data) {
    const cacheKey = createCacheKey(repoPath, stat.oid);
    commitStatsCache.set(cacheKey, {
      additions: stat.additions,
      deletions: stat.deletions,
      filesChanged: stat.filesChanged,
    });
  }

  // Combine cached and newly fetched
  return {
    success: true,
    data: [...cachedStats, ...result.data],
  };
}

/**
 * Get blame information for a file
 *
 * @param repoPath - Repository path
 * @param filePath - Path to the file to blame
 * @param commitOid - Optional commit to blame at (default: HEAD)
 * @param startLine - Optional start line for range blame (1-indexed)
 * @param endLine - Optional end line for range blame (1-indexed, inclusive)
 */
export async function getFileBlame(
  repoPath: string,
  filePath: string,
  commitOid?: string,
  startLine?: number,
  endLine?: number,
): Promise<CommandResult<BlameResult>> {
  return invokeCommand<BlameResult>("get_file_blame", {
    path: repoPath,
    filePath,
    commitOid,
    startLine,
    endLine,
  });
}

/**
 * Get image versions for comparison (old and new base64-encoded data)
 */
export async function getImageVersions(
  repoPath: string,
  filePath: string,
  staged?: boolean,
  commitOid?: string,
): Promise<CommandResult<ImageVersions>> {
  return invokeCommand<ImageVersions>("get_image_versions", {
    path: repoPath,
    filePath,
    staged,
    commitOid,
  });
}

/**
 * Get all commits that modified a specific file, each paired with the path the
 * file had in that commit (which differs from `filePath` before a rename).
 */
export async function getFileHistory(
  repoPath: string,
  filePath: string,
  limit?: number,
  followRenames?: boolean,
): Promise<CommandResult<FileHistoryEntry[]>> {
  return invokeCommand<FileHistoryEntry[]>("get_file_history", {
    path: repoPath,
    filePath,
    limit,
    followRenames,
  });
}

/**
 * Refs operations
 */
export async function getRefsByCommit(
  path: string,
): Promise<CommandResult<RefsByCommit>> {
  return invokeCommand<RefsByCommit>("get_refs_by_commit", { path });
}

/**
 * Shortlog operations - contributor commit summaries
 */
export interface ShortlogOptions {
  range?: string;
  all?: boolean;
  numbered?: boolean;
  summary?: boolean;
  email?: boolean;
  group?: "author" | "committer";
}

export interface ShortlogEntry {
  name: string;
  email: string | null;
  count: number;
  commits: string[];
}

export interface ShortlogResult {
  entries: ShortlogEntry[];
  totalCommits: number;
  totalContributors: number;
}

/**
 * Get shortlog - contributor commit summaries
 * Similar to `git shortlog`
 */
export async function getShortlog(
  path: string,
  options?: ShortlogOptions,
): Promise<CommandResult<ShortlogResult>> {
  return invokeCommand<ShortlogResult>("shortlog", {
    path,
    range: options?.range,
    all: options?.all,
    numbered: options?.numbered,
    summary: options?.summary,
    email: options?.email,
    group: options?.group,
  });
}

/**
 * Reflog operations
 */
export async function getReflog(
  repoPath: string,
  limit?: number,
): Promise<CommandResult<ReflogEntry[]>> {
  return invokeCommand<ReflogEntry[]>("get_reflog", { path: repoPath, limit });
}

/**
 * Reset HEAD to a reflog entry.
 *
 * `expectedOid` guards against the reflog shifting between listing and reset
 * (a commit or checkout from another window renumbers every entry). Pass the
 * oid the user was shown; the backend refuses if the position no longer holds
 * it. Omitting it skips the check.
 */
export async function resetToReflog(
  repoPath: string,
  reflogIndex: number,
  mode: "soft" | "mixed" | "hard" = "mixed",
  expectedOid?: string,
): Promise<CommandResult<ReflogEntry>> {
  return invokeCommand<ReflogEntry>("reset_to_reflog", {
    path: repoPath,
    reflogIndex,
    mode,
    expectedOid,
  });
}

/**
 * Undo/redo operations
 */
export async function getUndoHistory(
  repoPath: string,
  maxCount?: number,
): Promise<CommandResult<UndoHistory>> {
  return invokeCommand<UndoHistory>("get_undo_history", {
    path: repoPath,
    maxCount,
  });
}

export async function undoLastAction(
  repoPath: string,
): Promise<CommandResult<UndoAction>> {
  return invokeCommand<UndoAction>("undo_last_action", { path: repoPath });
}

export async function redoLastAction(
  repoPath: string,
): Promise<CommandResult<UndoAction>> {
  return invokeCommand<UndoAction>("redo_last_action", { path: repoPath });
}

export async function recordAction(
  repoPath: string,
  action: UndoAction,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("record_action", { path: repoPath, action });
}

/**
 * Clean operations
 */
export interface CleanEntry {
  path: string;
  isDirectory: boolean;
  isIgnored: boolean;
  /**
   * True when this entry is an untracked nested git repository. Deleting it
   * destroys the embedded repo's history, so `git clean` only removes it with a
   * second `-f`; the UI must confirm and pass `forceNested` to clean it.
   */
  isNestedRepo: boolean;
  size: number | null;
}

export async function getCleanableFiles(
  repoPath: string,
  includeIgnored?: boolean,
  includeDirectories?: boolean,
): Promise<CommandResult<CleanEntry[]>> {
  return invokeCommand<CleanEntry[]>("get_cleanable_files", {
    path: repoPath,
    includeIgnored,
    includeDirectories,
  });
}

export async function cleanFiles(
  repoPath: string,
  paths: string[],
  forceNested = false,
): Promise<CommandResult<number>> {
  // forceNested is required to remove untracked nested git repositories,
  // mirroring `git clean -ff`. Without it the backend refuses to delete them.
  return invokeCommand<number>("clean_files", {
    path: repoPath,
    paths,
    forceNested,
  });
}

export async function cleanAll(
  repoPath: string,
  includeIgnored?: boolean,
  includeDirectories?: boolean,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("clean_all", {
    path: repoPath,
    includeIgnored,
    includeDirectories,
  });
}

/**
 * Bisect operations
 */
export interface BisectLogEntry {
  commitOid: string;
  action: string;
  message: string | null;
}

export interface BisectStatus {
  active: boolean;
  currentCommit: string | null;
  badCommit: string | null;
  goodCommit: string | null;
  remaining: number | null;
  totalSteps: number | null;
  currentStep: number | null;
  log: BisectLogEntry[];
  /** Set once git has recorded the first bad commit; the session stays active until reset. */
  culprit: CulpritCommit | null;
}

export interface CulpritCommit {
  oid: string;
  summary: string;
  author: string;
  email: string;
}

export interface BisectStepResult {
  status: BisectStatus;
  culprit: CulpritCommit | null;
  message: string;
}

export async function getBisectStatus(
  repoPath: string,
): Promise<CommandResult<BisectStatus>> {
  return invokeCommand<BisectStatus>("get_bisect_status", { path: repoPath });
}

export async function bisectStart(
  repoPath: string,
  badCommit?: string,
  goodCommit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_start", {
    path: repoPath,
    badCommit,
    goodCommit,
  });
}

export async function bisectBad(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_bad", {
    path: repoPath,
    commit,
  });
}

export async function bisectGood(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_good", {
    path: repoPath,
    commit,
  });
}

export async function bisectSkip(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_skip", {
    path: repoPath,
    commit,
  });
}

export async function bisectReset(
  repoPath: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_reset", { path: repoPath });
}

/**
 * Submodule operations
 */
export type SubmoduleStatus =
  | "current"
  | "modified"
  | "uninitialized"
  | "missing"
  | "dirty";

export interface Submodule {
  name: string;
  path: string;
  url: string | null;
  headOid: string | null;
  branch: string | null;
  initialized: boolean;
  status: SubmoduleStatus;
}

export async function getSubmodules(
  repoPath: string,
): Promise<CommandResult<Submodule[]>> {
  return invokeCommand<Submodule[]>("get_submodules", { path: repoPath });
}

export async function addSubmodule(
  repoPath: string,
  url: string,
  submodulePath: string,
  branch?: string,
): Promise<CommandResult<Submodule>> {
  // `git submodule add` clones from `url` — a network operation despite living
  // among the local submodule commands.
  if (!await checkNetworkPermission('add submodule', null, url)) {
    return blockedResult();
  }
  return invokeCommand<Submodule>("add_submodule", {
    path: repoPath,
    url,
    submodulePath,
    branch,
  });
}

export async function initSubmodules(
  repoPath: string,
  submodulePaths?: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("init_submodules", {
    path: repoPath,
    submodulePaths,
  });
}

export async function updateSubmodules(
  repoPath: string,
  options?: {
    submodulePaths?: string[];
    init?: boolean;
    recursive?: boolean;
    remote?: boolean;
    token?: string;
    /**
     * The remote `token` belongs to. Required alongside an explicitly supplied
     * `token`: the backend scopes the credential it hands the git CLI to this
     * remote's host, and injects nothing when it cannot tell which host that is.
     */
    tokenRemote?: string;
  },
): Promise<CommandResult<void>> {
  // `git submodule update` fetches (and clones with --init), so it belongs
  // behind the same gate as fetch/pull.
  if (!await checkNetworkPermission('update submodules', repoPath)) {
    return blockedResult();
  }

  // Try to find a token if not provided. The remote it was resolved against
  // travels with it: the backend feeds it to the git CLI as a host-scoped
  // credential helper, and the lookup does NOT always settle on `origin` — a
  // repo whose origin is GitLab and whose upstream is GitHub yields a GitHub
  // token, which scoped to origin would leak to the GitLab host and never
  // reach the one it authenticates.
  let token = options?.token;
  let tokenRemote = options?.tokenRemote;
  if (!token) {
    const resolved = await resolveRepoToken(repoPath);
    token = resolved.token;
    tokenRemote = resolved.remoteName;
  }

  return invokeCommand<void>("update_submodules", {
    path: repoPath,
    submodulePaths: options?.submodulePaths,
    init: options?.init,
    recursive: options?.recursive,
    remote: options?.remote,
    token,
    tokenRemote,
  });
}

export async function syncSubmodules(
  repoPath: string,
  submodulePaths?: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("sync_submodules", {
    path: repoPath,
    submodulePaths,
  });
}

export async function deinitSubmodule(
  repoPath: string,
  submodulePath: string,
  force?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("deinit_submodule", {
    path: repoPath,
    submodulePath,
    force,
  });
}

export async function removeSubmodule(
  repoPath: string,
  submodulePath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_submodule", {
    path: repoPath,
    submodulePath,
  });
}

/**
 * Worktree operations
 */
export interface Worktree {
  path: string;
  headOid: string | null;
  branch: string | null;
  isMain: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isBare: boolean;
  isPrunable: boolean;
  /**
   * Resolved by the backend against the filesystem: true for the worktree the
   * repo path was opened at. Optional because test doubles and any pre-flag
   * payload simply omit it — consumers must fall back, never assume `false`
   * means "not current".
   */
  isCurrent?: boolean;
}

export async function getWorktrees(
  repoPath: string,
): Promise<CommandResult<Worktree[]>> {
  return invokeCommand<Worktree[]>("get_worktrees", { path: repoPath });
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  options?: {
    branch?: string;
    newBranch?: string;
    commit?: string;
    force?: boolean;
    detach?: boolean;
  },
): Promise<CommandResult<Worktree>> {
  return invokeCommand<Worktree>("add_worktree", {
    path: repoPath,
    worktreePath,
    branch: options?.branch,
    newBranch: options?.newBranch,
    commit: options?.commit,
    force: options?.force,
    detach: options?.detach,
  });
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_worktree", {
    path: repoPath,
    worktreePath,
    force,
  });
}

export async function pruneWorktrees(
  repoPath: string,
  dryRun?: boolean,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("prune_worktrees", {
    path: repoPath,
    dryRun,
  });
}

export async function lockWorktree(
  repoPath: string,
  worktreePath: string,
  reason?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("lock_worktree", {
    path: repoPath,
    worktreePath,
    reason,
  });
}

export async function unlockWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unlock_worktree", {
    path: repoPath,
    worktreePath,
  });
}

/**
 * Git LFS operations
 */
export interface LfsPattern {
  pattern: string;
}

export interface LfsFile {
  path: string;
  oid: string | null;
  size: number | null;
  downloaded: boolean;
}

export interface LfsStatus {
  installed: boolean;
  version: string | null;
  enabled: boolean;
  patterns: LfsPattern[];
  fileCount: number;
  totalSize: number;
}

export async function getLfsStatus(
  repoPath: string,
): Promise<CommandResult<LfsStatus>> {
  return invokeCommand<LfsStatus>("get_lfs_status", { path: repoPath });
}

export async function initLfs(repoPath: string): Promise<CommandResult<void>> {
  return invokeCommand<void>("init_lfs", { path: repoPath });
}

export async function lfsTrack(
  repoPath: string,
  pattern: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("lfs_track", { path: repoPath, pattern });
}

export async function lfsUntrack(
  repoPath: string,
  pattern: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("lfs_untrack", { path: repoPath, pattern });
}

export async function getLfsFiles(
  repoPath: string,
): Promise<CommandResult<LfsFile[]>> {
  return invokeCommand<LfsFile[]>("get_lfs_files", { path: repoPath });
}

export async function lfsPull(
  repoPath: string,
): Promise<CommandResult<string>> {
  if (!await checkNetworkPermission('LFS pull', repoPath)) {
    return blockedResult();
  }
  const token = await getRepoToken(repoPath);
  return invokeCommand<string>("lfs_pull", { path: repoPath, token });
}

export async function lfsFetch(
  repoPath: string,
  refs?: string[],
): Promise<CommandResult<string>> {
  if (!await checkNetworkPermission('LFS fetch', repoPath)) {
    return blockedResult();
  }
  const token = await getRepoToken(repoPath);
  return invokeCommand<string>("lfs_fetch", { path: repoPath, refs, token });
}

export async function lfsPrune(
  repoPath: string,
  dryRun?: boolean,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("lfs_prune", { path: repoPath, dryRun });
}

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

export async function getCommitSignature(
  repoPath: string,
  commitOid: string,
): Promise<CommandResult<CommitSignature>> {
  // Check the batch cache first to avoid redundant Tauri calls
  const cacheKey = createCacheKey(repoPath, commitOid);
  const cached = commitSignatureCache.get(cacheKey);
  if (cached) {
    return { success: true, data: cached as CommitSignature };
  }

  const result = await invokeCommand<CommitSignature>("get_commit_signature", {
    path: repoPath,
    commitOid,
  });

  // Cache the result for future lookups
  if (result.success && result.data) {
    commitSignatureCache.set(cacheKey, result.data);
  }

  return result;
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

export async function testCredentials(
  path: string,
  remoteUrl: string,
): Promise<CommandResult<CredentialTestResult>> {
  return invokeCommand<CredentialTestResult>("test_credentials", {
    path,
    remoteUrl,
  });
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
// GitHub Integration
// ============================================================================

export interface GitHubUser {
  login: string;
  id: number;
  avatarUrl: string;
  name: string | null;
  email: string | null;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  user: GitHubUser | null;
  scopes: string[];
}

export interface DetectedGitHubRepo {
  owner: string;
  repo: string;
  remoteName: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  mergeable: boolean | null;
  htmlUrl: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  htmlUrl: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  labels: Label[];
  assignees: GitHubUser[];
  reviewers: GitHubUser[];
}

export interface PullRequestReview {
  id: number;
  user: GitHubUser;
  body: string | null;
  state: string;
  submittedAt: string | null;
  htmlUrl: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowId: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runNumber: number;
  event: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

// Authentication (using OS keyring)
export async function storeGitHubToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { GitHubCredentials } = await import("./credential.service.ts");
    await GitHubCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getGitHubToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("./credential.service.ts");
    const account = selectDefaultGlobalAccount("github");
    if (account) {
      const token = await getFreshAccountToken("github", account.id, "github");
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { GitHubCredentials } = await import("./credential.service.ts");
    const token = await GitHubCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteGitHubToken(): Promise<CommandResult<void>> {
  try {
    const { GitHubCredentials } = await import("./credential.service.ts");
    await GitHubCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function checkGitHubConnection(): Promise<
  CommandResult<GitHubConnectionStatus>
> {
  // Get token from credential service and pass to backend
  const tokenResult = await getGitHubToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<GitHubConnectionStatus>("check_github_connection", {
    token,
  });
}

/**
 * Check GitHub connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkGitHubConnectionWithToken(
  token: string | null,
): Promise<CommandResult<GitHubConnectionStatus>> {
  return invokeProviderCommand<GitHubConnectionStatus>("check_github_connection", {
    token,
  });
}

// Repository Detection
export async function detectGitHubRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedGitHubRepo | null>> {
  return invokeCommand<DetectedGitHubRepo | null>("detect_github_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// Pull Requests
export async function listPullRequests(
  owner: string,
  repo: string,
  state?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<PullRequestSummary[]>> {
  return invokeProviderCommand<PullRequestSummary[]>("list_pull_requests", {
    owner,
    repo,
    state,
    perPage,
    page,
    token,
  });
}

export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<PullRequestDetails>> {
  return invokeProviderCommand<PullRequestDetails>("get_pull_request", {
    owner,
    repo,
    number,
    token,
  });
}

export async function createPullRequest(
  owner: string,
  repo: string,
  input: CreatePullRequestInput,
  token?: string | null,
): Promise<CommandResult<PullRequestSummary>> {
  return invokeProviderCommand<PullRequestSummary>("create_pull_request", {
    owner,
    repo,
    input,
    token,
  });
}

export async function getPullRequestReviews(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<PullRequestReview[]>> {
  return invokeProviderCommand<PullRequestReview[]>("get_pull_request_reviews", {
    owner,
    repo,
    number,
    token,
  });
}

// GitHub Actions
export async function getWorkflowRuns(
  owner: string,
  repo: string,
  branch?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<WorkflowRun[]>> {
  return invokeProviderCommand<WorkflowRun[]>("get_workflow_runs", {
    owner,
    repo,
    branch,
    perPage,
    page,
    token,
  });
}

export async function getCheckRuns(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string | null,
): Promise<CommandResult<CheckRun[]>> {
  return invokeProviderCommand<CheckRun[]>("get_check_runs", {
    owner,
    repo,
    commitSha,
    token,
  });
}

export async function getCommitStatus(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string | null,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_commit_status", {
    owner,
    repo,
    commitSha,
    token,
  });
}

// GitHub Issues

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  user: GitHubUser;
  labels: Label[];
  assignees: GitHubUser[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  htmlUrl: string;
  body: string | null;
}

/**
 * One page of issues plus the cursor for the next request.
 *
 * The `/issues` endpoint returns pull requests alongside issues and the backend
 * filters them out, so the length of `issues` says nothing about whether more
 * exist — `nextPage` carries that answer instead. `null` means the list ends
 * here.
 */
export interface IssuePage {
  issues: IssueSummary[];
  nextPage: number | null;
}

export interface IssueComment {
  id: number;
  user: GitHubUser;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export async function listIssues(
  owner: string,
  repo: string,
  state?: string,
  labels?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<IssuePage>> {
  return invokeProviderCommand<IssuePage>("list_issues", {
    owner,
    repo,
    state,
    labels,
    perPage,
    page,
    token,
  });
}

export async function getIssue(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("get_issue", {
    owner,
    repo,
    number,
    token,
  });
}

export async function createIssue(
  owner: string,
  repo: string,
  input: CreateIssueInput,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("create_issue", {
    owner,
    repo,
    input,
    token,
  });
}

export async function updateIssueState(
  owner: string,
  repo: string,
  number: number,
  state: string,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("update_issue_state", {
    owner,
    repo,
    number,
    state,
    token,
  });
}

export async function getIssueComments(
  owner: string,
  repo: string,
  number: number,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<IssueComment[]>> {
  return invokeProviderCommand<IssueComment[]>("get_issue_comments", {
    owner,
    repo,
    number,
    perPage,
    token,
  });
}

export async function addIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  token?: string | null,
): Promise<CommandResult<IssueComment>> {
  return invokeProviderCommand<IssueComment>("add_issue_comment", {
    owner,
    repo,
    number,
    body,
    token,
  });
}

export async function getRepoLabels(
  owner: string,
  repo: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<Label[]>> {
  return invokeProviderCommand<Label[]>("get_repo_labels", {
    owner,
    repo,
    perPage,
    token,
  });
}

// Issue Reference Utilities

export interface IssueReference {
  number: number;
  keyword: string | null; // 'fixes', 'closes', 'resolves', etc. or null for plain #123
  fullMatch: string;
}

/**
 * Parse issue references from commit message text.
 * Detects patterns like: #123, fixes #123, closes #123, resolves #123
 */
export function parseIssueReferences(text: string): IssueReference[] {
  const references: IssueReference[] = [];
  const seen = new Set<number>();

  // Keywords that GitHub recognizes for auto-closing issues
  const keywords = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];
  const keywordPattern = keywords.join("|");

  // Match keyword + issue reference (e.g., "fixes #123" or "fix #123")
  const keywordRegex = new RegExp(`\\b(${keywordPattern})\\s+#(\\d+)\\b`, "gi");
  let match;

  while ((match = keywordRegex.exec(text)) !== null) {
    const num = parseInt(match[2], 10);
    if (!seen.has(num)) {
      seen.add(num);
      references.push({
        number: num,
        keyword: match[1].toLowerCase(),
        fullMatch: match[0],
      });
    }
  }

  // Match standalone issue references (e.g., "#123" not preceded by a keyword)
  const standaloneRegex = /#(\d+)\b/g;
  while ((match = standaloneRegex.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (!seen.has(num)) {
      seen.add(num);
      references.push({
        number: num,
        keyword: null,
        fullMatch: match[0],
      });
    }
  }

  return references;
}

/**
 * Check if a keyword indicates the issue should be closed
 */
export function isClosingKeyword(keyword: string | null): boolean {
  if (!keyword) return false;
  const closingKeywords = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];
  return closingKeywords.includes(keyword.toLowerCase());
}

// GitHub Releases

export interface ReleaseSummary {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  htmlUrl: string;
  author: GitHubUser;
  assetsCount: number;
}

export interface CreateReleaseInput {
  tagName: string;
  targetCommitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  generateReleaseNotes?: boolean;
}

export async function listReleases(
  owner: string,
  repo: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary[]>> {
  return invokeProviderCommand<ReleaseSummary[]>("list_releases", {
    owner,
    repo,
    perPage,
    page,
    token,
  });
}

export async function getReleaseByTag(
  owner: string,
  repo: string,
  tag: string,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("get_release_by_tag", {
    owner,
    repo,
    tag,
    token,
  });
}

export async function getLatestRelease(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("get_latest_release", {
    owner,
    repo,
    token,
  });
}

export async function createRelease(
  owner: string,
  repo: string,
  input: CreateReleaseInput,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("create_release", {
    owner,
    repo,
    input,
    token,
  });
}

export async function deleteRelease(
  owner: string,
  repo: string,
  releaseId: number,
  token?: string | null,
): Promise<CommandResult<void>> {
  return invokeProviderCommand<void>("delete_release", {
    owner,
    repo,
    releaseId,
    token,
  });
}

// =======================
// Azure DevOps Integration
// =======================

export interface AdoUser {
  id: string;
  displayName: string;
  uniqueName: string;
  imageUrl: string | null;
}

export interface AdoConnectionStatus {
  connected: boolean;
  user: AdoUser | null;
  organization: string | null;
}

export interface DetectedAdoRepo {
  organization: string;
  project: string;
  repository: string;
  remoteName: string;
}

export interface AdoOrganization {
  id: string;
  name: string;
  url: string;
}

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description: string | null;
  status: string;
  createdBy: AdoUser;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft: boolean;
  url: string;
  repositoryId: string;
}

export interface CreateAdoPullRequestInput {
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
}

export interface AdoWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo: AdoUser | null;
  createdDate: string;
  url: string;
}

export interface AdoPipelineRun {
  id: number;
  name: string;
  state: string;
  result: string | null;
  createdDate: string;
  finishedDate: string | null;
  sourceBranch: string;
  url: string;
}

// Azure DevOps Token Management (using OS keyring)

export async function storeAdoToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { AzureDevOpsCredentials } = await import("./credential.service.ts");
    await AzureDevOpsCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getAdoToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("./credential.service.ts");
    const account = selectDefaultGlobalAccount("azure-devops");
    if (account) {
      // Refresh an expiring Entra OAuth token so callers get a valid one.
      const token = await getFreshAccountToken("azure-devops", account.id, "azure");
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { AzureDevOpsCredentials } = await import("./credential.service.ts");
    const token = await AzureDevOpsCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteAdoToken(): Promise<CommandResult<void>> {
  try {
    const { AzureDevOpsCredentials } = await import("./credential.service.ts");
    await AzureDevOpsCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// Azure DevOps Connection

export async function checkAdoConnection(
  organization: string,
): Promise<CommandResult<AdoConnectionStatus>> {
  // Get token from credential service and pass to backend
  const tokenResult = await getAdoToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<AdoConnectionStatus>("check_ado_connection", {
    organization,
    token,
  });
}

/**
 * Check Azure DevOps connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkAdoConnectionWithToken(
  organization: string,
  token: string | null,
): Promise<CommandResult<AdoConnectionStatus>> {
  return invokeProviderCommand<AdoConnectionStatus>("check_ado_connection", {
    organization,
    token,
  });
}

/**
 * List the Azure DevOps organizations the authenticated user belongs to.
 * Used to auto-resolve the organization after an Entra sign-in when it can't be
 * detected from the repo remote.
 */
export async function listAdoOrganizations(
  token?: string | null,
): Promise<CommandResult<AdoOrganization[]>> {
  return invokeProviderCommand<AdoOrganization[]>("list_ado_organizations", { token });
}

export async function detectAdoRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedAdoRepo | null>> {
  return invokeCommand<DetectedAdoRepo | null>("detect_ado_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// Azure DevOps Pull Requests

export async function listAdoPullRequests(
  organization: string,
  project: string,
  repository: string,
  status?: string,
  top?: number,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest[]>> {
  return invokeProviderCommand<AdoPullRequest[]>("list_ado_pull_requests", {
    organization,
    project,
    repository,
    status,
    top,
    token,
  });
}

export async function getAdoPullRequest(
  organization: string,
  project: string,
  repository: string,
  pullRequestId: number,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest>> {
  return invokeProviderCommand<AdoPullRequest>("get_ado_pull_request", {
    organization,
    project,
    repository,
    pullRequestId,
    token,
  });
}

export async function createAdoPullRequest(
  organization: string,
  project: string,
  repository: string,
  input: CreateAdoPullRequestInput,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest>> {
  return invokeProviderCommand<AdoPullRequest>("create_ado_pull_request", {
    organization,
    project,
    repository,
    input,
    token,
  });
}

// Azure DevOps Work Items

export async function getAdoWorkItems(
  organization: string,
  project: string,
  ids: number[],
  token?: string | null,
): Promise<CommandResult<AdoWorkItem[]>> {
  return invokeProviderCommand<AdoWorkItem[]>("get_ado_work_items", {
    organization,
    project,
    ids,
    token,
  });
}

export async function queryAdoWorkItems(
  organization: string,
  project: string,
  state?: string,
  limit?: number,
  token?: string | null,
): Promise<CommandResult<AdoWorkItem[]>> {
  return invokeProviderCommand<AdoWorkItem[]>("query_ado_work_items", {
    organization,
    project,
    state,
    limit,
    token,
  });
}

export interface CreateAdoWorkItemInput {
  workItemType?: string;
  title: string;
  description?: string;
  /** Identity (unique name / UPN) to assign the new work item to. */
  assignedTo?: string;
}

export async function createAzureDevOpsWorkItem(
  organization: string,
  project: string,
  input: CreateAdoWorkItemInput,
  token?: string | null,
): Promise<CommandResult<AdoWorkItem>> {
  return invokeProviderCommand<AdoWorkItem>("create_azure_devops_work_item", {
    organization,
    project,
    input,
    token,
  });
}

// Azure DevOps Pipelines

export async function listAdoPipelineRuns(
  organization: string,
  project: string,
  repository: string,
  top?: number,
  token?: string | null,
): Promise<CommandResult<AdoPipelineRun[]>> {
  return invokeProviderCommand<AdoPipelineRun[]>("list_ado_pipeline_runs", {
    organization,
    project,
    repository,
    top,
    token,
  });
}

// =======================
// GitLab Integration
// =======================

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatarUrl: string | null;
  webUrl: string;
}

export interface GitLabConnectionStatus {
  connected: boolean;
  user: GitLabUser | null;
  instanceUrl: string;
}

export interface DetectedGitLabRepo {
  instanceUrl: string;
  projectPath: string;
  remoteName: string;
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  author: GitLabUser;
  createdAt: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  webUrl: string;
  mergeStatus: string;
}

export interface CreateMergeRequestInput {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  author: GitLabUser;
  assignees: GitLabUser[];
  labels: string[];
  createdAt: string;
  webUrl: string;
}

export interface CreateGitLabIssueInput {
  title: string;
  description?: string;
  labels?: string[];
}

export interface GitLabPipeline {
  id: number;
  iid: number;
  status: string;
  source: string;
  ref: string;
  sha: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
}

// GitLab Token Management (using OS keyring)
export async function storeGitLabToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { GitLabCredentials } = await import("./credential.service.ts");
    await GitLabCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getGitLabToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("./credential.service.ts");
    const account = selectDefaultGlobalAccount("gitlab");
    if (account) {
      const token = await getFreshAccountToken(
        "gitlab",
        account.id,
        "gitlab",
        account.config.type === "gitlab" ? account.config.instanceUrl : undefined,
      );
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { GitLabCredentials } = await import("./credential.service.ts");
    const token = await GitLabCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteGitLabToken(): Promise<CommandResult<void>> {
  try {
    const { GitLabCredentials } = await import("./credential.service.ts");
    await GitLabCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// GitLab Connection

export async function checkGitLabConnection(
  instanceUrl: string,
): Promise<CommandResult<GitLabConnectionStatus>> {
  // Get token from credential service and pass to backend
  const tokenResult = await getGitLabToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<GitLabConnectionStatus>("check_gitlab_connection", {
    instanceUrl,
    token,
  });
}

/**
 * Check GitLab connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkGitLabConnectionWithToken(
  instanceUrl: string,
  token: string | null,
): Promise<CommandResult<GitLabConnectionStatus>> {
  return invokeProviderCommand<GitLabConnectionStatus>("check_gitlab_connection", {
    instanceUrl,
    token,
  });
}

export async function detectGitLabRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedGitLabRepo | null>> {
  return invokeCommand<DetectedGitLabRepo | null>("detect_gitlab_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// GitLab Merge Requests

export async function listGitLabMergeRequests(
  instanceUrl: string,
  projectPath: string,
  state?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest[]>> {
  return invokeProviderCommand<GitLabMergeRequest[]>("list_gitlab_merge_requests", {
    instanceUrl,
    projectPath,
    state,
    perPage,
    token,
  });
}

export async function getGitLabMergeRequest(
  instanceUrl: string,
  projectPath: string,
  mrIid: number,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest>> {
  return invokeProviderCommand<GitLabMergeRequest>("get_gitlab_merge_request", {
    instanceUrl,
    projectPath,
    mrIid,
    token,
  });
}

export async function createGitLabMergeRequest(
  instanceUrl: string,
  projectPath: string,
  input: CreateMergeRequestInput,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest>> {
  return invokeProviderCommand<GitLabMergeRequest>("create_gitlab_merge_request", {
    instanceUrl,
    projectPath,
    input,
    token,
  });
}

// GitLab Issues

export async function listGitLabIssues(
  instanceUrl: string,
  projectPath: string,
  state?: string,
  labels?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabIssue[]>> {
  return invokeProviderCommand<GitLabIssue[]>("list_gitlab_issues", {
    instanceUrl,
    projectPath,
    state,
    labels,
    perPage,
    token,
  });
}

export async function createGitLabIssue(
  instanceUrl: string,
  projectPath: string,
  input: CreateGitLabIssueInput,
  token?: string | null,
): Promise<CommandResult<GitLabIssue>> {
  return invokeProviderCommand<GitLabIssue>("create_gitlab_issue", {
    instanceUrl,
    projectPath,
    input,
    token,
  });
}

// GitLab Pipelines

export async function listGitLabPipelines(
  instanceUrl: string,
  projectPath: string,
  status?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabPipeline[]>> {
  return invokeProviderCommand<GitLabPipeline[]>("list_gitlab_pipelines", {
    instanceUrl,
    projectPath,
    status,
    perPage,
    token,
  });
}

export async function getGitLabLabels(
  instanceUrl: string,
  projectPath: string,
  token?: string | null,
): Promise<CommandResult<string[]>> {
  return invokeProviderCommand<string[]>("get_gitlab_labels", {
    instanceUrl,
    projectPath,
    token,
  });
}

// =======================
// Bitbucket Integration
// =======================

export interface BitbucketUser {
  uuid: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface BitbucketConnectionStatus {
  connected: boolean;
  user: BitbucketUser | null;
}

export interface DetectedBitbucketRepo {
  workspace: string;
  repoSlug: string;
  remoteName: string;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: BitbucketUser;
  createdOn: string;
  sourceBranch: string;
  destinationBranch: string;
  url: string;
}

export interface CreateBitbucketPullRequestInput {
  title: string;
  description?: string;
  sourceBranch: string;
  destinationBranch: string;
  closeSourceBranch?: boolean;
}

export interface BitbucketIssue {
  id: number;
  title: string;
  content: string | null;
  state: string;
  priority: string;
  kind: string;
  reporter: BitbucketUser | null;
  assignee: BitbucketUser | null;
  createdOn: string;
  url: string;
}

export interface BitbucketPipeline {
  uuid: string;
  buildNumber: number;
  stateName: string;
  resultName: string | null;
  targetBranch: string;
  createdOn: string;
  completedOn: string | null;
  url: string;
}

// Bitbucket Credential Management (using OS keyring)

export async function storeBitbucketCredentials(
  username: string,
  appPassword: string,
): Promise<CommandResult<void>> {
  try {
    const { BitbucketCredentials } = await import("./credential.service.ts");
    await BitbucketCredentials.setCredentials(username, appPassword);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getBitbucketCredentials(): Promise<
  CommandResult<[string, string] | null>
> {
  try {
    const { BitbucketCredentials } = await import("./credential.service.ts");
    const creds = await BitbucketCredentials.getCredentials();
    if (creds) {
      return { success: true, data: [creds.username, creds.password] };
    }
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteBitbucketCredentials(): Promise<
  CommandResult<void>
> {
  try {
    const { BitbucketCredentials } = await import("./credential.service.ts");
    await BitbucketCredentials.deleteCredentials();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// Bitbucket Connection

export async function checkBitbucketConnection(): Promise<
  CommandResult<BitbucketConnectionStatus>
> {
  // Get credentials from credential service and pass to backend
  const credsResult = await getBitbucketCredentials();
  let username: string | null = null;
  let appPassword: string | null = null;
  if (credsResult.success && credsResult.data) {
    [username, appPassword] = credsResult.data;
  }
  return invokeProviderCommand<BitbucketConnectionStatus>(
    "check_bitbucket_connection",
    { username, appPassword },
  );
}

/**
 * Check Bitbucket connection with a specific OAuth token
 */
export async function checkBitbucketConnectionWithToken(
  token: string,
): Promise<CommandResult<BitbucketConnectionStatus>> {
  return invokeProviderCommand<BitbucketConnectionStatus>(
    "check_bitbucket_connection_with_token",
    { token },
  );
}

export async function detectBitbucketRepo(
  path: string,
): Promise<CommandResult<DetectedBitbucketRepo | null>> {
  return invokeCommand<DetectedBitbucketRepo | null>("detect_bitbucket_repo", {
    path,
  });
}

// Bitbucket Pull Requests

export async function listBitbucketPullRequests(
  workspace: string,
  repoSlug: string,
  state?: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest[]>> {
  return invokeProviderCommand<BitbucketPullRequest[]>("list_bitbucket_pull_requests", {
    workspace,
    repoSlug,
    state,
    pagelen,
    token,
  });
}

export async function getBitbucketPullRequest(
  workspace: string,
  repoSlug: string,
  prId: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest>> {
  return invokeProviderCommand<BitbucketPullRequest>("get_bitbucket_pull_request", {
    workspace,
    repoSlug,
    prId,
    token,
  });
}

export async function createBitbucketPullRequest(
  workspace: string,
  repoSlug: string,
  input: CreateBitbucketPullRequestInput,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest>> {
  return invokeProviderCommand<BitbucketPullRequest>("create_bitbucket_pull_request", {
    workspace,
    repoSlug,
    input,
    token,
  });
}

// Bitbucket Issues

export async function listBitbucketIssues(
  workspace: string,
  repoSlug: string,
  state?: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketIssue[]>> {
  return invokeProviderCommand<BitbucketIssue[]>("list_bitbucket_issues", {
    workspace,
    repoSlug,
    state,
    pagelen,
    token,
  });
}

export interface CreateBitbucketIssueInput {
  title: string;
  content?: string;
  kind?: string;
  priority?: string;
}

export async function createBitbucketIssue(
  workspace: string,
  repoSlug: string,
  input: CreateBitbucketIssueInput,
  token?: string | null,
): Promise<CommandResult<BitbucketIssue>> {
  return invokeProviderCommand<BitbucketIssue>("create_bitbucket_issue", {
    workspace,
    repoSlug,
    input,
    token,
  });
}

// Bitbucket Pipelines

export async function listBitbucketPipelines(
  workspace: string,
  repoSlug: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPipeline[]>> {
  return invokeProviderCommand<BitbucketPipeline[]>("list_bitbucket_pipelines", {
    workspace,
    repoSlug,
    pagelen,
    token,
  });
}

// ============================================================================
// Commit Templates
// ============================================================================

export interface CommitTemplate {
  id: string;
  name: string;
  content: string;
  isConventional: boolean;
  createdAt: number;
}

export interface ConventionalType {
  typeName: string;
  description: string;
  emoji?: string;
}

/**
 * Get commit template from git config or .gitmessage file
 */
export async function getCommitTemplate(
  repoPath: string,
): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>("get_commit_template", {
    path: repoPath,
  });
}

/**
 * List all saved commit templates
 */
export async function listTemplates(): Promise<
  CommandResult<CommitTemplate[]>
> {
  return invokeCommand<CommitTemplate[]>("list_templates", {});
}

/**
 * Save a commit template
 */
export async function saveTemplate(
  template: CommitTemplate,
): Promise<CommandResult<CommitTemplate>> {
  return invokeCommand<CommitTemplate>("save_template", { template });
}

/**
 * Delete a commit template
 */
export async function deleteTemplate(id: string): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_template", { id });
}

/**
 * Get conventional commit types
 */
export async function getConventionalTypes(): Promise<
  CommandResult<ConventionalType[]>
> {
  return invokeCommand<ConventionalType[]>("get_conventional_types", {});
}

// ============================================================================
// PR/MR Templates
// ============================================================================

/** A detected pull request / merge request template */
export interface PrTemplate {
  /** Display name derived from the file name */
  name: string;
  /** Relative path to the template from the repo root */
  path: string;
  /** Whether this is the default template */
  isDefault: boolean;
}

/**
 * Detect PR/MR templates in a repository.
 * Searches well-known GitHub and GitLab template locations.
 */
export async function getPrTemplates(
  repoPath: string,
): Promise<CommandResult<PrTemplate[]>> {
  return invokeCommand<PrTemplate[]>("get_pr_templates", {
    path: repoPath,
  });
}

/**
 * Read the content of a specific PR/MR template.
 */
export async function getPrTemplateContent(
  repoPath: string,
  templatePath: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_pr_template_content", {
    path: repoPath,
    templatePath,
  });
}

// ============================================================================
// Issue Templates
// ============================================================================

/** A detected issue template */
export interface IssueTemplate {
  /** Display name derived from the file name */
  name: string;
  /** Relative path to the template from the repo root */
  path: string;
  /** Whether this is the default template */
  isDefault: boolean;
  /** Optional description extracted from YAML front matter */
  description: string | null;
}

/**
 * Detect issue templates in a repository.
 * Searches well-known GitHub and GitLab template locations.
 */
export async function getIssueTemplates(
  repoPath: string,
): Promise<CommandResult<IssueTemplate[]>> {
  return invokeCommand<IssueTemplate[]>("get_issue_templates", {
    path: repoPath,
  });
}

/**
 * Read the content of a specific issue template.
 */
export async function getIssueTemplateContent(
  repoPath: string,
  templatePath: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_issue_template_content", {
    path: repoPath,
    templatePath,
  });
}

// ============================================================================
// Auto-fetch
// ============================================================================

export interface RemoteStatus {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  upstreamName?: string;
}

/**
 * Start auto-fetching for a repository
 */
export async function startAutoFetch(
  repoPath: string,
  intervalMinutes: number,
): Promise<CommandResult<void>> {
  const resolved = await invokeCommand<string>("get_fetch_remote", { path: repoPath });
  if (!resolved.success || !resolved.data) {
    return { success: false, error: resolved.error };
  }
  const remote = resolved.data;
  const remoteUrl = await resolveRemoteUrl(repoPath, remote);
  if (!remoteUrl) {
    return {
      success: false,
      error: {
        code: "REMOTE_NOT_FOUND",
        message: `Could not resolve URL for remote "${remote}"`,
      },
    };
  }

  // Hard blocks only: the background loop is not a gesture the user is standing
  // in front of, so a confirm here would be a dialog out of nowhere. Offline
  // mode and the allowlist still apply — otherwise "offline" leaks a fetch
  // every N minutes.
  if (await checkNetworkAllowed(repoPath, remote, true)) {
    return blockedResult();
  }

  // The background loop authenticates with whatever token we hand it; without
  // one it could only ever use SSH or an OS-keyring credential, so auto-fetch
  // failed silently on token-authenticated HTTPS remotes.
  const token = await getRemoteToken(repoPath, remote);

  return invokeCommand<void>("start_auto_fetch", {
    path: repoPath,
    intervalMinutes,
    remote,
    remoteUrl,
    token,
  });
}

export async function triggerAutoFetch(repoPath: string): Promise<CommandResult<void>> {
  return invokeCommand<void>("trigger_auto_fetch", { path: repoPath });
}

/**
 * Stop auto-fetching for a repository
 */
export async function stopAutoFetch(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stop_auto_fetch", { path: repoPath });
}

/**
 * Check if auto-fetch is running for a repository
 */
export async function isAutoFetchRunning(
  repoPath: string,
): Promise<CommandResult<boolean>> {
  return invokeCommand<boolean>("is_auto_fetch_running", { path: repoPath });
}

/**
 * Get remote status (ahead/behind counts)
 */
export async function getRemoteStatus(
  repoPath: string,
): Promise<CommandResult<RemoteStatus>> {
  return invokeCommand<RemoteStatus>("get_remote_status", { path: repoPath });
}

// ============================================================================
// Remote Operation Events
// ============================================================================

/**
 * Result of a remote operation (fetch/pull/push) emitted by the backend
 */
export interface RemoteOperationResult {
  operation: string;
  remote: string;
  /** Repository the operation ran on, so a late completion refreshes the right tab. */
  repoPath: string;
  success: boolean;
  message: string;
  /**
   * IPC error code of a failed completion (MERGE_CONFLICT, REBASE_CONFLICT,
   * ...) — the same code the command itself would have returned.
   *
   * `null`, not absent, on a successful completion: the Rust field is an
   * `Option<String>` with no skip, so the wire always carries the key — the
   * same shape every other Option-backed field is typed with.
   */
  errorCode: string | null;
  /** Arrived after the command already reported a timeout to its caller. */
  late: boolean;
}

let remoteOperationUnlisten: UnlistenFn | null = null;

/**
 * Set up listeners for remote operation events (fetch/pull/push completions).
 * These are particularly useful for auto-fetch and other background operations.
 * Call this once when the app starts.
 */
export async function setupRemoteOperationListeners(): Promise<void> {
  // Only set up once
  if (remoteOperationUnlisten) {
    return;
  }

  remoteOperationUnlisten = await listenToEvent<RemoteOperationResult>(
    "remote-operation-completed",
    (result) => {
      // A pull or push that lands AFTER the command reported a timeout has
      // already changed refs and the working tree, and the caller that would
      // normally refresh returned an error long ago. Say so plainly and
      // refresh the repository it actually changed — pinned by repoPath, since
      // the user may have switched tabs in the minutes since.
      if (result.late) {
        // A late pull that ended in conflicts is not merely "a pull that
        // failed": MERGE_HEAD (or the rebase state) is on disk and the only
        // way out is the conflict dialog's Complete/Abort. app-shell's normal
        // pull path keys that off the error CODE, so route a late conflict
        // into the very same flow instead of leaving a red toast and a
        // repository stuck mid-merge.
        const conflict =
          result.errorCode === "MERGE_CONFLICT" ||
          result.errorCode === "REBASE_CONFLICT";
        showToast(
          result.message,
          result.success || conflict ? "warning" : "error",
          8000,
        );
        // `merge-conflict` is bound on the app-shell ELEMENT, not on window —
        // a window dispatch would be orphaned. The handler pins the dialog to
        // repositoryPath and refreshes that repo, so no extra refresh here.
        // The tag is `lv-app-shell` (see the @customElement in app-shell.ts);
        // querying "app-shell" found nothing in the real UI, so every late
        // conflict fell through to the plain refresh below and left the
        // repository mid-merge with no dialog.
        const shell = conflict ? document.querySelector("lv-app-shell") : null;
        if (shell) {
          shell.dispatchEvent(
            new CustomEvent("merge-conflict", {
              detail: {
                repositoryPath: result.repoPath,
                operationType:
                  result.errorCode === "REBASE_CONFLICT" ? "rebase" : "merge",
              },
            }),
          );
          return;
        }
        if (result.repoPath) {
          window.dispatchEvent(
            new CustomEvent("repository-refresh", {
              detail: { repoPath: result.repoPath },
            }),
          );
        }
        return;
      }

      // Show toast notifications for all remote operations
      if (result.success) {
        // Success notifications
        switch (result.operation) {
          case "fetch":
            showToast(`Fetched from ${result.remote}`, "success", 3000);
            break;
          case "pull":
            showToast(result.message || `Pulled from ${result.remote}`, "success", 3000);
            break;
          case "push":
            showToast(result.message || `Pushed to ${result.remote}`, "success", 3000);
            break;
          default:
            showToast(result.message, "success", 3000);
        }
      } else {
        // Error notifications
        showErrorWithSuggestion(result.message, `${result.operation} failed`, { operation: result.operation });
      }
    },
  );
}

/**
 * Clean up remote operation listeners (call on app unmount)
 */
export function cleanupRemoteOperationListeners(): void {
  if (remoteOperationUnlisten) {
    remoteOperationUnlisten();
    remoteOperationUnlisten = null;
  }
}

// ============================================================================
// Git Profiles
// ============================================================================

import type { GitProfile, ProfilesConfig } from "../types/workflow.types.ts";
import { workflowStore } from "../stores/workflow.store.ts";
import * as unifiedProfileService from "./unified-profile.service.ts";

/**
 * Current identity for a repository
 */
export interface CurrentIdentityInfo {
  name: string | null;
  email: string | null;
  signingKey: string | null;
}

/**
 * Get all saved profiles
 */
export async function getProfiles(): Promise<CommandResult<GitProfile[]>> {
  return invokeCommand<GitProfile[]>("get_profiles", {});
}

/**
 * Get profiles config including repository assignments
 */
export async function getProfilesConfig(): Promise<
  CommandResult<ProfilesConfig>
> {
  return invokeCommand<ProfilesConfig>("get_profiles_config", {});
}

/**
 * Save a profile (create or update)
 */
export async function saveProfile(
  profile: GitProfile,
): Promise<CommandResult<GitProfile>> {
  const result = await invokeCommand<GitProfile>("save_profile", { profile });
  if (result.success && result.data) {
    // Update store
    const store = workflowStore.getState();
    const existing = store.profiles.find((p) => p.id === profile.id);
    if (existing) {
      store.updateProfile(result.data);
    } else {
      store.addProfile(result.data);
    }
  }
  return result;
}

/**
 * Delete a profile
 */
export async function deleteProfile(
  profileId: string,
): Promise<CommandResult<void>> {
  const result = await invokeCommand<void>("delete_profile", { profileId });
  if (result.success) {
    workflowStore.getState().removeProfile(profileId);
  }
  return result;
}

/**
 * Apply a profile to a repository (sets git config)
 */
export async function applyProfile(
  repoPath: string,
  profileId: string,
): Promise<CommandResult<void>> {
  const result = await invokeCommand<void>("apply_profile", {
    path: repoPath,
    profileId,
  });
  if (result.success) {
    const profile = workflowStore
      .getState()
      .profiles.find((p) => p.id === profileId);
    if (profile) {
      workflowStore.getState().setActiveProfile(profile);
    }
    showToast("Profile applied successfully", "success");
  }
  return result;
}

/**
 * Detect which profile should be used for a repository based on URL patterns
 */
export async function detectProfileForRepository(
  repoPath: string,
): Promise<CommandResult<GitProfile | null>> {
  return invokeCommand<GitProfile | null>("detect_profile_for_repository", {
    path: repoPath,
  });
}

/**
 * Get the assigned profile for a repository
 */
export async function getAssignedProfile(
  repoPath: string,
): Promise<CommandResult<GitProfile | null>> {
  return invokeCommand<GitProfile | null>("get_assigned_profile", {
    path: repoPath,
  });
}

/**
 * Manually assign a profile to a repository (without applying git config)
 */
export async function assignProfileToRepository(
  repoPath: string,
  profileId: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("assign_profile_to_repository", {
    path: repoPath,
    profileId,
  });
}

/**
 * Remove profile assignment from a repository
 */
export async function unassignProfileFromRepository(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unassign_profile_from_repository", {
    path: repoPath,
  });
}

/**
 * Get the current git identity for a repository
 */
export async function getCurrentIdentity(
  repoPath: string,
): Promise<CommandResult<CurrentIdentityInfo>> {
  return invokeCommand<CurrentIdentityInfo>("get_current_identity", {
    path: repoPath,
  });
}

/**
 * Load profiles from backend and update store
 */
export async function loadProfiles(): Promise<void> {
  const store = workflowStore.getState();
  store.setLoadingProfiles(true);

  try {
    const result = await getProfiles();
    if (result.success && result.data) {
      store.setProfiles(result.data);
    } else {
      store.setProfileError(result.error?.message ?? "Failed to load profiles");
    }
  } finally {
    store.setLoadingProfiles(false);
  }
}

/**
 * Load and detect profile for a repository
 */
export async function loadProfileForRepository(
  repoPath: string,
): Promise<void> {
  const store = workflowStore.getState();
  store.setCurrentRepositoryPath(repoPath);

  // Load legacy profile for workflow store
  const result = await getAssignedProfile(repoPath);
  if (result.success) {
    store.setActiveProfile(result.data ?? null);
  }

  // Also load unified profile for integration accounts
  await unifiedProfileService.loadUnifiedProfileForRepository(repoPath);
}

/**
 * Repository hosting provider types
 */
export type RepositoryProvider =
  | "github"
  | "ado"
  | "gitlab"
  | "bitbucket"
  | null;

/**
 * Integration suggestion result
 */
export interface IntegrationSuggestion {
  provider: RepositoryProvider;
  providerName: string;
  isConfigured: boolean;
  features: string[];
}

/**
 * Detect repository hosting provider and check if integration is configured
 */
export async function detectRepositoryIntegration(
  repoPath: string,
): Promise<IntegrationSuggestion | null> {
  // Import the store to check for configured accounts
  const { unifiedProfileStore } =
    await import("../stores/unified-profile.store.ts");
  const accounts = unifiedProfileStore.getState().accounts;

  // Helper to check if an account of a given type exists
  const hasAccountOfType = (
    type: "github" | "gitlab" | "azure-devops" | "bitbucket",
  ): boolean => {
    return accounts.some((account) => account.integrationType === type);
  };

  // Try to detect each provider in parallel
  const [githubResult, adoResult, gitlabResult, bitbucketResult] =
    await Promise.all([
      detectGitHubRepo(repoPath),
      detectAdoRepo(repoPath),
      detectGitLabRepo(repoPath),
      detectBitbucketRepo(repoPath),
    ]);

  // Check GitHub
  if (githubResult.success && githubResult.data) {
    return {
      provider: "github",
      providerName: "GitHub",
      isConfigured: hasAccountOfType("github"),
      features: [
        "Pull request overlays",
        "Create PRs from branches",
        "Link issues",
      ],
    };
  }

  // Check Azure DevOps
  if (adoResult.success && adoResult.data) {
    return {
      provider: "ado",
      providerName: "Azure DevOps",
      isConfigured: hasAccountOfType("azure-devops"),
      features: ["Pull request overlays", "Work item linking"],
    };
  }

  // Check GitLab
  if (gitlabResult.success && gitlabResult.data) {
    return {
      provider: "gitlab",
      providerName: "GitLab",
      isConfigured: hasAccountOfType("gitlab"),
      features: ["Merge request overlays", "Issue linking"],
    };
  }

  // Check Bitbucket
  if (bitbucketResult.success && bitbucketResult.data) {
    return {
      provider: "bitbucket",
      providerName: "Bitbucket",
      isConfigured: hasAccountOfType("bitbucket"),
      features: ["Pull request overlays"],
    };
  }

  return null;
}

/**
 * Git Flow operations
 */
export interface GitFlowConfig {
  initialized: boolean;
  masterBranch: string;
  developBranch: string;
  featurePrefix: string;
  releasePrefix: string;
  hotfixPrefix: string;
  supportPrefix: string;
  versionTagPrefix: string;
}

export async function getGitFlowConfig(
  repoPath: string,
): Promise<CommandResult<GitFlowConfig>> {
  return invokeCommand<GitFlowConfig>("get_gitflow_config", { path: repoPath });
}

export async function initGitFlow(
  repoPath: string,
  config?: Partial<GitFlowConfig>,
): Promise<CommandResult<GitFlowConfig>> {
  return invokeCommand<GitFlowConfig>("init_gitflow", {
    path: repoPath,
    masterBranch: config?.masterBranch,
    developBranch: config?.developBranch,
    featurePrefix: config?.featurePrefix,
    releasePrefix: config?.releasePrefix,
    hotfixPrefix: config?.hotfixPrefix,
    supportPrefix: config?.supportPrefix,
    versionTagPrefix: config?.versionTagPrefix,
  });
}

export async function gitFlowStartFeature(
  repoPath: string,
  name: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_feature", { path: repoPath, name });
}

/** Outcome of a git-flow finish; branchKeptReason is set when a branch rule blocked the delete. */
export interface GitFlowFinishResult {
  branchDeleted: boolean;
  branchKeptReason: string | null;
}

export async function gitFlowFinishFeature(
  repoPath: string,
  name: string,
  deleteBranch?: boolean,
  squash?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_feature", {
    path: repoPath,
    name,
    deleteBranch,
    squash,
  });
}

/**
 * Record that a squash finish's commit has landed on develop.
 *
 * A squash finish whose merge conflicted is committed by the conflict-resolution
 * flow, not by `gitflow_finish_feature`, so the backend has no record of it. The
 * marker written here makes a later retry (after e.g. a blocked branch delete)
 * do the pending cleanup only instead of re-merging into a second squash commit.
 */
export async function gitFlowRecordSquashFinish(
  repoPath: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("gitflow_record_squash_finish", { path: repoPath, name });
}

export async function gitFlowStartRelease(
  repoPath: string,
  version: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_release", { path: repoPath, version });
}

export async function gitFlowFinishRelease(
  repoPath: string,
  version: string,
  tagMessage?: string,
  deleteBranch?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_release", {
    path: repoPath,
    version,
    tagMessage,
    deleteBranch,
  });
}

export async function gitFlowStartHotfix(
  repoPath: string,
  version: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_hotfix", { path: repoPath, version });
}

export async function gitFlowFinishHotfix(
  repoPath: string,
  version: string,
  tagMessage?: string,
  deleteBranch?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_hotfix", {
    path: repoPath,
    version,
    tagMessage,
    deleteBranch,
  });
}

/**
 * Patch operations
 */
export async function createPatch(
  repoPath: string,
  commitOids: string[],
  outputPath: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("create_patch", {
    path: repoPath,
    commitOids,
    outputPath,
  });
}

export async function applyPatch(
  repoPath: string,
  patchPath: string,
  checkOnly?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_patch", {
    path: repoPath,
    patchPath,
    checkOnly,
  });
}

export async function applyPatchToIndex(
  repoPath: string,
  patchPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_patch_to_index", {
    path: repoPath,
    patchPath,
  });
}

/**
 * Archive operations
 */
export async function createArchive(
  repoPath: string,
  outputPath: string,
  treeRef?: string,
  format?: string,
  prefix?: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("create_archive", {
    path: repoPath,
    outputPath,
    treeRef,
    format,
    prefix,
  });
}

export async function getArchiveFiles(
  repoPath: string,
  treeRef?: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("get_archive_files", {
    path: repoPath,
    treeRef,
  });
}

/**
 * Git Notes operations
 */
export interface GitNote {
  commitOid: string;
  message: string;
  notesRef: string;
}

export async function getNote(
  repoPath: string,
  commitOid: string,
  notesRef?: string,
): Promise<CommandResult<GitNote | null>> {
  return invokeCommand<GitNote | null>("get_note", {
    path: repoPath,
    commitOid,
    notesRef,
  });
}

export async function getNotes(
  repoPath: string,
  notesRef?: string,
): Promise<CommandResult<GitNote[]>> {
  return invokeCommand<GitNote[]>("get_notes", {
    path: repoPath,
    notesRef,
  });
}

export async function setNote(
  repoPath: string,
  commitOid: string,
  message: string,
  notesRef?: string,
  force?: boolean,
): Promise<CommandResult<GitNote>> {
  return invokeCommand<GitNote>("set_note", {
    path: repoPath,
    commitOid,
    message,
    notesRef,
    force,
  });
}

export async function removeNote(
  repoPath: string,
  commitOid: string,
  notesRef?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_note", {
    path: repoPath,
    commitOid,
    notesRef,
  });
}

export async function getNotesRefs(
  repoPath: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("get_notes_refs", {
    path: repoPath,
  });
}

/**
 * Gitignore management
 */
export interface GitignoreEntry {
  pattern: string;
  lineNumber: number;
  isComment: boolean;
  isNegation: boolean;
  isEmpty: boolean;
}

export interface GitignoreTemplate {
  name: string;
  patterns: string[];
}

export async function getGitignore(
  repoPath: string,
): Promise<CommandResult<GitignoreEntry[]>> {
  return invokeCommand<GitignoreEntry[]>("get_gitignore", { path: repoPath });
}

export async function addToGitignore(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("add_to_gitignore", { path: repoPath, patterns });
}

/**
 * Remove the rule on `lineNumber` (1-based, as reported by `getGitignore`).
 *
 * The line is required, not the pattern alone: a .gitignore can repeat a line,
 * and the backend used to drop every line with matching text — removing one
 * displayed row took its twins with it.
 */
export async function removeFromGitignore(
  repoPath: string,
  pattern: string,
  lineNumber: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_from_gitignore", {
    path: repoPath,
    pattern,
    lineNumber,
  });
}

export async function isIgnored(
  repoPath: string,
  filePath: string,
): Promise<CommandResult<boolean>> {
  return invokeCommand<boolean>("is_ignored", { path: repoPath, filePath });
}

export async function getGitignoreTemplates(): Promise<
  CommandResult<GitignoreTemplate[]>
> {
  return invokeCommand<GitignoreTemplate[]>("get_gitignore_templates", {});
}

export interface IgnoreCheckResult {
  path: string;
  isIgnored: boolean;
}

export interface IgnoreCheckVerboseResult {
  path: string;
  isIgnored: boolean;
  /** Which .gitignore file contains the matching rule */
  sourceFile: string | null;
  /** Line number in the .gitignore file */
  sourceLine: number | null;
  /** The matching pattern */
  pattern: string | null;
  /** Whether the matching pattern is negated (! prefix) */
  isNegated: boolean;
}

export async function checkIgnore(
  repoPath: string,
  filePaths: string[],
): Promise<CommandResult<IgnoreCheckResult[]>> {
  return invokeCommand<IgnoreCheckResult[]>("check_ignore", {
    path: repoPath,
    filePaths,
  });
}

export async function checkIgnoreVerbose(
  repoPath: string,
  filePaths: string[],
): Promise<CommandResult<IgnoreCheckVerboseResult[]>> {
  return invokeCommand<IgnoreCheckVerboseResult[]>("check_ignore_verbose", {
    path: repoPath,
    filePaths,
  });
}

/**
 * Gitattributes management
 */
/**
 * Mirrors the externally-tagged Rust `AttributeValue`. Serde emits the unit
 * variants as the bare strings `"set"` / `"unset"` / `"unspecified"` and the
 * valued variant as `{ value }` — never `{ type: "set" }`. The previous
 * object-only union here never matched the wire, so anything rendered from it
 * showed `undefined`; `attribute_value_unit_variants_serialize_as_bare_strings`
 * in `src-tauri/src/commands/gitattributes.rs` pins the other side.
 */
export type AttributeValue =
  | "set"
  | "unset"
  | "unspecified"
  | { value: string };

export interface AttributeEntry {
  name: string;
  value: AttributeValue;
}

export interface GitAttribute {
  pattern: string;
  attributes: AttributeEntry[];
  lineNumber: number;
  rawLine: string;
}

export interface CommonAttribute {
  name: string;
  description: string;
  example: string;
}

export async function getGitattributes(
  repoPath: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("get_gitattributes", { path: repoPath });
}

export async function addGitattribute(
  repoPath: string,
  pattern: string,
  attributes: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("add_gitattribute", {
    path: repoPath,
    pattern,
    attributes,
  });
}

export async function removeGitattribute(
  repoPath: string,
  lineNumber: number,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("remove_gitattribute", {
    path: repoPath,
    lineNumber,
  });
}

export async function updateGitattribute(
  repoPath: string,
  lineNumber: number,
  pattern: string,
  attributes: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("update_gitattribute", {
    path: repoPath,
    lineNumber,
    pattern,
    attributes,
  });
}

export async function getCommonAttributes(): Promise<
  CommandResult<CommonAttribute[]>
> {
  return invokeCommand<CommonAttribute[]>("get_common_attributes", {});
}

/**
 * Git Hooks management
 */
export interface GitHook {
  name: string;
  path: string;
  exists: boolean;
  enabled: boolean;
  content: string | null;
  description: string;
}

export async function getHooks(
  repoPath: string,
): Promise<CommandResult<GitHook[]>> {
  return invokeCommand<GitHook[]>("get_hooks", { path: repoPath });
}

export async function getHook(
  repoPath: string,
  name: string,
): Promise<CommandResult<GitHook>> {
  return invokeCommand<GitHook>("get_hook", { path: repoPath, name });
}

export async function saveHook(
  repoPath: string,
  name: string,
  content: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("save_hook", { path: repoPath, name, content });
}

export async function deleteHook(
  repoPath: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_hook", { path: repoPath, name });
}

export async function toggleHook(
  repoPath: string,
  name: string,
  enabled: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("toggle_hook", { path: repoPath, name, enabled });
}

/**
 * Terminal integration
 */
export async function openTerminal(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_terminal", { path: repoPath });
}

export async function openFileManager(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_file_manager", { path: repoPath });
}

export async function openInEditor(
  filePath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_in_editor", { filePath });
}

/**
 * File operations
 */

/** Result of file open/reveal operations */
export interface OpenResult {
  success: boolean;
  message?: string;
}

/** Editor configuration from git config */
export interface EditorConfig {
  editor?: string;
  visual?: string;
}

/**
 * Reveal a file or folder in the system file manager
 * This will select/highlight the file in the file manager
 * @param path Absolute path to the file or folder
 */
export async function revealInFileManager(
  path: string,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("reveal_in_file_manager", { path });
}

/**
 * Open a file with the system's default application
 * @param path Absolute path to the file
 */
export async function openInDefaultApp(
  path: string,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("open_in_default_app", { path });
}

/**
 * Open a file in the configured editor
 * Uses git's core.editor config, falling back to VISUAL/EDITOR env vars
 * @param repoPath Repository path (for local config lookup)
 * @param filePath File path (absolute or relative to repo)
 * @param line Optional line number to open at
 */
export async function openInConfiguredEditor(
  repoPath: string,
  filePath: string,
  line?: number,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("open_in_configured_editor", {
    path: repoPath,
    filePath,
    line,
  });
}

/**
 * Get the configured editor settings
 * @param repoPath Repository path
 * @param global If true, only return global config; otherwise prefer local
 */
export async function getEditorConfig(
  repoPath: string,
  global: boolean = false,
): Promise<CommandResult<EditorConfig>> {
  return invokeCommand<EditorConfig>("get_editor_config", {
    path: repoPath,
    global,
  });
}

/**
 * Set the configured editor
 * @param repoPath Repository path
 * @param editor Editor command (e.g., "code --wait", "vim")
 * @param global If true, set in global config; otherwise set in local repo config
 */
export async function setEditorConfig(
  repoPath: string,
  editor: string,
  global: boolean = false,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("set_editor_config", {
    path: repoPath,
    editor,
    global,
  });
}

/**
 * Repository statistics
 */
export interface ContributorStats {
  name: string;
  email: string;
  commitCount: number;
  firstCommit: number;
  latestCommit: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface MonthActivity {
  year: number;
  month: number;
  commitCount: number;
}

export interface DayOfWeekActivity {
  day: string;
  dayIndex: number;
  commitCount: number;
}

export interface HourActivity {
  hour: number;
  commitCount: number;
}

export interface RepoStats {
  totalCommits: number;
  totalBranches: number;
  totalTags: number;
  totalContributors: number;
  firstCommitDate: number | null;
  latestCommitDate: number | null;
  contributors: ContributorStats[];
  activityByMonth: MonthActivity[];
  activityByDayOfWeek: DayOfWeekActivity[];
  activityByHour: HourActivity[];
  filesCount: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
}

export async function getRepoStats(
  repoPath: string,
  maxCommits?: number,
): Promise<CommandResult<RepoStats>> {
  return invokeCommand<RepoStats>("get_repo_stats", {
    path: repoPath,
    maxCommits,
  });
}

export async function getContributorStats(
  repoPath: string,
  maxCommits?: number,
): Promise<CommandResult<ContributorStats[]>> {
  return invokeCommand<ContributorStats[]>("get_contributor_stats", {
    path: repoPath,
    maxCommits,
  });
}

/**
 * Enhanced repository statistics for dashboard
 */
export interface EnhancedMonthActivity {
  year: number;
  month: number;
  commits: number;
  authors: number;
}

export interface WeekdayActivity {
  day: string;
  commits: number;
}

export interface EnhancedHourActivity {
  hour: number;
  commits: number;
}

export interface EnhancedContributorStats {
  name: string;
  email: string;
  commits: number;
  linesAdded: number;
  linesDeleted: number;
  firstCommit: number;
  lastCommit: number;
}

export interface FileTypeStats {
  extension: string;
  fileCount: number;
  totalLines: number;
}

export interface RepoStatistics {
  // Basics
  totalCommits: number;
  totalBranches: number;
  totalTags: number;
  totalContributors: number;
  totalFiles: number;
  repoSizeBytes: number;

  // First/Last commits
  firstCommitDate: number | null;
  lastCommitDate: number | null;
  repoAgeDays: number;

  // Activity breakdown (if includeActivity)
  activityByMonth: EnhancedMonthActivity[] | null;
  activityByWeekday: WeekdayActivity[] | null;
  activityByHour: EnhancedHourActivity[] | null;

  // Contributor breakdown (if includeContributors)
  topContributors: EnhancedContributorStats[] | null;

  // File type breakdown (if includeFileTypes)
  fileTypes: FileTypeStats[] | null;

  // Code stats
  totalLinesAdded: number;
  totalLinesDeleted: number;
}

export interface GetRepoStatisticsOptions {
  includeActivity?: boolean;
  includeContributors?: boolean;
  includeFileTypes?: boolean;
  since?: string; // ISO 8601 date
  until?: string; // ISO 8601 date
}

export async function getRepoStatistics(
  repoPath: string,
  options?: GetRepoStatisticsOptions,
): Promise<CommandResult<RepoStatistics>> {
  return invokeCommand<RepoStatistics>("get_repo_statistics", {
    path: repoPath,
    includeActivity: options?.includeActivity ?? false,
    includeContributors: options?.includeContributors ?? false,
    includeFileTypes: options?.includeFileTypes ?? false,
    since: options?.since,
    until: options?.until,
  });
}

/**
 * Search / Grep operations
 */
export interface SearchResult {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileResult {
  filePath: string;
  matches: SearchResult[];
  matchCount: number;
}

export interface DiffSearchResult {
  commitId: string;
  author: string;
  date: number;
  message: string;
  filePath: string;
  lineContent: string;
}

export async function searchInFiles(
  repoPath: string,
  query: string,
  caseSensitive?: boolean,
  regex?: boolean,
  filePattern?: string,
  maxResults?: number,
): Promise<CommandResult<SearchFileResult[]>> {
  return invokeCommand<SearchFileResult[]>("search_in_files", {
    path: repoPath,
    query,
    caseSensitive,
    regex,
    filePattern,
    maxResults,
  });
}

export async function searchInDiff(
  repoPath: string,
  query: string,
  staged?: boolean,
): Promise<CommandResult<SearchResult[]>> {
  return invokeCommand<SearchResult[]>("search_in_diff", {
    path: repoPath,
    query,
    staged,
  });
}

export async function searchInCommits(
  repoPath: string,
  query: string,
  maxCommits?: number,
): Promise<CommandResult<DiffSearchResult[]>> {
  return invokeCommand<DiffSearchResult[]>("search_in_commits", {
    path: repoPath,
    query,
    maxCommits,
  });
}

export async function searchInCommitMessages(
  repoPath: string,
  query: string,
  maxCommits?: number,
): Promise<CommandResult<DiffSearchResult[]>> {
  return invokeCommand<DiffSearchResult[]>("search_in_commit_messages", {
    path: repoPath,
    query,
    maxCommits,
  });
}

/**
 * A match location within a commit's changes
 */
export interface SearchMatch {
  filePath: string;
  lineNumber: number | null;
  lineContent: string | null;
}

/**
 * A commit returned from content/file search
 */
export interface SearchCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorDate: number;
  matches: SearchMatch[];
}

/**
 * Search for commits that changed specific content (git log -G or -S)
 *
 * This is useful for finding when a specific string or pattern was added,
 * removed, or modified.
 *
 * @param repoPath - Repository path
 * @param searchText - Text to search for in changes
 * @param regex - Treat searchText as a regex pattern (uses git log -G)
 * @param ignoreCase - Case insensitive search
 * @param maxCount - Limit number of results
 */
export async function searchCommitsByContent(
  repoPath: string,
  searchText: string,
  regex?: boolean,
  ignoreCase?: boolean,
  maxCount?: number,
): Promise<CommandResult<SearchCommit[]>> {
  return invokeCommand<SearchCommit[]>("search_commits_by_content", {
    path: repoPath,
    searchText,
    regex,
    ignoreCase,
    maxCount,
  });
}

/**
 * Search for commits that touched files matching a pattern
 *
 * This is useful for finding all commits that modified files matching
 * a glob pattern (e.g., "*.rs", "src/*.ts").
 *
 * @param repoPath - Repository path
 * @param filePattern - Glob pattern to match files (e.g., "*.rs")
 * @param maxCount - Limit number of results
 */
export async function searchCommitsByFile(
  repoPath: string,
  filePattern: string,
  maxCount?: number,
): Promise<CommandResult<SearchCommit[]>> {
  return invokeCommand<SearchCommit[]>("search_commits_by_file", {
    path: repoPath,
    filePattern,
    maxCount,
  });
}

/**
 * Sparse checkout
 */
export interface SparseCheckoutConfig {
  enabled: boolean;
  coneMode: boolean;
  patterns: string[];
}

export async function getSparseCheckoutConfig(
  repoPath: string,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("get_sparse_checkout_config", {
    path: repoPath,
  });
}

export async function enableSparseCheckout(
  repoPath: string,
  coneMode: boolean,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("enable_sparse_checkout", {
    path: repoPath,
    coneMode,
  });
}

export async function disableSparseCheckout(
  repoPath: string,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("disable_sparse_checkout", {
    path: repoPath,
  });
}

export async function setSparseCheckoutPatterns(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("set_sparse_checkout_patterns", {
    path: repoPath,
    patterns,
  });
}

export async function addSparseCheckoutPatterns(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("add_sparse_checkout_patterns", {
    path: repoPath,
    patterns,
  });
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

/**
 * Avatar operations
 */

/**
 * Get avatar info for a single email address
 */
export async function getAvatarUrl(
  args: GetAvatarUrlCommand,
): Promise<CommandResult<AvatarInfo>> {
  return invokeCommand<AvatarInfo>("get_avatar_url", args);
}

/**
 * Get avatar info for multiple email addresses (batch)
 */
export async function getAvatarUrls(
  args: GetAvatarUrlsCommand,
): Promise<CommandResult<AvatarInfo[]>> {
  return invokeCommand<AvatarInfo[]>("get_avatar_urls", args);
}

/**
 * Bookmark operations
 */

/**
 * Repository bookmark
 */
export interface RepoBookmark {
  path: string;
  name: string;
  group: string | null;
  pinned: boolean;
  lastOpened: number;
  color: string | null;
}

/**
 * Get all bookmarks
 */
export async function getBookmarks(): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("get_bookmarks", {});
}

/**
 * Add a new bookmark
 */
export async function addBookmark(
  path: string,
  name: string,
  group?: string | null,
  pinned?: boolean,
  color?: string | null,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("add_bookmark", {
    path,
    name,
    group: group ?? null,
    pinned: pinned ?? false,
    color: color ?? null,
  });
}

/**
 * Remove a bookmark
 */
export async function removeBookmark(
  path: string,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("remove_bookmark", { path });
}

/**
 * Update an existing bookmark
 */
export async function updateBookmark(
  bookmark: RepoBookmark,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("update_bookmark", { bookmark });
}

/**
 * Get recently opened repositories
 */
export async function getRecentRepos(): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("get_recent_repos", {});
}

/**
 * Record that a repository was opened
 */
export async function recordRepoOpened(
  path: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("record_repo_opened", { path, name });
}

/**
 * Branch Protection Rules
 */

/**
 * A local branch protection rule
 */
export interface BranchRule {
  /** Branch name or glob pattern (e.g., "main", "release/*") */
  pattern: string;
  /** Prevent the branch from being deleted */
  preventDeletion: boolean;
  /** Prevent force-pushing to the branch */
  preventForcePush: boolean;
  /** Require changes to go through a pull request */
  requirePullRequest: boolean;
  /** Prevent direct commits/pushes to the branch */
  preventDirectPush: boolean;
}

/**
 * Get all branch protection rules for a repository
 *
 * @param path - Repository path
 * @returns List of branch protection rules
 */
export async function getBranchRules(
  path: string,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("get_branch_rules", { path });
}

/**
 * Set (add or update) a branch protection rule
 *
 * @param path - Repository path
 * @param rule - The branch rule to set
 * @returns Updated list of all branch rules
 */
export async function setBranchRule(
  path: string,
  rule: BranchRule,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("set_branch_rule", { path, rule });
}

/**
 * Delete a branch protection rule by pattern
 *
 * @param path - Repository path
 * @param pattern - The branch pattern to remove the rule for
 * @returns Updated list of all branch rules
 */
export async function deleteBranchRule(
  path: string,
  pattern: string,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("delete_branch_rule", { path, pattern });
}

/**
 * Custom Actions
 */

/**
 * A user-defined custom action
 */
export interface CustomAction {
  id: string;
  name: string;
  command: string;
  arguments: string | null;
  workingDirectory: string | null;
  shortcut: string | null;
  showInToolbar: boolean;
  openInTerminal: boolean;
  confirmBeforeRun: boolean;
}

/**
 * Result of executing a custom action
 */
export interface ActionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/**
 * Get all custom actions for a repository
 */
export async function getCustomActions(
  path: string,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("get_custom_actions", { path });
}

/**
 * Save a custom action
 */
export async function saveCustomAction(
  path: string,
  action: CustomAction,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("save_custom_action", { path, action });
}

/**
 * Delete a custom action
 */
export async function deleteCustomAction(
  path: string,
  actionId: string,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("delete_custom_action", {
    path,
    actionId,
  });
}

/**
 * Run a custom action
 */
export async function runCustomAction(
  path: string,
  actionId: string,
): Promise<CommandResult<ActionResult>> {
  return invokeCommand<ActionResult>("run_custom_action", { path, actionId });
}

/**
 * Cherry-pick a range of commits
 */
export async function cherryPickRange(
  path: string,
  commitOids: string[],
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("cherry_pick_range", { path, commitOids });
}

/**
 * Cherry-pick commits from the tip of a branch by name
 *
 * Resolves the given branch name to its tip commit and cherry-picks
 * the most recent `count` commits (default 1) onto the current branch.
 */
export async function cherryPickFromBranch(
  args: CherryPickFromBranchCommand,
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("cherry_pick_from_branch", args);
}

/**
 * Advanced Commit Search
 */

/**
 * Filter criteria for searching commits
 */
export interface CommitFilter {
  author?: string;
  committer?: string;
  message?: string;
  afterDate?: string;
  beforeDate?: string;
  path?: string;
  branch?: string;
  minParents?: number;
  maxParents?: number;
  noMerges?: boolean;
  firstParent?: boolean;
}

/**
 * A commit returned from filtered search results
 */
export interface FilteredCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerDate: number;
  parentCount: number;
  isMerge: boolean;
}

/**
 * Filter commits based on criteria
 */
export async function filterCommits(
  path: string,
  filter: CommitFilter,
  maxCount?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("filter_commits", {
    path,
    filter,
    // Rust parameter is `max_results`; Tauri maps it to the `maxResults` key.
    maxResults: maxCount ?? 500,
  });
}

/**
 * Get commits that differ between two branches
 */
export async function getBranchDiffCommits(
  path: string,
  baseBranch: string,
  compareBranch: string,
  maxCount?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("get_branch_diff_commits", {
    path,
    baseBranch,
    compareBranch,
    // Rust parameter is `max_results`; Tauri maps it to the `maxResults` key.
    maxResults: maxCount ?? 500,
  });
}

/**
 * Get commit history for a specific file
 */
export async function getFileLog(
  path: string,
  filePath: string,
  follow?: boolean,
  maxResults?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("get_file_log", {
    path,
    filePath,
    follow: follow ?? true,
    maxResults: maxResults ?? 100,
  });
}

// ============================================================================
// Git Bundle Operations
// ============================================================================

/**
 * Reference in a bundle
 */
export interface BundleRef {
  name: string;
  oid: string;
}

/**
 * Result of creating a bundle
 */
export interface BundleCreateResult {
  bundlePath: string;
  refsCount: number;
  objectsCount: number;
}

/**
 * Result of verifying a bundle
 */
export interface BundleVerifyResult {
  isValid: boolean;
  refs: BundleRef[];
  requires: string[];
  message: string | null;
}

/**
 * Create a bundle file from repository refs
 * @param repoPath Repository path
 * @param bundlePath Output bundle file path
 * @param refs Refs to include (branches, tags, HEAD, ranges)
 * @param all Include all refs (--all flag)
 */
export async function bundleCreate(
  repoPath: string,
  bundlePath: string,
  refs: string[],
  all: boolean,
): Promise<CommandResult<BundleCreateResult>> {
  return invokeCommand<BundleCreateResult>("bundle_create", {
    path: repoPath,
    bundlePath,
    refs,
    all,
  });
}

/**
 * Verify a bundle file against a repository
 * @param repoPath Repository path (for verification against)
 * @param bundlePath Bundle file to verify
 */
export async function bundleVerify(
  repoPath: string,
  bundlePath: string,
): Promise<CommandResult<BundleVerifyResult>> {
  return invokeCommand<BundleVerifyResult>("bundle_verify", {
    path: repoPath,
    bundlePath,
  });
}

/**
 * List the refs (heads) contained in a bundle file
 * @param bundlePath Bundle file path
 */
export async function bundleListHeads(
  bundlePath: string,
): Promise<CommandResult<BundleRef[]>> {
  return invokeCommand<BundleRef[]>("bundle_list_heads", {
    bundlePath,
  });
}

/**
 * Extract (unbundle) a bundle file into a repository
 * @param repoPath Repository path
 * @param bundlePath Bundle file to extract
 * @returns The refs that were fetched from the bundle
 */
export async function bundleUnbundle(
  repoPath: string,
  bundlePath: string,
): Promise<CommandResult<BundleRef[]>> {
  return invokeCommand<BundleRef[]>("bundle_unbundle", {
    path: repoPath,
    bundlePath,
  });
}

// ============================================================================
// Branch Comparison
// ============================================================================

/**
 * Options for branch comparison
 */
export interface BranchComparisonOptions {
  /** Include list of commits ahead/behind */
  includeCommits?: boolean;
  /** Include list of changed files */
  includeFiles?: boolean;
}

/**
 * A commit in the comparison result
 */
export interface CompareCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorDate: number;
}

/**
 * A changed file in the comparison result
 */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  oldPath: string | null;
}

/**
 * Result of comparing two branches/refs
 */
export interface BranchComparison {
  baseRef: string;
  compareRef: string;
  ahead: number;
  behind: number;
  mergeBase: string;
  commitsAhead: CompareCommit[] | null;
  commitsBehind: CompareCommit[] | null;
  filesChanged: ChangedFile[] | null;
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Compare two branches or refs
 * @param path Repository path
 * @param base Base ref (branch/tag/commit)
 * @param compare Comparison ref
 * @param options Comparison options
 * @returns Comparison result with ahead/behind counts, merge base, and optionally commits and files
 */
export async function compareBranches(
  path: string,
  base: string,
  compare: string,
  options?: BranchComparisonOptions,
): Promise<CommandResult<BranchComparison>> {
  return invokeCommand<BranchComparison>("compare_branches", {
    path,
    base,
    compare,
    includeCommits: options?.includeCommits ?? false,
    includeFiles: options?.includeFiles ?? false,
  });
}

// ============================================================================
// External Diff Tool
// ============================================================================

/**
 * Diff tool configuration
 */
export interface DiffToolConfig {
  /** Name of the configured diff tool */
  tool: string | null;
  /** Custom command for the diff tool */
  cmd: string | null;
  /** Whether to prompt before launching the diff tool */
  prompt: boolean;
}

/**
 * Information about an available diff tool
 */
export interface AvailableDiffTool {
  /** Tool identifier name */
  name: string;
  /** Command used to launch the tool */
  command: string;
  /** Whether the tool is available on the system */
  available: boolean;
}

/**
 * Result of launching a diff tool
 */
export interface DiffToolResult {
  /** Whether the diff tool exited successfully */
  success: boolean;
  /** Output or error message from the diff tool */
  message: string;
}

/**
 * Get the current diff tool configuration
 * @param path Repository path
 * @param global Whether to read from global config instead of local
 * @returns Diff tool configuration
 */
export async function getDiffToolConfig(
  path: string,
  global?: boolean,
): Promise<CommandResult<DiffToolConfig>> {
  return invokeCommand<DiffToolConfig>("get_diff_tool", {
    path,
    global,
  });
}

/**
 * Set the diff tool configuration
 * @param path Repository path
 * @param tool Tool name (e.g., "vscode", "meld", "kdiff3", "beyond")
 * @param cmd Custom command (optional, if not using standard tool)
 * @param global Whether to set in global config
 */
export async function setDiffTool(
  path: string,
  tool: string,
  cmd?: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_diff_tool", {
    path,
    tool,
    cmd,
    global,
  });
}

/**
 * List available diff tools with their availability status
 * @param path Repository path
 * @returns List of available diff tools
 */
export async function listDiffTools(
  path: string,
): Promise<CommandResult<AvailableDiffTool[]>> {
  return invokeCommand<AvailableDiffTool[]>("list_diff_tools", {
    path,
  });
}

/**
 * Launch the external diff tool for a specific file
 * @param path Repository path
 * @param filePath File to diff (relative to repo root)
 * @param staged If true, compare staged changes (index vs HEAD)
 * @param commit If provided, compare against this commit
 * @returns Result of launching the diff tool
 */
export async function launchDiffTool(
  path: string,
  filePath: string,
  staged?: boolean,
  commit?: string,
): Promise<CommandResult<DiffToolResult>> {
  return invokeCommand<DiffToolResult>("launch_diff_tool", {
    path,
    filePath,
    staged,
    commit,
  });
}

// ============================================================================
// External Merge Tool
// ============================================================================

/**
 * Merge tool configuration
 */
export interface MergeToolConfig {
  /** Name of the configured merge tool */
  toolName: string | null;
  /** Custom command for the merge tool */
  toolCmd: string | null;
}

/**
 * Information about a known merge tool
 */
export interface MergeToolInfo {
  /** Tool identifier name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Command used to launch the tool */
  command: string;
  /** Whether the tool is available on the system */
  available: boolean;
}

/**
 * Result of launching a merge tool
 */
export interface MergeToolResult {
  /** Whether the merge tool exited successfully */
  success: boolean;
  /** Output or error message from the merge tool */
  message: string;
}

/**
 * Get the current merge tool configuration
 * @param path Repository path
 * @returns Merge tool configuration
 */
export async function getMergeToolConfig(
  path: string,
): Promise<CommandResult<MergeToolConfig>> {
  return invokeCommand<MergeToolConfig>("get_merge_tool_config", {
    path,
  });
}

/**
 * Set the merge tool configuration
 * @param path Repository path
 * @param toolName Tool name (e.g., "kdiff3", "meld", "bc", "vscode")
 * @param toolCmd Custom command (optional, if not using standard tool)
 */
export async function setMergeToolConfig(
  path: string,
  toolName: string,
  toolCmd?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_merge_tool_config", {
    path,
    toolName,
    toolCmd,
  });
}

/**
 * Launch the configured merge tool for a specific file
 * @param path Repository path
 * @param filePath File to merge (relative to repo root)
 * @returns Result of launching the merge tool
 */
export async function launchMergeTool(
  path: string,
  filePath: string,
): Promise<CommandResult<MergeToolResult>> {
  return invokeCommand<MergeToolResult>("launch_merge_tool", {
    path,
    filePath,
  });
}

/**
 * Get a list of commonly available merge tools
 * @returns List of known merge tools
 */
export async function getAvailableMergeTools(): Promise<CommandResult<MergeToolInfo[]>> {
  return invokeCommand<MergeToolInfo[]>("get_available_merge_tools", {});
}

/**
 * Auto-detect the first available merge tool on the system
 * @returns The first available merge tool, or null if none found
 */
export async function autoDetectMergeTool(): Promise<CommandResult<MergeToolInfo | null>> {
  return invokeCommand<MergeToolInfo | null>("auto_detect_merge_tool", {});
}

// ============================================================================
// Clipboard Operations
// ============================================================================

/**
 * Result of a clipboard copy operation
 */
export interface CopyResult {
  success: boolean;
  text: string;
}

/**
 * Format options for commit info
 */
export type CommitInfoFormat =
  | "sha"
  | "short_sha"
  | "message"
  | "full"
  | "patch";

/**
 * Format options for file paths
 */
export type FilePathFormat = "relative" | "absolute" | "filename";

/**
 * Copy text to the system clipboard
 * Uses the browser's clipboard API for better reliability
 * @param text Text to copy
 * @returns Result with the copied text
 */
export async function copyToClipboard(
  text: string,
): Promise<CommandResult<CopyResult>> {
  try {
    await navigator.clipboard.writeText(text);
    return {
      success: true,
      data: { success: true, text },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "CLIPBOARD_ERROR",
        message:
          error instanceof Error ? error.message : "Failed to copy to clipboard",
      },
    };
  }
}

/**
 * Get formatted commit info for copying
 * @param path Repository path
 * @param oid Commit OID
 * @param format Format type: "sha", "short_sha", "message", "full", "patch"
 * @returns Formatted commit info
 */
export async function getCommitInfoForCopy(
  path: string,
  oid: string,
  format: CommitInfoFormat,
): Promise<CommandResult<CopyResult>> {
  return invokeCommand<CopyResult>("get_commit_info_for_copy", {
    path,
    oid,
    format,
  });
}

/**
 * Get file path in various formats for copying
 * @param path Repository path
 * @param filePath Relative file path within the repo
 * @param format Format type: "relative", "absolute", "filename"
 * @returns Formatted file path
 */
export async function getFilePathForCopy(
  path: string,
  filePath: string,
  format: FilePathFormat,
): Promise<CommandResult<CopyResult>> {
  return invokeCommand<CopyResult>("get_file_path_for_copy", {
    path,
    filePath,
    format,
  });
}

/**
 * Copy commit SHA to clipboard
 * Convenience function that combines getCommitInfoForCopy and copyToClipboard
 * @param path Repository path
 * @param oid Commit OID
 * @param short If true, copy short SHA (7 characters)
 * @returns Result with the copied text
 */
export async function copyCommitSha(
  path: string,
  oid: string,
  short?: boolean,
): Promise<CommandResult<CopyResult>> {
  const format: CommitInfoFormat = short ? "short_sha" : "sha";
  const infoResult = await getCommitInfoForCopy(path, oid, format);

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy commit message to clipboard
 * @param path Repository path
 * @param oid Commit OID
 * @returns Result with the copied text
 */
export async function copyCommitMessage(
  path: string,
  oid: string,
): Promise<CommandResult<CopyResult>> {
  const infoResult = await getCommitInfoForCopy(path, oid, "message");

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy commit as patch to clipboard
 * @param path Repository path
 * @param oid Commit OID
 * @returns Result with the copied patch text
 */
export async function copyCommitPatch(
  path: string,
  oid: string,
): Promise<CommandResult<CopyResult>> {
  const infoResult = await getCommitInfoForCopy(path, oid, "patch");

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy file path to clipboard
 * @param repoPath Repository path
 * @param filePath Relative file path within the repo
 * @param format Format type: "relative", "absolute", "filename"
 * @returns Result with the copied text
 */
export async function copyFilePath(
  repoPath: string,
  filePath: string,
  format: FilePathFormat = "relative",
): Promise<CommandResult<CopyResult>> {
  const pathResult = await getFilePathForCopy(repoPath, filePath, format);

  if (!pathResult.success || !pathResult.data) {
    return pathResult;
  }

  return copyToClipboard(pathResult.data.text);
}

/**
 * Repository maintenance operations
 */

/**
 * Result of a prune operation for remote tracking branches
 */
export interface PruneResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** List of branches that were pruned */
  branchesPruned: string[];
}

/**
 * Get repository statistics for health monitoring
 */
export async function getRepositoryStats(
  repoPath: string,
): Promise<CommandResult<{ count: number; loose: number; sizeKb: number }>> {
  return invokeCommand<{ count: number; loose: number; sizeKb: number }>(
    "get_repository_stats",
    { path: repoPath },
  );
}

/**
 * Get pack file information for repository
 */
export async function getPackInfo(
  repoPath: string,
): Promise<CommandResult<{ packCount: number; packSizeKb: number }>> {
  return invokeCommand<{ packCount: number; packSizeKb: number }>(
    "get_pack_info",
    { path: repoPath },
  );
}

/**
 * Prune remote tracking branches that no longer exist on the remote
 *
 * This runs `git remote prune` to remove stale remote tracking branches.
 *
 * @param repoPath Path to the repository
 * @param remote Specific remote to prune, or undefined for all remotes
 * @returns Result with list of pruned branches
 */
export async function pruneRemoteTrackingBranches(
  repoPath: string,
  remote?: string,
): Promise<CommandResult<PruneResult>> {
  // Offline is settled before the remote list is read, so the user hears
  // "offline mode is enabled" rather than whatever enumerating the remotes
  // happens to report. `checkNetworkAllowed` is called for its toast; the
  // refusal is unconditional.
  if (settingsStore.getState().offlineMode) {
    await checkNetworkAllowed(repoPath, remote);
    return blockedResult();
  }

  let targets: string[];
  // The listed remotes already carry their URLs, so the allowlist gate and the
  // token loop below both read them from here instead of resolving each one
  // over IPC again.
  const urlByName = new Map<string, string>();
  if (remote) {
    targets = [remote];
  } else {
    const remotes = await getRemotes(repoPath);
    if (!remotes.success) return { success: false, error: remotes.error };
    if (!Array.isArray(remotes.data)) {
      return {
        success: false,
        error: { code: 'REMOTE_LIST_FAILED', message: 'Failed to list repository remotes' },
      };
    }
    targets = remotes.data.map((item) => item.name);
    for (const item of remotes.data) {
      if (item.url) urlByName.set(item.name, item.url);
    }
  }
  // A repo with no remotes has nothing to prune — and nothing to gate either,
  // so it must not prompt.
  if (targets.length === 0) {
    return { success: true, data: { success: true, branchesPruned: [] } };
  }
  if (!await checkNetworkPermission(
    'prune remote-tracking branches',
    repoPath,
    undefined,
    undefined,
    // Hand the gate the URLs already read above. Bare names would send the
    // allowlist check back through `resolveRemoteUrl`, which re-reads the whole
    // remote list once per remote.
    targets.map((name) => ({ name, url: urlByName.get(name) })),
  )) {
    return blockedResult();
  }
  const tokens: Record<string, string> = {};
  for (const target of targets) {
    const remoteUrl = urlByName.get(target) ?? await resolveRemoteUrl(repoPath, target);
    const host = remoteUrl ? cloneUrlHost(remoteUrl) : null;
    let integrationType: IntegrationType | undefined;
    /** The Azure DevOps organization this remote names — see the ado arm below. */
    let adoOrg: string | undefined;
    if (host === 'github.com' || host?.endsWith('.github.com')) {
      integrationType = 'github';
    } else if (
      host === 'dev.azure.com' ||
      host === 'ssh.dev.azure.com' ||
      host?.endsWith('.visualstudio.com')
    ) {
      integrationType = 'azure-devops';
      adoOrg = remoteUrl && host ? adoUrlOrganization(remoteUrl, host) : undefined;
    } else if (
      host === 'gitlab.com' ||
      host?.endsWith('.gitlab.com') ||
      (host && await findGitLabAccountForHost(host))
    ) {
      integrationType = 'gitlab';
    }

    let token: string | undefined;
    // Set when the resolver named an account scoped to some OTHER GitLab
    // instance, or some OTHER Azure DevOps organization, than this remote's —
    // see the two arms below. Such an answer is no answer at all for this
    // remote, so the host-matching fallback must still get its turn.
    let wrongInstance = false;
    // A token must never ride a plaintext transport: the backend scopes it with
    // an `http://` credential helper just as readily as an `https://` one, so
    // an `http://` remote would put it on the wire in clear. `getCloneToken`
    // already refuses those URLs; the account tier hands the token over itself,
    // so it has to make the same check rather than inherit it.
    if (remoteUrl && cloneUrlIsCredentialSafe(remoteUrl) && integrationType) {
      const { account, repoSpecific } = await resolveRepoAccount(
        repoPath,
        integrationType,
        target,
        remoteUrl,
      );
      if (account) {
        const { AccountCredentials, getFreshAccountToken } = await import(
          './credential.service.ts'
        );
        if (integrationType === 'azure-devops') {
          // Every ADO account is scoped to exactly one organization, and a
          // `{org}.visualstudio.com` host varies per organization just as a
          // GitLab instance host varies per account — so the same hazard as
          // the gitlab arm below applies. The resolver's last tier is the
          // GLOBAL default, reported as a match like any other; trusting it
          // would scope one org's PAT to another org's host and still fail to
          // authenticate there. Only the account for THIS organization may
          // answer; otherwise leave the token unset and let `getCloneToken`
          // below pick by organization.
          const accountOrg =
            account.config.type === 'azure-devops' ? account.config.organization : undefined;
          if (accountOrg && adoOrg && accountOrg.toLowerCase() === adoOrg.toLowerCase()) {
            token =
              await getFreshAccountToken('azure-devops', account.id, 'azure') ?? undefined;
          } else {
            wrongInstance = true;
          }
        } else if (integrationType === 'gitlab') {
          // GitLab is the one provider whose host varies per account, and the
          // resolver's last tier is the GLOBAL default — reported as a match
          // like any other. Trusting it here would hand, say, a gitlab.com PAT
          // to an unrelated self-hosted server that has never seen it, and the
          // prune would still fail to authenticate there. Only the account that
          // serves THIS host may answer; otherwise leave the token unset and
          // let `getCloneToken` below pick by host.
          const instanceUrl =
            account.config.type === 'gitlab' ? account.config.instanceUrl : undefined;
          if (instanceUrl && cloneUrlHost(instanceUrl) === host) {
            token =
              await getFreshAccountToken('gitlab', account.id, 'gitlab', instanceUrl) ?? undefined;
          } else {
            wrongInstance = true;
          }
        } else {
          token = await AccountCredentials.getToken('github', account.id) ?? undefined;
        }
      }
      if (!token && (!repoSpecific || wrongInstance)) {
        token = await getCloneToken(remoteUrl);
      }
    } else if (remoteUrl && cloneUrlIsCredentialSafe(remoteUrl)) {
      token = await getCloneToken(remoteUrl);
    }
    if (token) tokens[target] = token;
  }

  return invokeCommand<PruneResult>("prune_remote_tracking_branches", {
    path: repoPath,
    remotes: targets,
    tokens,
  });
}

/**
 * Checkout file operations
 */

/**
 * Checkout a file from a specific commit, restoring it in the working directory.
 * This overwrites the file in the working directory and stages the change.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.commit Commit OID or ref (e.g., "HEAD~1", tag name, branch name)
 * @returns The file content and metadata at the specified commit
 */
export async function checkoutFileFromCommit(
  path: string,
  args: CheckoutFileFromCommitCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("checkout_file_from_commit", {
    path,
    filePath: args.filePath,
    commit: args.commit,
  });
}

/**
 * Checkout a file from a specific branch, restoring it in the working directory.
 * This resolves the branch to its tip commit and checks out the file from there.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.branch Branch name (local or remote)
 * @returns The file content and metadata at the branch tip
 */
export async function checkoutFileFromBranch(
  path: string,
  args: CheckoutFileFromBranchCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("checkout_file_from_branch", {
    path,
    filePath: args.filePath,
    branch: args.branch,
  });
}

/**
 * View a file at a specific commit without modifying the working directory.
 * This is a read-only operation for previewing file contents at a point in history.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.commit Commit OID or ref (e.g., "HEAD~1", tag name, branch name)
 * @returns The file content and metadata at the specified commit
 */
export async function getFileAtCommit(
  path: string,
  args: GetFileAtCommitCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("get_file_at_commit", {
    path,
    filePath: args.filePath,
    commit: args.commit,
  });
}

/**
 * File encoding operations
 */

/**
 * Detect the encoding of a file in the repository.
 * Returns encoding name, confidence, BOM detection, line ending style, and binary status.
 *
 * @param path Repository path
 * @param filePath File path relative to the repository root
 * @returns Encoding information for the file
 */
export async function detectFileEncoding(
  path: string,
  filePath: string,
): Promise<CommandResult<FileEncodingInfo>> {
  return invokeCommand<FileEncodingInfo>("detect_file_encoding", {
    path,
    filePath,
  });
}

/**
 * Convert a file's encoding to a target encoding.
 * The file is read with its detected encoding, decoded, and re-encoded to the target.
 *
 * @param path Repository path
 * @param filePath File path relative to the repository root
 * @param targetEncoding Target encoding name (e.g., "utf-8", "utf-16le", "shift_jis")
 * @returns Conversion result with source/target encodings and bytes written
 */
export async function convertFileEncoding(
  path: string,
  filePath: string,
  targetEncoding: string,
): Promise<CommandResult<ConvertEncodingResult>> {
  return invokeCommand<ConvertEncodingResult>("convert_file_encoding", {
    path,
    filePath,
    targetEncoding,
  });
}

// ── Commit Message Validation ──────────────────────────────────────

/**
 * Rules for validating commit messages
 */
export interface CommitMessageRules {
  /** Maximum length of the subject line (e.g., 72) */
  maxSubjectLength: number | null;
  /** Maximum length of each body line (e.g., 100) */
  maxBodyLineLength: number | null;
  /** Require a blank line between subject and body */
  requireBlankLineBeforeBody: boolean;
  /** Require conventional commit format: type(scope): description */
  requireConventionalFormat: boolean;
  /** Allowed conventional commit types (e.g., feat, fix, chore) */
  allowedTypes: string[];
  /** Require a scope in conventional commits */
  requireScope: boolean;
  /** Require a body in the commit message */
  requireBody: boolean;
  /** Phrases that are not allowed in commit messages (e.g., "WIP", "TODO") */
  forbiddenPhrases: string[];
}

/**
 * A single validation error or warning
 */
export interface CommitValidationError {
  /** The rule that was violated */
  rule: string;
  /** Human-readable description of the violation */
  message: string;
  /** The line number where the violation occurred (1-based), if applicable */
  line: number | null;
}

/**
 * Result of validating a commit message
 */
export interface CommitValidationResult {
  /** Whether the message passes all rules */
  isValid: boolean;
  /** Errors that must be fixed */
  errors: CommitValidationError[];
  /** Warnings that are advisory */
  warnings: CommitValidationError[];
}

/**
 * Validate a commit message against the provided rules.
 *
 * @param message - The commit message to validate
 * @param rules - The validation rules to apply
 * @returns Validation result with errors and warnings
 */
export async function validateCommitMessage(
  message: string,
  rules: CommitMessageRules,
): Promise<CommandResult<CommitValidationResult>> {
  return invokeCommand<CommitValidationResult>("validate_commit_message", {
    message,
    rules,
  });
}

/**
 * Get the commit message rules for a repository.
 * Returns null if no rules have been configured.
 *
 * @param path - Repository path
 * @returns Commit message rules or null
 */
export async function getCommitMessageRules(
  path: string,
): Promise<CommandResult<CommitMessageRules | null>> {
  return invokeCommand<CommitMessageRules | null>(
    "get_commit_message_rules",
    { path },
  );
}

/**
 * Set the commit message rules for a repository.
 * Rules are stored in .git/gitnado/commit_rules.json.
 *
 * @param path - Repository path
 * @param rules - The rules to set
 * @returns The saved rules
 */
export async function setCommitMessageRules(
  path: string,
  rules: CommitMessageRules,
): Promise<CommandResult<CommitMessageRules>> {
  return invokeCommand<CommitMessageRules>("set_commit_message_rules", {
    path,
    rules,
  });
}

/**
 * Run garbage collection on a repository
 * Cleans up unnecessary files and optimizes the local repository
 */
export async function runGc(
  args: RunGcCommand & { silent?: boolean },
): Promise<CommandResult<MaintenanceResult>> {
  const result = await invokeCommand<MaintenanceResult>("run_gc", args);
  if (!args?.silent) {
    if (result.success && result.data) {
      showToast(result.data.message, "success");
    } else {
      showToast(`Garbage collection failed: ${result.error?.message}`, "error");
    }
  }
  return result;
}

/**
 * Run file system check on a repository
 * Verifies the connectivity and validity of objects in the repository
 */
export async function runFsck(
  args: RunFsckCommand & { silent?: boolean },
): Promise<CommandResult<MaintenanceResult>> {
  const result = await invokeCommand<MaintenanceResult>("run_fsck", args);
  if (!args?.silent) {
    if (result.success && result.data) {
      showToast(result.data.message, "success");
    } else {
      showToast(`Repository check failed: ${result.error?.message}`, "error");
    }
  }
  return result;
}

/**
 * Prune unreachable objects from the repository
 */
export async function runPrune(
  args: RunPruneCommand & { silent?: boolean },
): Promise<CommandResult<MaintenanceResult>> {
  const result = await invokeCommand<MaintenanceResult>("run_prune", args);
  if (!args?.silent) {
    if (result.success && result.data) {
      showToast(result.data.message, "success");
    } else {
      showToast(`Prune failed: ${result.error?.message}`, "error");
    }
  }
  return result;
}

/**
 * @deprecated Use runGc instead. Kept for backward compatibility.
 */
export async function runGarbageCollection(
  args: RunGcCommand & { silent?: boolean },
): Promise<CommandResult<MaintenanceResult>> {
  return runGc(args);
}

/**
 * @deprecated Use runFsck instead. Kept for backward compatibility.
 */
export async function verifyRepository(
  args: RunFsckCommand & { silent?: boolean },
): Promise<CommandResult<MaintenanceResult>> {
  return runFsck(args);
}
