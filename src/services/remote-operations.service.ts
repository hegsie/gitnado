/**
 * The ONE runner behind every fetch, pull and push surface.
 *
 * There were two implementations of these three operations. app-shell's
 * (keyboard shortcuts + command palette) took a per-repo lock, started a
 * progress row and refreshed the repository the operation ran ON.
 * `lv-context-dashboard`'s three buttons — the only route to fetch/pull/push a
 * mouse can reach — did none of the progress bookkeeping and guarded only on
 * component-local `isFetching` / `isPulling` / `isPushing` flags, which no
 * other surface can see. So a slow dashboard push showed nothing but a
 * greyed-out button, and a palette fetch beside a dashboard fetch both reached
 * IPC — where the backend's per-repo registry
 * (src-tauri/src/services/remote_ops.rs) refused the second with "A fetch is
 * already running for this repository", an error the user did nothing to
 * deserve.
 *
 * Everything that used to live in the two copies lives here once: the locks,
 * the progress row, the conflict routing, the failure reporting and the
 * refresh. A surface is now a button that calls `runFetch(repoPath)`.
 *
 * The "has this repository anywhere to go at all?" rule is here too, for the
 * same reason. It was a check each SURFACE made for itself, so it held on the
 * two that render buttons (which can grey them out and say why) and on
 * neither of the three that cannot — the Ctrl+Shift+F/P/U shortcuts, the
 * command palette's three entries and the native Repository menu all ran a
 * fetch on a freshly `git init`ed folder and ended in git's own
 * "remote 'origin' does not exist", one row under a greyed-out Fetch button
 * that had already said the operation was unavailable. A surface can still
 * pre-empt the refusal to disable a button — `remote-availability.ts` holds
 * the rule and its wording for exactly that - but it can no longer LOSE it by
 * forgetting to ask.
 *
 * Deliberately NOT here: the security gate (offline mode, the remote
 * allowlist, the "Allow push to origin?" confirm), the remote resolution that
 * picks the branch's real upstream rather than a hard-coded `origin`, the
 * credential lookup and the network timeout. All four live inside
 * `git.service`'s `fetch`/`pull`/`push`, which is what both surfaces already
 * called, so every caller gets them whether or not it remembers to.
 */

import {
  fetch as gitFetch,
  pull as gitPull,
  push as gitPush,
  isNetworkGateRefusal,
  isOperationCancelled,
} from './git.service.ts';
import { progressService } from './progress.service.ts';
import { showErrorWithSuggestion } from './error-suggestion.service.ts';
import { showToast } from './notification.service.ts';
import { repositoryStore } from '../stores/repository.store.ts';
import { uiStore } from '../stores/ui.store.ts';
import { hasConfiguredRemote, NO_REMOTE_MESSAGE } from '../utils/remote-availability.ts';
import {
  tryAcquirePush,
  releasePush,
  isPushRunning,
  tryAcquireRefOp,
  releaseRefOp,
  warnRepositoryBusy,
} from '../utils/ref-lock.ts';
import type { CommandResult } from '../types/api.types.ts';

/** The three operations that share one per-repository slot. */
export type RemoteOperationKind = 'fetch' | 'pull' | 'push';

export interface RemoteOperationOptions {
  /**
   * Say so with a toast when the repository is busy, instead of returning
   * silently.
   *
   * Defaults to true for pull and push, whose surfaces are single clicks and
   * shortcuts a user presses once; false for fetch, because `keyboardService`
   * has no `e.repeat` guard, so HOLDING Ctrl+Shift+F fires many times a
   * second and one toast per repeat is the noise this lock exists to remove.
   */
  warnWhenBusy?: boolean;
}

const PROGRESS_MESSAGE: Record<RemoteOperationKind, string> = {
  fetch: 'Fetching from remote...',
  pull: 'Pulling from remote...',
  push: 'Pushing to remote...',
};

const FAILURE_FALLBACK: Record<RemoteOperationKind, string> = {
  fetch: 'Fetch failed',
  pull: 'Pull failed',
  push: 'Push failed',
};

/**
 * What a cancel that really took effect says, per operation.
 *
 * A cancelled pull is worth spelling out: the backend only aborts during the
 * fetch phase and refuses to begin a merge it cannot stop halfway, so nothing
 * was merged and the repository is exactly where a plain Fetch would have left
 * it. See commands/remote.rs::pull_branch.
 */
