import { invokeCommand } from "../tauri-api.ts";
import { showToast } from "../notification.service.ts";
import { showConfirm } from "../dialog.service.ts";
import { settingsStore } from "../../stores/settings.store.ts";
import type {
  Remote,
} from "../../types/git.types.ts";
import type {
  CommandResult,
} from "../../types/api.types.ts";
import type {
  IntegrationType,
  IntegrationAccount,
} from "../../types/unified-profile.types.ts";

export type NetworkBlockReason = 'offline' | 'allowlist' | 'declined';

/**
 * Which question the gate's "is this a place on this machine?" carve-out is
 * being asked.
 *
 * `'remote'` — the target is a git REMOTE, so a bare relative path
 * (`sub/backup.git`) is a repository on this disk. `'host'` — it may be a bare
 * host or a scheme-less endpoint, where reading a separator that way would wave
 * the request through with its host never judged. Mirrors the `check` /
 * `check_remote` split in `src-tauri/src/services/security.rs`.
 */
export type NetworkTargetKind = 'remote' | 'host';

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
 *
 * No name given means the remote git itself would use — the current branch's
 * tracking remote, then `origin` — which is what `get_fetch_remote` answers,
 * exactly as `push` asks `get_push_remote`. Assuming `origin` judged the wrong
 * host in the ordinary fork layout (origin on github.com, the branch tracking
 * `upstream` on gitlab.com), for every caller that names no remote: LFS, a
 * relative submodule url, deepen/unshallow.
 */
export async function resolveRemoteUrl(repoPath: string, remote?: string): Promise<string | null> {
  if (remote && looksLikeUrl(remote)) {
    return remote;
  }
  let wanted = remote;
  if (wanted === undefined) {
    const resolved = await invokeCommand<string>('get_fetch_remote', { path: repoPath });
    if (resolved.success && resolved.data) wanted = resolved.data;
  }
  const result = await invokeCommand<Remote[]>("get_remotes", { path: repoPath });
  if (!result.success || !result.data) return null;
  // A caller that NAMED a remote gets that remote or nothing. Falling back to
  // the first in the list judged — and reported — a host the caller never
  // named, which is the same defect the `git@`-only URL test above caused by
  // another route. The backend half (`resolve_remote_url`, `security.rs`) and
  // the sibling below both fail closed here; the gate then refuses, because a
  // target it cannot see is a target it must not wave through.
  const match =
    result.data.find((r) => r.name === (wanted ?? 'origin')) ??
    (remote === undefined ? result.data[0] : undefined);
  return match?.url ?? null;
}

