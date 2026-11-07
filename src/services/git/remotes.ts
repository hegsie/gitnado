import { invokeCommand, listenToEvent } from "../tauri-api.ts";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { showToast } from "../notification.service.ts";
import { showErrorWithSuggestion } from "../error-suggestion.service.ts";
import { settingsStore } from "../../stores/settings.store.ts";
import type {
  Remote,
} from "../../types/git.types.ts";
import type {
  FetchCommand,
  FetchAllRemotesCommand,
  FetchAllResult,
  RemoteFetchStatus,
  PullCommand,
  PushCommand,
  PushToMultipleRemotesCommand,
  MultiPushResult,
  RunGcCommand,
  RunFsckCommand,
  RunPruneCommand,
  MaintenanceResult,
  CommandResult,
} from "../../types/api.types.ts";
import type {
  IntegrationType,
} from "../../types/unified-profile.types.ts";
import {
  adoUrlOrganization,
  blockedResult,
  checkNetworkAllowed,
  checkNetworkPermission,
  cloneUrlHost,
  cloneUrlIsCredentialSafe,
  findGitLabAccountForHost,
  getCloneToken,
  getRemoteToken,
  getRepoToken,
  isNetworkPolicyActive,
  resolveRemotePushUrl,
  resolveRemoteUrl,
  resolveRepoAccount,
  resolveRepoToken,
  surfaceBackendRefusal,
} from "./shared.ts";
import type {
  NetworkRemoteTarget,
  NetworkTargetKind,
} from "./shared.ts";

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
  // Judged on the remote's PUSH url, like the tag paths already are: git2 and
  // `git push` both contact `remote.<n>.pushurl` when one is set (the Remote
  // dialog itself can set one, on any host), so the fetch url says nothing
  // about where this push is going. Only an allowlist needs the lookup.
  // Resolved whenever ANY policy is in force, not just an allowlist: offline
  // mode now judges the target too (a remote on this machine is permitted), and
  // judging a push on the FETCH url would let a local fetch url excuse a
  // `pushurl` that leaves the machine.
  const pushUrl =
    args?.path && args.remote && isNetworkPolicyActive()
      ? await resolveRemotePushUrl(args.path, args.remote)
      : null;
  if (!await checkNetworkPermission('push', args?.path ?? null, args?.remote, pushUrl)) {
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
  } else {
    // The silent branch hands the result to a caller that treats `BLOCKED` as
    // "the gate already explained itself" and says nothing — true when the
    // frontend gate refused above (it toasted, and returned before reaching
    // here), false when only the BACKEND did. And the backend really does
    // refuse pushes this gate cannot: `remote.rs::push` also runs
    // `guard_lfs_upload`, which judges the LFS UPLOAD endpoint
    // (`lfs.pushurl`, a committed `.lfsconfig` can set it to any host) — a
    // target nothing on this side ever resolves. Without this the user
    // watched "Pushing to remote…" appear and vanish with nothing said,
    // while the very same repository pushed as a TAG explained itself,
    // because `pushTag` has always wrapped.
    surfaceBackendRefusal(result);
  }
  return result;
}

/**
 * Push to multiple remotes at once
 */
export async function pushToMultipleRemotes(
  args: PushToMultipleRemotesCommand & { silent?: boolean },
): Promise<CommandResult<MultiPushResult>> {
  // Every destination is gated, each on its PUSH url (see `push`), and the
  // user is asked once for the whole set. Gating the repository's default
  // remote alone — what this used to do — judged a host the gesture might
  // not even touch, and none of the ones it would.
  // Resolved whenever ANY policy is in force, exactly as single `push` does:
  // offline mode judges the target too now, so a `pushurl` that leaves the
  // machine must not be excused by a local fetch url, and a `pushurl` that
  // stays on this machine must not be refused because the fetch url is remote.
  // Reading only the allowlist here made this button disagree with the single
  // push to the very same remote.
  const remotes = args?.remotes ?? [];
  const pushUrls =
    args?.path && remotes.length > 0 && isNetworkPolicyActive()
      ? await Promise.all(remotes.map((name) => resolveRemotePushUrl(args.path, name)))
      : remotes.map(() => null);
  const targets: NetworkRemoteTarget[] = remotes.map((name, i) => ({ name, url: pushUrls[i] }));
  if (
    !await checkNetworkPermission(
      'push',
      args?.path ?? null,
      undefined,
      undefined,
      targets.length > 0 ? targets : undefined,
    )
  ) {
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
  } else {
    // Identical gap to single `push`, through the identical backend guard:
    // `guard_push_destinations` runs `guard_lfs_upload` for every destination
    // (remote.rs), so a `.lfsconfig` pointing off the allowlist refuses the
    // whole gesture on a target this side never resolved.
    surfaceBackendRefusal(result);
  }
  return result;
}