const CANCELLED_MESSAGE: Record<RemoteOperationKind, string> = {
  fetch: 'Fetch cancelled',
  pull: 'Pull cancelled',
  push: 'Push cancelled',
};

/**
 * The slot fetch, pull and push share, per repository.
 *
 * One slot for all three, mirroring `RemoteOpRegistry` in the backend: they
 * are not independent — a pull moves HEAD under a push that is reading refs,
 * and a pruning fetch rewrites the very remote-tracking refs a pull just
 * resolved. The frontend used THREE disjoint keys (`fetch:<repo>`, the
 * working-tree lock for pull, the push slot for push), so any two different
 * operations sailed past each other here and collided in the backend instead.
 *
 * Held on the push-slot set rather than a fourth registry so every existing
 * `?disabled` binding re-renders on it (the set notifies `subscribeRefOps`
 * listeners on claim and release) and so `resetRefOpLocks()` still clears
 * everything a test claimed.
 */
export function remoteSlotKey(repoPath: string): string {
  return `remote:${repoPath}`;
}

/** Which operation holds `repoPath`'s remote slot, if any. */
const runningByRepo = new Map<string, RemoteOperationKind>();

/**
 * The fetch/pull/push running against `repoPath`, from ANY surface.
 *
 * Drives both halves of a button: the spinner on the one operation that is
 * running, and the disabled state on all three. A dashboard button must show
 * the operation a keyboard shortcut started, or the two surfaces disagree
 * about what the app is doing.
 */
export function runningRemoteOperation(
  repoPath: string | undefined,
): RemoteOperationKind | undefined {
  // Gated on the lock rather than read from the map alone: `resetRefOpLocks()`
  // is the test seam that drops every claim, and a kind left behind here would
  // outlive it and disable buttons in the next test.
  if (repoPath === undefined || !isPushRunning(remoteSlotKey(repoPath))) return undefined;
  return runningByRepo.get(repoPath);
}

/** True while a fetch, pull or push is running against `repoPath`. */
export function isRemoteOperationRunning(repoPath: string | undefined): boolean {
  return runningRemoteOperation(repoPath) !== undefined;
}

/** A claim on every lock an operation needs, released in one call. */
interface RemoteClaim {
  release(): void;
}

/**
 * Claim the locks `kind` needs, or nothing at all.
 *
 * The extra locks beyond the shared slot are the ones the two implementations
 * already held, and they are kept for the reasons they were added:
 *
 * - pull takes the SHARED WORKING-TREE lock, because its fast-forward runs
 *   checkout_tree and its merge and rebase paths rewrite the tree outright, so
 *   it must exclude every sidebar checkout, discard and reset — not just other
 *   pulls.
 * - push takes the push slot keyed on the repo, which is what makes Push and
 *   Force Push mutually exclusive: app-shell holds that slot across the "this
 *   replaces <branch> on the remote" confirm precisely so a plain push cannot
 *   race the force push the user is authorising.
 * - fetch takes NEITHER: it touches no working tree, so it must not block a
 *   checkout.
 */
function claimLocks(
  kind: RemoteOperationKind,
  repoPath: string,
  warnWhenBusy: boolean,
): RemoteClaim | null {
  const released: Array<() => void> = [];
  const releaseAll = (): void => {
    // Reverse acquisition order, and used by BOTH the refusal path and the
    // finally: a claim that got the shared slot but not the push slot must not
    // walk away holding the shared one, which would wedge the repository for
    // the rest of the session.
    for (const release of [...released].reverse()) release();
  };
  const refuse = (): null => {
    releaseAll();
    if (warnWhenBusy) warnRepositoryBusy();
    return null;
  };

  const slot = remoteSlotKey(repoPath);
  if (!tryAcquirePush(slot)) return refuse();
  released.push(() => releasePush(slot));

  if (kind === 'pull' && !tryAcquireRefOp(repoPath)) return refuse();
  if (kind === 'pull') released.push(() => releaseRefOp(repoPath));

  if (kind === 'push' && !tryAcquirePush(repoPath)) return refuse();
  if (kind === 'push') released.push(() => releasePush(repoPath));

  runningByRepo.set(repoPath, kind);
  return {
    release: () => {
      runningByRepo.delete(repoPath);
      releaseAll();
    },
  };
}