export async function resolveRemotePushUrl(repoPath: string, remote?: string): Promise<string | null> {
  if (remote && looksLikeUrl(remote)) {
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
/**
 * The host of a scp-like `[user@]host:path` target, or null when the string is
 * not that form.
 *
 * Mirrors `split_scp_like` / `scp_like_host` in
 * `src-tauri/src/services/security.rs`, bracketed IPv6 literal included; any
 * change to either half has to move both, exactly as `isLocalTarget` and
 * `is_local_target` already do.
 *
 * git (`connect.c`, `url_is_local_not_ssh`) reads a target as scp-like as soon
 * as a colon comes before any slash, and the LOGIN IS OPTIONAL:
 * `gitserver:team/app.git` is an ssh remote, and it is the spelling an
 * `~/.ssh/config` `Host` alias leaves behind. Requiring `user@` here resolved
 * that remote to no host at all, so the gate refused every fetch, pull and push
 * to it — `Remote "gitserver:team/app.git" is not in your allowlist`, with no
 * entry that could ever have named it.
 *
 * Three guards keep the widened form off what is not a remote at all:
 *
 * - the login is read only from AHEAD of the separating colon, so the `@` in
 *   `gitserver:x@evil.test:y` belongs to the PATH — git reads that as the path
 *   `x@evil.test:y` on `gitserver`, and so does the backend half;
 * - neither separator may appear in the host, so `./x:y` and `.\x:y` stay
 *   relative paths;
 * - with no login to say otherwise, a one-letter authority is a Windows drive
 *   (`C:\repos\app.git`, `c:x`), which git carves out too.
 */
export function scpLikeHost(value: string): string | null {
  const trimmed = value.trim();
  // Step for step the same walk as `split_scp_like`, rather than one regex
  // that has to be read twice to see that it agrees with it: the two halves
  // have to answer alike for every string, and a backtracking alternation
  // quietly did not (`x@:y` matched the host `x@` here while the Rust half
  // declined it).
  const delimiter = /[@:/]/.exec(trimmed);
  let login: string | null = null;
  let rest = trimmed;
  if (delimiter && delimiter[0] === '@') {
    // `@host:path` names an empty login: not a form git accepts.
    if (delimiter.index === 0) return null;
    login = trimmed.slice(0, delimiter.index);
    rest = trimmed.slice(delimiter.index + 1);
  }
  // A bracketed IPv6 literal carries colons of its own; only one AFTER the
  // closing bracket separates the host from the path.
  let colon: number;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return null;
    colon = rest.indexOf(':', close);
  } else {
    colon = rest.indexOf(':');
  }
  if (colon <= 0) return null;
  const host = rest.slice(0, colon);
  if (host.includes('/') || host.includes('\\')) return null;
  if (login === null && /^[A-Za-z]$/.test(host)) return null;
  return host.toLowerCase();
}

/**
 * Whether a string is already a URL rather than a remote NAME.
 *
 * Mirrors `looks_like_url` in `src-tauri/src/services/security.rs`; any change
 * to either half has to move both.
 *
 * It used to be a regex that required an `@` (`[^@/]+@[^:/]+:`), which is the
 * requirement the backend dropped when it learned that git's scp form takes an
 * OPTIONAL login. The two then disagreed about `gitserver:team/app.git`: the
 * backend passed it through as a URL while this half treated it as the name of
 * a remote, looked it up, found none, and (in `resolveRemoteUrl`) judged
 * whichever remote happened to be first in the list.
 *
 * `value` is a string BY CONTRACT only: `fetch` copies `get_fetch_remote`'s
 * answer straight into `args.remote`, so a backend that answered with anything
 * else lands here. The regex this replaced coerced such a value silently; so
 * does this, because turning a malformed answer into a TypeError inside the
 * gate would abort the operation with a stack trace instead of refusing it.
 */
export function looksLikeUrl(value: string): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed.includes('://') || scpLikeHost(trimmed) !== null;
}

/**
 * Whether a target is a place on THIS machine — a filesystem path or a
 * host-less `file://` URL.
 *
 * Mirrors `is_local_target` in `src-tauri/src/services/security.rs`; any change
 * to either half has to move both, exactly as `cloneUrlHost` and `url_host`
 * already do.
 *
 * This is the STRICT reading, for a target that may be a bare host
 * (`checkOutboundHostAllowed('api.github.com')`) or a scheme-less endpoint or
 * provider instance URL (`gitlab.example.com/gitlab`, which `providerApiHost`
 * hands straight over). A caller that knows it holds a git REMOTE takes
 * `isLocalRemoteTarget` below, which adds the one carve-out only a remote can
 * claim.
 *
 * A push to `/mnt/usb/repo.git` or `file:///srv/git/app.git` opens no socket at
 * all, so offline mode ("block every operation that leaves this machine") and
 * the remote allowlist (a list of HOSTS) have nothing to say about it. Both
 * refused one: offline mode answered before it looked at the target, and the
 * allowlist read `/mnt/usb/repo.git` as the host `mnt`.
 *
 * Deliberately EXCLUDED, because they do leave the machine: a UNC path
 * (`\\server\share`, and its `//server/share` spelling), a `file://` URL whose
 * host is ANOTHER machine, anything in the scp-like `user@host:path` form (so
 * `~user@host:repo.git` is read as the ssh remote git reads it), and anything
 * else carrying a scheme, so a path with a URL embedded in it cannot smuggle
 * one past this. A path that is really a network MOUNT is not excluded —
 * nothing in the string says so, and the kernel, not this app, does that I/O.
 */