/**
 * Fetch from all remotes at once
 */
export async function fetchAllRemotes(
  args: FetchAllRemotesCommand & { silent?: boolean },
): Promise<CommandResult<FetchAllResult>> {
  // Every remote in the gesture is gated, exactly as the backend's own guard
  // does (`fetch_all_remotes` in remote.rs loops `guard_remote` over
  // `repo.remotes()`), and exactly as this function's two multi-remote
  // siblings above do. Gating the repository's DEFAULT fetch remote alone —
  // what this used to do — judged one host out of several: it waved a
  // github.com remote through because the default one happened to be a USB
  // disk, and it let a gesture the backend would refuse outright start anyway,
  // so the user got a red "Fetch all failed" instead of the gate's own
  // explanation. Only a policy in force needs the extra round trip.
  let targets: NetworkRemoteTarget[] | undefined;
  if (args?.path && isNetworkPolicyActive()) {
    const remotes = await getRemotes(args.path);
    if (!remotes.success) return { success: false, error: remotes.error };
    if (!Array.isArray(remotes.data)) {
      return {
        success: false,
        error: { code: 'REMOTE_LIST_FAILED', message: 'Failed to list repository remotes' },
      };
    }
    targets = remotes.data.map((item) => ({ name: item.name, url: item.url }));
    // An empty list is left as `undefined` so the gate keeps its single-target
    // behaviour: there is no remote to name, so it resolves nothing, sees no
    // URL and fails closed — which is what it already did here, and what it
    // does everywhere else it cannot see a destination. An empty ARRAY would
    // mean "the hard blocks are settled" (the idiom `updateSubmodules` uses)
    // and wave an ungated `fetch_all_remotes` straight through.
    if (targets.length === 0) targets = undefined;
  }
  if (!await checkNetworkPermission('fetch', args?.path ?? null, undefined, undefined, targets)) {
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

/**
 * A `.gitmodules` url that is relative to the superproject.
 *
 * git resolves `./x.git` and `../x.git` against the superproject's OWN remote,
 * so such a submodule is always fetched from the superproject's host — the one
 * the gate has already checked. The allowlist cannot parse a host out of the
 * relative string itself, so handing it over as a destination would refuse an
 * entirely ordinary relative layout.
 */
function isRelativeSubmoduleUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith('./') || trimmed.startsWith('../');
}

/**
 * Whether `wanted` — a path the caller hands git after `--` — selects the
 * submodule at `path`.
 *
 * Those paths are PATHSPECS, not submodule names: `git submodule update --
 * vendor` registers and clones every submodule under `vendor/`. Matching the
 * entries as exact submodule paths guarded nothing for that spelling, and let
 * the update reach a host the allowlist never admitted. The exact path and
 * the directory-prefix form are reproduced here; anything else falls back to
 * checking every submodule (see `selectSubmodules`).
 */
function pathspecSelects(wanted: string, path: string): boolean {
  const trimmed = wanted.replace(/\/+$/, '');
  return path === trimmed || path.startsWith(`${trimmed}/`);
}

/**
 * The submodules a `submodulePaths` list selects out of `all`.
 *
 * Every one of them when the list is absent or empty (the backend emits a bare
 * `--` for an empty list, and git then updates every submodule), when an entry
 * carries glob characters (git's pathspec matching is not reproduced here, and
 * guessing at it would guess OPEN), and when an entry selects nothing (the
 * update then has a destination this check cannot see, which is the
 * fail-closed rule the rest of the gate uses). Otherwise exactly the
 * submodules the pathspecs name.
 */
function selectSubmodules(all: Submodule[], submodulePaths?: string[]): Submodule[] {
  if (!submodulePaths || submodulePaths.length === 0) return all;
  if (submodulePaths.some((p) => /[*?[]/.test(p))) return all;
  for (const entry of submodulePaths) {
    if (!all.some((s) => pathspecSelects(entry, s.path))) return all;
  }
  return all.filter((s) => submodulePaths.some((entry) => pathspecSelects(entry, s.path)));
}

/**
 * Check every host `git submodule update` is actually going to contact.
 *
 * The superproject's remote is NOT the answer on its own: a submodule url is
 * repository content and can name any host it likes, and `git submodule
 * update` clones or fetches every one of them. Checking only the superproject
 * — which is all this used to do — let an allowlist of `github.com` sit there
 * while the app went to gitlab.com. The backend enforces the same rule
 * (`commands/submodule.rs`); this half is the one that can say so in a toast
 * before any work starts.
 *
 * `submodule.url` from `get_submodules` is the url git will really use —
 * `submodule.<name>.url` from the repository config, falling back to
 * `.gitmodules` when nothing is registered — which is what the backend judges
 * too. It used to be the `.gitmodules` snapshot alone, so the two halves
 * judged different urls: with upstream having moved a submodule, the config
 * url on the allowlist and the `.gitmodules` url off it, git and the backend
 * both allowed the update and this half refused it, naming a host the
 * operation never contacts.
 *
 * Offline mode is judged per submodule, like everything else. It used to
 * refuse here before anything was listed, so the local-target carve-out
 * `checkNetworkAllowed` makes could never be reached: a submodule on
 * `/srv/git/dep.git` opens no socket, an allowlist permits updating it, and
 * offline mode refused it anyway — stricter than an allowlist for an
 * identical purely-local operation, and refusing to UPDATE a submodule the
 * same dialog had just let the user ADD (`addSubmodule` checks the url).
 *
 * Under an allowlist the superproject's own remote is deliberately not
 * checked: it is only where a RELATIVE submodule url resolves to, and the
 * backend guards it for exactly those. Checking it for every update refused a
 * local-only superproject — no remotes at all — whose `.gitmodules` named
 * nothing but allowlisted hosts.
 *
 * Top-level only, on purpose. A NESTED submodule's url lives in its parent's
 * `.gitmodules`, which does not exist until the parent is cloned, so no check
 * made before the command runs can see it. The backend is the honest gate for
 * those: under a policy it walks the tree itself instead of handing git
 * `--recursive`, guarding each level before that level is contacted.
 *
 * Skipped entirely when no policy is in force, so the common case does not pay
 * for an extra round trip. When the submodules cannot be listed, the check
 * fails closed, exactly as an unresolvable remote does.
 */
async function checkSubmoduleHostsAllowed(
  repoPath: string,
  submodulePaths?: string[],
  /** Whether the update carries `--init`. Without it git skips a submodule
   * that was never registered — verified: exit 0, nothing contacted — so its
   * host is not one this update will reach and must not refuse it. */
  init = false,
): Promise<boolean> {
  if (!isNetworkPolicyActive()) return true;

  const listed = await getSubmodules(repoPath);
  if (!listed.success || !listed.data) {
    return (await checkNetworkAllowed(null, undefined)) === null;
  }

  for (const submodule of selectSubmodules(listed.data, submodulePaths)) {
    // Deliberately still `initialized` and not "has no config url", which is
    // the backend's own drop rule: an entry registered in the config but not
    // cloned is skipped here and judged there. That direction only ever
    // UNDER-refuses, and `surfaceBackendRefusal` toasts the backend's reason
    // when it does, so nothing goes unexplained. The opposite direction —
    // refusing what git would happily do — is the one this gate must not take.
    if (!submodule.initialized && !init) continue;
    if (submodule.url && isRelativeSubmoduleUrl(submodule.url)) {
      // Resolves against the superproject's remote, so that remote is the
      // host to check — the one case it decides anything.
      if (await checkNetworkAllowed(repoPath, undefined)) return false;
      continue;
    }
    // A submodule url is a git REMOTE even though no repo path was resolved
    // for it, so it gets the remote reading of "is this on this machine".
    if (await checkNetworkAllowed(null, submodule.url ?? undefined, false, undefined, 'remote'))
      return false;
  }
  return true;
}


export async function addSubmodule(
  repoPath: string,
  url: string,
  submodulePath: string,
  branch?: string,
): Promise<CommandResult<Submodule>> {
  // `git submodule add` clones from `url` — a network operation despite living
  // among the local submodule commands. A relative url is checked against the
  // superproject's remote, the host git will actually resolve it to.
  const relative = isRelativeSubmoduleUrl(url);
  if (
    !await checkNetworkPermission(
      'add submodule',
      relative ? repoPath : null,
      relative ? undefined : url,
      undefined,
      undefined,
      // A submodule url is a git remote, whichever branch resolved it.
      'remote',
    )
  ) {
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
  // behind the same gate as fetch/pull — applied to every host named in
  // `.gitmodules`, which is where the clones and fetches this spawns actually
  // go, rather than to the superproject's own remote.
  if (!await checkSubmoduleHostsAllowed(repoPath, options?.submodulePaths, options?.init)) {
    return blockedResult();
  }
  // The confirm, when the user asked for one. The hard blocks were settled
  // above against the submodule hosts, so none is named here for the
  // allowlist to resolve — an empty target list runs only the confirm.
  if (!await checkNetworkPermission('update submodules', repoPath, undefined, undefined, [])) {
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

  return surfaceBackendRefusal(await invokeCommand<void>("update_submodules", {
    path: repoPath,
    submodulePaths: options?.submodulePaths,
    init: options?.init,
    recursive: options?.recursive,
    remote: options?.remote,
    token,
    tokenRemote,
  }));
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

/**
 * What `get_lfs_endpoint` reports: the URL an LFS transfer will contact, and
 * where that URL came from. Mirrors `LfsEndpoint` in
 * `src-tauri/src/commands/lfs.rs`.
 */
export interface LfsEndpointInfo {
  /** The URL (or path) the transfer will contact. */
  url: string;
  /** `'config'` for an `lfs.*` key (a committed `.lfsconfig` may set one),
   * `'remote'` for the git remote's own url falling through verbatim. */
  kind: 'config' | 'remote';
}

/**
 * The URL an LFS transfer will contact, for the allowlist.
 *
 * git-lfs does not talk to the git remote: its endpoint comes from `lfs.url`
 * / `remote.<r>.lfsurl`, which a COMMITTED `.lfsconfig` may set, before it
 * falls back to the remote. The backend resolves it the way git-lfs does
 * (`get_lfs_endpoint`); judged on the git remote alone, a github.com
 * allowlist waved through a pull that transferred from wherever the
 * repository's own `.lfsconfig` pointed. `null` when nothing names one — the
 * gate then falls back to the remote, and the backend's own check (which
 * fails closed) is the backstop.
 *
 * Looked up whenever ANY policy is in force, not just an allowlist: offline
 * mode judges the target too (a `file://` or filesystem LFS endpoint never
 * leaves the machine), so reading only the allowlist here left offline mode
 * judging the git remote instead of the endpoint the transfer really contacts
 * — in both directions.
 */
async function resolveLfsEndpoint(repoPath: string): Promise<LfsEndpointInfo | null> {
  if (!isNetworkPolicyActive()) return null;
  const result = await invokeCommand<LfsEndpointInfo | null>('get_lfs_endpoint', {
    path: repoPath,
  });
  return result.success && result.data ? result.data : null;
}

/**
 * Which reading of "a place on this machine" a resolved LFS endpoint is owed.
 *
 * `'config'` — an `lfs.url` / `lfs.pushurl` / `remote.<r>.lfs*url` value, which
 * a COMMITTED `.lfsconfig` may have chosen. It is a URL, not a git remote, so
 * it takes the strict reading: `evil.example.com/lfs` is an outbound host, not
 * a path on this disk.
 *
 * `'remote'` — the git remote's own url, which git-lfs falls back to verbatim
 * when nothing names an endpoint. That IS a git remote, so `sub/mybackup.git`
 * is a repository on this disk and gets the same reading the push gate beside
 * it already gives the very same string.
 *
 * `null` — nothing resolved, so the gate falls back to the git remote and the
 * backend (which fails closed on an endpoint it cannot see) is the backstop.
 * The strict reading keeps the two halves agreeing on that refusal.
 */
function lfsEndpointTargetKind(endpoint: LfsEndpointInfo | null): NetworkTargetKind {
  return endpoint?.kind === 'remote' ? 'remote' : 'host';
}

export async function lfsPull(
  repoPath: string,
): Promise<CommandResult<string>> {
  const endpoint = await resolveLfsEndpoint(repoPath);
  // An LFS endpoint is USUALLY a URL rather than a git remote, so it takes the
  // strict reading — but git-lfs's last resort is the git remote's url
  // verbatim, and the backend judges that one with `check_remote`. The kind
  // rides along with the URL so both halves give the same string the same
  // reading; guessing 'host' for all of them refused a pull against
  // `sub/mybackup.git`, a repository on this disk.
  if (
    !await checkNetworkPermission(
      'LFS pull',
      repoPath,
      undefined,
      endpoint?.url ?? null,
      undefined,
      lfsEndpointTargetKind(endpoint),
    )
  ) {
    return blockedResult();
  }
  const token = await getRepoToken(repoPath);
  return surfaceBackendRefusal(await invokeCommand<string>("lfs_pull", { path: repoPath, token }));
}

export async function lfsFetch(
  repoPath: string,
  refs?: string[],
): Promise<CommandResult<string>> {
  const endpoint = await resolveLfsEndpoint(repoPath);
  // See `lfsPull`: the endpoint's provenance chooses the reading, because the
  // fallback endpoint IS the git remote.
  if (
    !await checkNetworkPermission(
      'LFS fetch',
      repoPath,
      undefined,
      endpoint?.url ?? null,
      undefined,
      lfsEndpointTargetKind(endpoint),
    )
  ) {
    return blockedResult();
  }
  const token = await getRepoToken(repoPath);
  return surfaceBackendRefusal(
    await invokeCommand<string>("lfs_fetch", { path: repoPath, refs, token }),
  );
}

export async function lfsPrune(
  repoPath: string,
  dryRun?: boolean,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("lfs_prune", { path: repoPath, dryRun });
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
        // The tag is `gn-app-shell` (see the @customElement in app-shell.ts);
        // querying "app-shell" found nothing in the real UI, so every late
        // conflict fell through to the plain refresh below and left the
        // repository mid-merge with no dialog.
        const shell = conflict ? document.querySelector("gn-app-shell") : null;
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

export interface HookExecutionLog {
  id: string;
  repoPath: string;
  hookName: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  exitCode: number | null;
  output: string;
}

export async function getHookExecutionLogs(
  path: string,
): Promise<CommandResult<HookExecutionLog[]>> {
  return invokeCommand<HookExecutionLog[]>("get_hook_execution_logs", { path });
}

export async function clearHookExecutionLogs(
  path: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("clear_hook_execution_logs", { path });
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
  // Offline mode is NOT settled ahead of the remote list. It used to be, and
  // that refused a prune of a remote living on this machine — the one case
  // both the backend (`maintenance.rs`) and the allowlist branch below permit,
  // and it refused it in silence, because `checkNetworkAllowed` returns null
  // for a local target so no toast fired and the dialogs suppress `BLOCKED`.
  // The gate below sees every remote WITH its URL and applies the same
  // local-target carve-out per target, still toasting "Offline mode is
  // enabled" for the first one that genuinely leaves the machine.
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
      // A keyring that cannot be read must not fail the prune: the same
      // posture as `getCloneToken` and `resolveRepoToken`, which proceed
      // unauthenticated and log. This loop's callers read the outcome off the
      // result and one of them holds the repository's ref-op lock across the
      // call, so a throw here left that lock held for the life of the app.
      try {
        if (account) {
          const { AccountCredentials, getFreshAccountToken } = await import(
            '../credential.service.ts'
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
      } catch (err) {
        console.error(`Failed to read the stored token for remote '${target}':`, err);
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