/**
 * Refuse an operation on a repository that has nowhere to send it.
 *
 * Read from the repository STORE, keyed by the path the operation runs on —
 * not from whichever surface asked and not from the active tab: `handlePull`
 * carries a pinned path from the push-rejection suggestion toast, and every
 * one of these operations can outlive a tab switch.
 *
 * A path that is not open is left alone. Nothing is known about the remotes of
 * a repository the app has not loaded, and refusing on an absence would turn
 * "not loaded yet" into "no remote" — so the rule is only ever applied to a
 * repository whose remotes have actually been read.
 *
 * Returns true when the operation must not start; the caller has already been
 * told why.
 */
function refuseWithoutRemote(repoPath: string): boolean {
  const repo = repositoryStore
    .getState()
    .openRepositories.find((r) => r.repository.path === repoPath);
  if (!repo || hasConfiguredRemote(repo)) return false;

  // One toast per burst, not one per key repeat: `keyboardService` has no
  // `e.repeat` guard, so HOLDING Ctrl+Shift+F asks many times a second and
  // every ask is refused (unlike the busy case, where the first one wins the
  // lock). While the refusal is still on screen, saying it again adds nothing.
  const showing = uiStore.getState().toasts.some((t) => t.message === NO_REMOTE_MESSAGE);
  if (!showing) showToast(NO_REMOTE_MESSAGE, 'warning');
  return true;
}

/**
 * Ask for a refresh of the repository an operation just landed on.
 *
 * A window event pinned to the repository, not a call back into whichever
 * surface started the operation: these are slow network calls and the user can
 * switch tabs while one runs, so the refresh must name the repo that fetched
 * rather than the tab that happens to be active when the call returns.
 * app-shell is the single listener, and it answers with the same
 * `refreshConflictDialogRepo(repoPath)` its own copies of these handlers
 * called directly — a full `handleRefresh()` (repository store + graph +
 * search index + the `repository-refresh` broadcast that updates the branch
 * list and the dashboard's own ahead/behind badges) while that repo is still
 * active, and a stale-mark plus badge hydration when it is not.
 *
 * Its own event rather than dispatching `repository-refresh` here directly:
 * that one is a BROADCAST every panel listens to, so raising it would refresh
 * them once for this event and a second time for the one `handleRefresh`
 * itself emits. Not to be confused with the BACKEND's
 * `remote-operation-completed`, which is the Tauri event that toasts the
 * success message.
 */
function notifyRepositoryRefreshed(repoPath: string): void {
  window.dispatchEvent(new CustomEvent('remote-operation-refresh', { detail: { repoPath } }));
}

/**
 * A pull that LANDED and left conflicts behind.
 *
 * Not a failure from the user's side: MERGE_HEAD (or the rebase state) is on
 * disk and the only way out is the conflict dialog's Complete/Abort, so a red
 * "Pull failed" here reads as "nothing happened" and strands the repository
 * mid-merge.
 *
 * `merge-conflict` is bound on the app-shell ELEMENT, not on window, so it is
 * dispatched there — the same lookup, and the same fallback, that
 * git.service's late-pull path already uses. The handler pins the dialog to
 * `repositoryPath` and refreshes that repo, so no extra refresh here.
 */
function openConflictResolution(repoPath: string, operationType: 'merge' | 'rebase'): void {
  showToast(
    `Pull produced conflicts — resolve them to finish the ${operationType}`,
    'warning',
  );
  const shell = document.querySelector('lv-app-shell');
  if (shell) {
    shell.dispatchEvent(
      new CustomEvent('merge-conflict', {
        detail: { repositoryPath: repoPath, operationType },
      }),
    );
    return;
  }
  // No shell to open the dialog (a component test, a surface mounted on its
  // own). Refresh at least, so the conflicted state is visible rather than
  // invisible.
  notifyRepositoryRefreshed(repoPath);
}

/**
 * Hand the operation to `git.service`, carrying the progress row's id.
 *
 * `operationId` is what makes cancellation real: the backend registers it with
 * `CancellationRegistry`, checks the token inside git2's transfer callbacks,
 * and addresses its `operation-progress` events (received/total objects and
 * bytes) back to this exact row. A call without it is uncancellable and shows
 * an indeterminate stripe, which is what every one of these three surfaces did
 * before — so the runner always passes it.
 *
 * `silent: true` on all three: this runner owns the messaging, and the backend
 * emits `remote-operation-completed` on success — which
 * setupRemoteOperationListeners toasts, naming the remote. Without it every
 * click stacked two toasts, and every failure two errors.
 */
