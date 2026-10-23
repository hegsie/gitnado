import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { showToast } from '../services/notification.service.ts';

/**
 * The working-tree lock for ref operations, shared across every surface.
 *
 * Two disjoint locks used to guard the same commands: app-shell held
 * `refOperationsInFlight` for the graph ref menu, the commit context menu and
 * the command palette, while `gn-branch-list`, `gn-tag-list` and
 * `gn-stash-list` each held their own component-local `operationInProgress`.
 * Nothing passed a busy signal between them — `<gn-left-panel>` is rendered
 * with no props at all — so a hard reset started from the graph and a
 * double-clicked sidebar checkout ran concurrently against the same working
 * tree. There is no per-repo lock in the backend (every command opens its own
 * git2 handle), and the backend's own state guards only refuse when the repo
 * is mid-merge/rebase — two operations on a Clean repo are not caught. The
 * auto-stash checkout is the worst case: it saves, applies and drops by
 * position, so a concurrent reset lands on the just-applied tree with the
 * stash entry already gone.
 *
 * This is the same hoist `maintenance-confirms.ts` already did for gc/prune,
 * and it is keyed by repository path for the same reason: separate repos have
 * separate working trees and nothing to serialize against each other.
 */
const refOpsInFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * The one refusal message every busy-repo path shows.
 *
 * app-shell's runRefExclusive/runExclusive report the refusal themselves. The
 * sidebar components hold this same lock through their own claimOperation
 * helpers and returned silently, so a gesture with no disabled binding — a
 * double-clicked branch row — looked like a hung app for the whole duration
 * of the other operation.
 */
export function warnRepositoryBusy(): void {
  void showToast('Another operation is already running in this repository.', 'warning');
}

/** Claim the slot and report the refusal, for callers with no disabled state. */
export function tryAcquireRefOpOrWarn(repoPath: string): boolean {
  if (tryAcquireRefOp(repoPath)) return true;
  warnRepositoryBusy();
  return false;
}

/** Claim the ref-operation slot for a repo. False when one is already running. */
export function tryAcquireRefOp(repoPath: string): boolean {
  if (refOpsInFlight.has(repoPath)) return false;
  refOpsInFlight.add(repoPath);
  notify();
  return true;
}

/** Release the slot. Safe to call for a repo that never held one. */
export function releaseRefOp(repoPath: string): void {
  if (refOpsInFlight.delete(repoPath)) notify();
}

/** True while a ref operation is running against `repoPath`. */
export function isRefOpRunning(repoPath: string | undefined): boolean {
  return repoPath !== undefined && refOpsInFlight.has(repoPath);
}

/**
 * Re-render on every claim and release.
 *
 * Components bind `?disabled` to `isRefOpRunning`, which is plain module state
 * Lit cannot observe. Returns the unsubscribe function for
 * `disconnectedCallback`.
 */
export function subscribeRefOps(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Re-run the subscribers without changing the lock.
 *
 * The maintenance lock gates the same buttons but does not always touch
 * refOpsInFlight — the read-only fsck claim deliberately does not — so its
 * transitions would otherwise never reach the components bound to them.
 */
export function notifyRefOpListeners(): void {
  notify();
}

/** Test seam: drop all claims and listeners. */
export function resetRefOpLocks(): void {
  refOpsInFlight.clear();
  pushInFlight.clear();
  listeners.clear();
}

/**
 * Observe the working-tree lock from a component, in one line.
 *
 * Claiming the lock and OBSERVING it are separate halves, and only the claim
 * kept getting applied. A component that claims but never subscribes still
 * refuses correctly — but its buttons stay lit through the other operation and
 * do nothing except raise a refusal toast, which is the dead control this
 * whole mechanism exists to remove. Six dialogs were in that state, and the
 * hand-rolled version of the observation half (a refOpsVersion field, a
 * subscription in connectedCallback, teardown in disconnectedCallback, a
 * getter) had already been mis-applied once by a scripted edit that silently
 * skipped three files.
 *
 * A reactive controller removes the boilerplate — and with it the chance to
 * apply only part of it:
 *
 *   private lock = new RefLockController(this, () => this.pinnedRepoPath);
 *   ...
 *   ?disabled=${this.deleting || this.lock.busy}
 *
 * Bind it ONLY to the controls that START a git operation. Cancel/Close and
 * plain form inputs must stay live: `busy` reflects ANY operation anywhere in
 * the repo, so gating them greys out the most obvious way to leave a dialog —
 * or freezes a textarea mid-keystroke — for a reason that has nothing to do
 * with the dialog. gn-clean-dialog and gn-repository-health-dialog already
 * carry that decision in comments; applying the controller uniformly to every
 * binding in a footer walked straight back into it.
 */
export class RefLockController implements ReactiveController {
  private unsubscribe?: () => void;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly repoPath: () => string | undefined,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = subscribeRefOps(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** True while any operation holds this repo's working tree. */
  get busy(): boolean {
    return isRefOpRunning(this.repoPath());
  }
}

/**
 * The push slot, per repository — separate from the working-tree lock.
 *
 * A push does not touch the working tree, so it must not block a checkout; but
 * two pushes to the same branch must not overlap, and Push and Force Push in
 * particular must be mutually exclusive: a plain push launched while the
 * "this replaces <branch> on the remote" confirm is still up races the force
 * push it is about to authorise. app-shell enforced that with a
 * component-local `destructiveActionsInFlight` keyed `push:<repo>`, which the
 * context dashboard's own Push button — a fourth push surface, in a directory
 * no sweep had reached — could not see. Hoisted here for the same reason the
 * working-tree lock was.
 */
const pushInFlight = new Set<string>();

/**
 * The key for a TAG push, so Push Tag and Force Push Tag exclude each other.
 *
 * Scoped to the tag rather than the repo: pushing two different tags, or a tag
 * and a branch, are independent, and a repo-wide key would block them for no
 * reason. The pairing that matters is the one the branch slot already has —
 * app-shell holds the slot across the "this moves the remote tag" confirm, so
 * a plain push of the SAME tag from the sidebar or the graph ref menu cannot
 * race the force push the user is authorising. Force Push Tag used to hold a
 * key private to app-shell that neither of those two surfaces could see.
 */
export function pushTagKey(repoPath: string, tagName: string): string {
  return `${repoPath}\u0000tag:${tagName}`;
}

/** Claim the push slot for a key. False when a push already holds it. */
export function tryAcquirePush(key: string): boolean {
  if (pushInFlight.has(key)) return false;
  pushInFlight.add(key);
  notify();
  return true;
}

/** Release the push slot. Safe for a key that never held one. */
export function releasePush(key: string): void {
  if (pushInFlight.delete(key)) notify();
}

/** True while a push or force push holds `key` (a repo path, or a tag key). */
export function isPushRunning(key: string | undefined): boolean {
  return key !== undefined && pushInFlight.has(key);
}