export function isLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  // UNC, in either spelling.
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) return false;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const host = new URL(trimmed).hostname;
      // The URL spec folds `file://localhost/…` to an empty host. Anything
      // else on LOOPBACK is this machine too — `is_local_target` says so, and
      // refusing here what the backend gate permits would toast "Offline mode
      // is enabled" for a target that opens no socket off this box, with no
      // allowlist entry able to work around it.
      return host === '' || isLoopbackHost(host);
    } catch {
      return false;
    }
  }
  // A scheme, or the scp-like form, means a transport — never a path.
  if (trimmed.includes('://') || scpLikeHost(trimmed) !== null) {
    return false;
  }
  return (
    trimmed.startsWith('/') ||
    // `.` and `..` are `./` and `../` without the separator — the spelling
    // `git remote add local .` leaves behind.
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\') ||
    trimmed.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

/**
 * `isLocalTarget` for a string the caller knows is a git REMOTE: the same rule,
 * plus the BARE relative path only a remote can be.
 *
 * Mirrors `is_local_remote_target` in `src-tauri/src/services/security.rs`; any
 * change to either half has to move both.
 *
 * `git remote add b2 sub/mybackup.git` is purely local — git's
 * `url_is_local_not_ssh` (`connect.c`) reads a target with no colon, or with a
 * slash before its colon, as a path — but the strict rule above refused it, so
 * offline mode blocked a push that never leaves the machine and the allowlist
 * read the host as `sub`, whose only workaround was to allowlist the literal
 * string `sub`.
 *
 * It is a SECOND function because the rule is only safe where the string is
 * known to be a remote: calling `gitlab.example.com/gitlab` local would wave an
 * outbound request through with its host never judged. A bare host carries no
 * separator; a scheme-less instance URL with a path segment does.
 *
 * `mybackup.git`, with no separator at all, stays NON-local here too and is
 * pinned that way: nothing in that string tells it apart from a bare host, and
 * guessing "path" fails open. `./mybackup.git` is the spelling both halves have
 * always read as local.
 */
export function isLocalRemoteTarget(target: string): boolean {
  return isLocalTarget(target) || isBareRelativePath(target);
}

/**
 * A relative path written without a `./` — `sub/mybackup.git`, `sub\backup`.
 * Mirrors `is_bare_relative_path` in `src-tauri/src/services/security.rs`.
 *
 * Everything `isLocalTarget` excludes is excluded here first, and for the same
 * reasons: a UNC path is SMB, a scheme is the URL parser's business, and the
 * scp-like form is an ssh remote whose colon comes BEFORE any separator.
 */
export function isBareRelativePath(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) return false;
  // `file://…` is caught by the scheme test, and `isLocalTarget` has already
  // given it the answer its host deserves.
  if (trimmed.includes('://') || scpLikeHost(trimmed) !== null) return false;
  return trimmed.includes('/') || trimmed.includes('\\');
}