function invokeOperation(
  kind: RemoteOperationKind,
  repoPath: string,
  operationId: string,
): Promise<CommandResult<void>> {
  if (kind === 'fetch') return gitFetch({ path: repoPath, silent: true, operationId });
  if (kind === 'pull') return gitPull({ path: repoPath, silent: true, operationId });
  return gitPush({ path: repoPath, silent: true, operationId });
}

/**
 * Run one remote operation, end to end.
 *
 * Resolves when the operation has finished and its locks are released, so a
 * caller can await it; it never rejects — `git.service` returns a
 * `CommandResult` and `invokeCommand` never throws, which is why the
 * catch-only versions of these handlers used to report every failure as a
 * success.
 */
async function runRemoteOperation(
  kind: RemoteOperationKind,
  repoPath: string,
  options?: RemoteOperationOptions,
): Promise<void> {
  // Before the locks and before the progress row: a repository with no remote
  // must not get a cancellable "Fetching from remote..." row that can only end
  // in git's own error.
  if (refuseWithoutRemote(repoPath)) return;

  const claim = claimLocks(kind, repoPath, options?.warnWhenBusy ?? kind !== 'fetch');
  // Coalesced, not queued: the second gesture is a user action that already
  // has a spinner on screen for the first one, and silently waiting behind a
  // push to an unreachable remote is indistinguishable from a hang. This is
  // the same choice the backend registry documents.
  if (!claim) return;

  // `cancellable: true` is what puts the Cancel button on the row; without it
  // the button is unreachable dead code and the operation cannot be stopped.
  // Every surface gets it, so a fetch a keyboard shortcut started is as
  // cancellable as one a dashboard button started.
  const opId = progressService.startOperation(kind, PROGRESS_MESSAGE[kind], {
    cancellable: true,
  });
  try {
    const result = await invokeOperation(kind, repoPath, opId);
    if (result.success) {
      progressService.completeOperation(opId);
      notifyRepositoryRefreshed(repoPath);
      return;
    }

    progressService.failOperation(opId);

    const code = result.error?.code;
    if (kind === 'pull' && (code === 'MERGE_CONFLICT' || code === 'REBASE_CONFLICT')) {
      openConflictResolution(repoPath, code === 'REBASE_CONFLICT' ? 'rebase' : 'merge');
      return;
    }

    // A cancel the user asked for is not a failure — say it took effect rather
    // than showing them a red error for their own click. Kept separate from
    // isNetworkGateRefusal, which means the operation never started and has
    // already announced itself: this one has to be acknowledged, or the row
    // simply vanishes with no explanation.
    if (isOperationCancelled(result.error)) {
      showToast(CANCELLED_MESSAGE[kind], 'info');
      return;
    }

    // A security-gate refusal already announced itself, and a declined confirm
    // is the user's own decision — reporting either as a red error tells them
    // their own click failed.
    if (isNetworkGateRefusal(result.error)) return;

    // Through the suggestion service so a non-fast-forward rejection offers the
    // Pull Now action the app already implements and an auth failure offers
    // Open Settings. It falls back to the plain error toast when no suggestion
    // matches, so nothing is ever silent.
    showErrorWithSuggestion(result.error?.message ?? '', FAILURE_FALLBACK[kind], {
      operation: kind,
      repoPath,
    });
  } finally {
    // Belt and braces, and idempotent (both complete and fail just remove the
    // row): a throw between startOperation and the branches above would
    // otherwise leave the row spinning forever with a Cancel button attached to
    // an operation that is no longer running.
    progressService.completeOperation(opId);
    claim.release();
  }
}

/** Fetch `repoPath` from its resolved remote. */
export function runFetch(repoPath: string, options?: RemoteOperationOptions): Promise<void> {
  return runRemoteOperation('fetch', repoPath, options);
}

/** Pull `repoPath` from its upstream. */
export function runPull(repoPath: string, options?: RemoteOperationOptions): Promise<void> {
  return runRemoteOperation('pull', repoPath, options);
}

/** Push `repoPath` to its resolved push remote. */
export function runPush(repoPath: string, options?: RemoteOperationOptions): Promise<void> {
  return runRemoteOperation('push', repoPath, options);
}