/**
 * Whether a host is the machine itself. Mirrors `is_loopback_host` in
 * `src-tauri/src/services/security.rs`.
 *
 * Only reached with a host `new URL()` already produced, and the WHATWG parser
 * canonicalises both literal families first — `[0:0:0:0:0:0:0:1]` comes back
 * `[::1]` and `127.1` comes back `127.0.0.1` — so matching the canonical forms
 * is the same rule Rust's `IpAddr::is_loopback` applies to the same string. The
 * `.localhost` suffix is required, so `localhost.evil.test` does not match.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  return octets !== null && octets[1] === '127' && octets.slice(1).every((o) => Number(o) <= 255);
}

export async function checkNetworkAllowed(
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
  /** Which question the local-target carve-out is being asked. `'remote'` means
   * the target is a git remote, so a bare relative path (`sub/backup.git`) is a
   * place on this disk; `'host'` means it may be a bare host or a scheme-less
   * endpoint, where reading a separator that way would wave the request through
   * with its host never judged. Defaults from `repoPath`, which is non-null
   * exactly when the target was resolved out of a repository's remotes; the one
   * caller that holds a remote url with no repo path (a submodule's own url)
   * says so explicitly. Mirrors the `check` / `check_remote` split in
   * `src-tauri/src/services/security.rs`. */
  targetKind: NetworkTargetKind = repoPath !== null ? 'remote' : 'host',
): Promise<NetworkBlockReason | null> {
  const settings = settingsStore.getState();

  // Nothing is in force, so nothing has to be resolved — the hot path for
  // every push and fetch on a machine with neither setting on.
  if (!settings.offlineMode && settings.remoteAllowlist.length === 0) return null;

  // An allowlist that cannot see the URL must refuse, not wave the operation
  // through: silently allowing is the failure mode that made this setting
  // decorative. Offline mode used to refuse here without resolving anything,
  // which is why it refused a push to a USB disk; it needs the target too, to
  // tell a remote that leaves the machine from one that does not.
  const url =
    resolvedUrl ?? (repoPath ? await resolveRemoteUrl(repoPath, remote) : (remote ?? null));

  // A remote on this machine is neither setting's business. Same carve-out the
  // backend's `check` / `check_remote` make, ahead of the offline branch for
  // the same reason.
  const isLocal = targetKind === 'remote' ? isLocalRemoteTarget : isLocalTarget;
  if (url && isLocal(url)) return null;

  if (settings.offlineMode) {
    if (!silent) {
      showToast('Offline mode is enabled. Disable in Settings > Security.', 'warning');
    }
    return 'offline';
  }

  if (settings.remoteAllowlist.length === 0) return null;
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

/** One remote in a multi-remote gate check: its name, and its URL when the
 * caller already has one to hand. */
export interface NetworkRemoteTarget {
  name?: string;
  url?: string | null;
}

/**
 * Check if a network operation is allowed based on security settings.
 * Returns false if the operation should be blocked.
 */
export async function checkNetworkPermission(
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
  /** See `NetworkTargetKind`. Defaults from `repoPath`, which is non-null
   * exactly when the target came out of a repository's remotes; the callers
   * that hold a remote url with no repo path (clone, a submodule's own url), and
   * the one that holds an ENDPOINT alongside a repo path (LFS), say so. */
  targetKind: NetworkTargetKind = repoPath !== null ? 'remote' : 'host',
): Promise<boolean> {
  for (const target of remotes ?? [{ name: remote, url: resolvedUrl }]) {
    if (await checkNetworkAllowed(repoPath, target.name, false, target.url, targetKind))
      return false;
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
export async function invokeProviderCommand<T>(
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
export function providerApiHost(command: string, args?: Record<string, unknown>): string {
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
 * True when a hard network policy is in force — offline mode, or an allowlist.
 *
 * Callers use this to skip the work of resolving a destination when nothing
 * could refuse it anyway. It deliberately lives here, next to the gate whose
 * settings it reports on: a copy of "which settings count as a policy" kept
 * anywhere else goes stale the moment another one is added, and goes stale
 * fail-OPEN, which is the failure mode this gate exists to avoid.
 */
export function isNetworkPolicyActive(): boolean {
  const settings = settingsStore.getState();
  return settings.offlineMode || settings.remoteAllowlist.length > 0;
}

/**
 * The hard-block gate for an outbound request whose destination host the caller
 * already knows — the AI providers, which reach `api.openai.com` and friends
 * over reqwest exactly as the hosting-provider APIs above do.
 *
 * Exported so `ai.service` applies the same offline-mode and allowlist rules
 * without restating them. A second copy of this logic is precisely how the gate
 * came to cover less than it claimed, twice.
 *
 * `host` may be null when the caller could not determine the destination. Like
 * every other path through the gate, that fails closed once an allowlist is
 * configured — silently allowing is what made the setting decorative.
 *
 * `silent` defaults to true: AI callers render `result.error.message`
 * themselves, and a toast here would double up on it with a vaguer wording.
 *
 * Returns null when allowed, or the reason it was refused.
 */
export async function checkOutboundHostAllowed(
  host: string | null,
  silent = true,
): Promise<NetworkBlockReason | null> {
  return checkNetworkAllowed(null, host ?? undefined, silent);
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
 * Surface a refusal the BACKEND gate made after the frontend gate had let the
 * operation through.
 *
 * The two gates judge the same thing from different vantage points, and the
 * backend can see what the frontend cannot: a cloned submodule's own
 * `remote.origin.url`, a submodule registered in the config but not yet
 * cloned, an LFS endpoint. Every
 * dialog treats a `BLOCKED` result as "the gate already explained itself" and
 * shows nothing — right when the frontend gate refused and toasted, wrong when
 * only the backend did. So a `BLOCKED` reaching here is one the user has not
 * been told about yet, and it is toasted with the backend's own reason.
 */
export function surfaceBackendRefusal<T>(result: CommandResult<T>): CommandResult<T> {
  if (!result.success && result.error?.code === 'BLOCKED' && result.error.message) {
    showToast(result.error.message, 'error');
  }
  return result;
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
export function blockedResult<T>(): CommandResult<T> {
  const declined = lastNetworkBlockReason === 'declined';
  lastNetworkBlockReason = 'offline';
  return {
    success: false,
    error: declined
      ? { code: 'CANCELLED', message: 'Cancelled' }
      : { code: 'BLOCKED', message: 'Operation blocked by security settings' },
  };
}


/**
 * Host of a clone URL. Covers the forms the clone dialog accepts:
 * `https://host/path`, `ssh://git@host/path`, and the scp-like
 * `[user@]host:owner/repo.git` — whose login `scpLikeHost` reads as optional,
 * because git does.
 *
 * Matching on the host — not on a substring of the whole URL, as this used to —
 * keeps a stored token off a look-alike host (`github.com.example.net`) and off
 * a repo whose PATH merely names a provider.
 *
 * The scp branch reads a bracketed IPv6 literal whole. `[^:/]+` stopped at the
 * first colon INSIDE the literal, so `git@[2001:db8::1]:team/app.git` — how a
 * self-hosted box with no DNS is reached — resolved to `[2001`, a host no
 * allowlist entry can name, while the backend gate (`security.rs`,
 * `scp_like_host`) read the whole `[2001:db8::1]` and allowed it. Every fetch,
 * pull and push to that remote was refused HERE, with a message naming a
 * remote the allowlist did name, and no entry could fix it.
 */
export function cloneUrlHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.includes("://")) {
    // `[...]` first: only a colon AFTER the closing bracket separates host
    // from path. The unbracketed alternative refuses a leading `[` so a
    // half-written literal falls through to the caller's `https://` fallback
    // rather than being read as a host that is not one.
    return scpLikeHost(trimmed);
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
export function cloneUrlIsCredentialSafe(url: string): boolean {
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
export function adoUrlOrganization(url: string, host: string): string | undefined {
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
export async function findAdoAccountForOrg(organization: string) {
  const { getAccountsByType } = await import("../../stores/unified-profile.store.ts");
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
export async function findGitLabAccountForHost(host: string) {
  const { getAccountsByType } = await import("../../stores/unified-profile.store.ts");
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
 * `getRepoToken` relies on cannot run here; the URL's host is all we have —
 * unless the caller names the `account` the URL came from. The clone dialog's
 * account picker does: the repository was listed under a specific account, so
 * that account's token is used ahead of any host lookup. The host lookup
 * lands on the host's DEFAULT account, which is the wrong identity the moment
 * a second account for the same provider is connected, and a private clone
 * under the wrong identity fails as "not found".
 *
 * Bitbucket resolves here even though `getRepoToken` still cannot: the backend
 * clone splits a `bbapp:<user>:<app password>` credential back into the
 * username/password pair Bitbucket wants and sends an OAuth access token as
 * `x-token-auth`, so the one token slot carries either kind.
 */
export async function getCloneToken(
  url: string,
  account?: IntegrationAccount | null,
): Promise<string | undefined> {
  const host = cloneUrlHost(url);
  if (!host || !cloneUrlIsCredentialSafe(url)) return undefined;

  try {
    if (account) {
      const { getFreshTokenForAccount } = await import("../credential.service.ts");
      const token = await getFreshTokenForAccount(account);
      if (token) return token;
      // The picked account has no stored credential (or was disconnected in
      // the meantime): fall through to the host lookup rather than clone
      // unauthenticated when another account for the host could still work.
    }

    if (host === "github.com" || host.endsWith(".github.com")) {
      const { getGitHubToken } = await import("./providers.ts");
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
        const { getFreshAccountToken } = await import("../credential.service.ts");
        // Refreshes an expiring Entra OAuth token, so a long-lived session
        // still clones with a valid credential.
        const token = await getFreshAccountToken("azure-devops", adoAccount.id, "azure");
        if (token) return token;
      }
      // Legacy single-token storage, for a user who never created an account.
      // Deliberately not getAdoToken(): that falls back to the default account
      // whatever its organization, which would hand another org's token over.
      const { AzureDevOpsCredentials } = await import("../credential.service.ts");
      const token = await AzureDevOpsCredentials.getToken();
      return token ?? undefined;
    }

    const gitlabAccount = await findGitLabAccountForHost(host);
    if (gitlabAccount) {
      const { getFreshAccountToken } = await import("../credential.service.ts");
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
      const { GitLabCredentials } = await import("../credential.service.ts");
      const token = await GitLabCredentials.getToken();
      if (token) return token;
    }

    if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) {
      const { selectDefaultGlobalAccount } = await import("../../stores/unified-profile.store.ts");
      const {
        getFreshTokenForAccount,
        BitbucketCredentials,
        formatBitbucketAppPasswordCredential,
      } = await import("../credential.service.ts");
      const bitbucketAccount = selectDefaultGlobalAccount("bitbucket");
      if (bitbucketAccount) {
        const token = await getFreshTokenForAccount(bitbucketAccount);
        if (token) return token;
      }
      // Legacy single-credential storage: a username/app-password pair, carried
      // in the same prefixed form the per-account slot uses.
      const legacy = await BitbucketCredentials.getCredentials();
      if (legacy) {
        return formatBitbucketAppPasswordCredential(legacy.username, legacy.password);
      }
    }
  } catch (err) {
    // Same posture as getRepoToken: a credential lookup failure must not stop
    // the clone — it just proceeds unauthenticated, as it does today.
    console.error("Failed to auto-detect clone token:", err);
  }
  return undefined;
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
export async function resolveRepoAccount(
  repoPath: string,
  integrationType: IntegrationType,
  remoteName: string | undefined,
  /** The remote's URL when the caller already resolved it. Saves a second
   * `get_remotes` round trip on paths that walk every remote in the repo. */
  knownRemoteUrl?: string | null,
): Promise<{ account: IntegrationAccount | undefined; repoSpecific: boolean }> {
  const { selectDefaultGlobalAccount } = await import("../../stores/unified-profile.store.ts");
  try {
    // Dynamic import: unified-profile.service.ts statically imports this module,
    // so a static import back would close a runtime cycle.
    const { getAssignedUnifiedProfile, fetchRepositoryPreferredAccount } = await import(
      "../unified-profile.service.ts"
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
export interface ResolvedRepoToken {
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
export async function resolveRepoToken(
  repoPath: string,
  remoteName?: string,
): Promise<ResolvedRepoToken> {
  try {
    // --- Multi-account system (preferred) ---
    const {
      detectGitHubRepo,
      getGitHubToken,
      detectAdoRepo,
      getAdoToken,
      syncAdoGitCredentials,
      detectGitLabRepo,
      getGitLabToken,
    } = await import("./providers.ts");
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
        const { getFreshAccountToken } = await import("../credential.service.ts");
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
        const { getFreshAccountToken } = await import("../credential.service.ts");
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
        const { getFreshAccountToken } = await import("../credential.service.ts");
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
export async function getRepoToken(
  repoPath: string,
  remoteName?: string,
): Promise<string | undefined> {
  return (await resolveRepoToken(repoPath, remoteName)).token;
}

export async function getRemoteToken(
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
export async function fallbackAccountOwnsPushUrl(
  repoPath: string,
  integrationType: IntegrationType,
  accountId: string,
  pushUrl: string,
): Promise<boolean> {
  try {
    // Dynamic import for the same cycle reason as resolveRepoAccount's.
    const { getAssignedUnifiedProfile, fetchRepositoryPreferredAccount } = await import(
      "../unified-profile.service.ts"
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

export async function getPushUrlToken(
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
