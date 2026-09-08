/**
 * Whether a repository has anywhere to fetch, pull or push TO — and what to
 * say when it has not.
 *
 * Two surfaces render the same three remote buttons at the same time: the
 * toolbar and the context dashboard, both on screen whenever a repository is
 * open (app-shell renders them one above the other). The toolbar disabled its
 * three for a repository with no remote and said why; the dashboard's
 * identical copies stayed enabled, started a cancellable progress row and
 * landed a red toast carrying git's own wording. That is exactly the
 * disagreement the shared in-flight slot exists to prevent, one field over.
 *
 * So the rule AND its wording live here, in one place every surface calls, and
 * the two cannot end up phrasing the same refusal differently.
 *
 * Calling it is no longer left to the surface, though. Sharing the rule was
 * not enough: it was wired into the two surfaces that render buttons and into
 * none of the three that cannot — the Ctrl+Shift+F/P/U shortcuts, the command
 * palette and the native Repository menu, which converge on app-shell's
 * handleFetch/handlePull/handlePush and ran straight into git's own
 * "remote 'origin' does not exist". The REFUSAL now lives at the point all
 * FIVE of those converge on, `remote-operations.service`'s runner. What is
 * left here is what only a surface can do: grey the button out BEFORE the
 * click and say why.
 *
 * The runner is not, however, the only way into git's fetch and pull. The
 * workspace manager's Fetch All / Pull All loops call `git.service` per
 * repository directly — deliberately, because they are a batch over
 * repositories that are not open in a tab, with their own summary instead of a
 * toast per repo — so they cannot inherit this refusal and ask for it
 * themselves (`hasConfiguredRemote` over the remotes they read per repo), and
 * account for the repositories they skipped in that summary. Any new caller of
 * `git.service`'s fetch/pull/push that is not the runner has to do the same.
 */

import { showToast } from '../services/notification.service.ts';
import { dialogs } from '../stores/dialog.store.ts';
import { repositoryStore } from '../stores/repository.store.ts';
import { uiStore, type ToastAction } from '../stores/ui.store.ts';

/**
 * A repository as these buttons see it.
 *
 * `remotes` is read inside `render()`, where a throw rejects the whole
 * component update, so a missing collection is tolerated rather than assumed
 * away — even though the store seeds it and the backend returns a Vec.
 *
 * `remotesLoaded` is what separates the seed from an answer: see
 * `knownToHaveNoRemote`.
 */
interface RemoteBearing {
  remotes?: readonly unknown[] | null;
  remotesLoaded?: boolean;
}

/** True when the repository has at least one remote configured. */
export function hasConfiguredRemote(repo?: RemoteBearing | null): boolean {
  return (repo?.remotes ?? []).length > 0;
}

/**
 * True only when this repository's remotes have been READ and there are none.
 *
 * The distinction is the whole point. `remotes: []` is also what a tab holds
 * in the moment between being opened and `get_remotes` answering, so a rule
 * written as "no remotes in the store" told every freshly opened or cloned
 * repository it had no remote — greying out its three buttons and refusing its
 * shortcuts — until that round trip landed. The same rule the runner already
 * applies to a path that is not open at all: nothing known is not the same as
 * nothing there.
 */
export function knownToHaveNoRemote(repo?: RemoteBearing | null): boolean {
  if (!repo || repo.remotesLoaded !== true) return false;
  return !hasConfiguredRemote(repo);
}

/**
 * The tooltip (and, where the button is icon-only, the `aria-label`) for a
 * remote button that has nowhere to go. `action` is the button's own name —
 * "Fetch", "Pull", "Push".
 */
export function noRemoteButtonLabel(action: string): string {
  return `${action} — this repository has no remote configured`;
}

/** Last path segment, so a message names the repository the user knows. */
function repositoryLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * The repository as the user names it: the name its tab carries while it is
 * open, and its folder once it is not — a bare path in a toast is unreadable.
 */
function repositoryName(repoPath: string): string {
  const open = repositoryStore
    .getState()
    .openRepositories.find((r) => r.repository.path === repoPath);
  return open?.repository.name ?? repositoryLabel(repoPath);
}

/**
 * What a refused fetch, pull or push says, wherever it was asked for.
 *
 * On a button surface this is only reachable in the race window between a
 * render and the click (they carry `?disabled`), where a silent return would
 * look like a dead button. The keyboard, the command palette and the native
 * menu have no disabled state at all, so for them it is the whole answer —
 * which is why the runner shows it rather than each surface remembering to.
 *
 * It NAMES the repository. Not decoration: this refusal carries a remedy
 * pinned to one repository (`addRemoteToastAction`) and lives five seconds,
 * so two of them can be on screen at once — one per repository the user
 * refused on. "this repository" left the two indistinguishable, and left the
 * user to guess which of the two "Add a remote…" buttons belonged to which.
 */
export function noRemoteMessage(repoPath: string): string {
  return `No remote configured for ${repositoryName(repoPath)} — add one first.`;
}

/**
 * The remedy the message names, as something the user can actually press.
 *
 * "add one first" was a dead end for anyone who does not already know the
 * command palette carries "Manage remotes": the Remotes dialog is now in the
 * native Repository menu too, but the toast is where the user IS when they are
 * told to add a remote, so it carries the route as well.
 *
 * `repoPath` is the repository the refusal was ABOUT, and the check that it is
 * still the active one is re-made HERE, when the button is pressed — not once,
 * where the toast is built. The dialog is bound to whatever app-shell has
 * active at render time, and this toast lives five seconds: deciding at
 * creation time that the repository was active left two ways to open the wrong
 * one. Open a second repository while the toast is up and the button opened
 * THAT repository's remotes; close the last tab while it is up and the button
 * armed a repo-scoped dialog with nothing to bind to, which then sprang up
 * over the next repository opened (the failure `DIALOG_REGISTRY` describes).
 *
 * Neither case returns in silence — the user pressed a button and is owed an
 * answer, so it says which repository the remedy belongs to.
 */
export function addRemoteToastAction(repoPath: string): ToastAction {
  return {
    label: 'Add a remote…',
    callback: () => {
      const state = repositoryStore.getState();
      if (state.getActiveRepository()?.repository.path === repoPath) {
        dialogs.open('remotes');
        return;
      }
      const stillOpen = state.openRepositories.some((r) => r.repository.path === repoPath);
      const name = repositoryName(repoPath);
      showToast(
        stillOpen
          ? `Switch to ${name} to add its remote.`
          : `${name} is no longer open — reopen it to add a remote.`,
        'warning',
      );
    },
  };
}

/**
 * The refusal each repository currently has ON SCREEN — its toast's id, and
 * whether that toast carries the remedy. Pruned on every call against the
 * toasts the store still holds, so it can hold at most one entry per toast.
 */
const refusalsOnScreen = new Map<string, { toastId: string; hasRemedy: boolean }>();

/**
 * Say the refusal, once per repository, with the remedy where it can be
 * offered.
 *
 * Every surface that refuses says it through here, so the wording, the
 * de-duplication and the decision to offer the remedy cannot drift apart the
 * way the rule itself once did. The runner had all three; the toolbar's and
 * the dashboard's copies of the same message had only the wording.
 *
 * One toast per burst, not one per ask: `keyboardService` has no `e.repeat`
 * guard, so HOLDING Ctrl+Shift+F asks many times a second and every ask is
 * refused (unlike the busy case, where the first one wins the lock). While the
 * refusal is still on screen, saying it again adds nothing — and that is as
 * true of the three buttons, whose identical message would stack up to three
 * deep in the render/click race window.
 *
 * Per REPOSITORY, though, and keyed by the toast this repository actually has
 * on screen rather than by the words in it. The two halves of this function
 * pull in opposite directions otherwise: the message is one sentence every
 * repository shares, while the remedy above is pinned to ONE. Keyed on the
 * message, a refusal on the repository the user just switched TO was
 * discarded as a repeat of the one still showing for the repository they
 * switched FROM — and the button left on screen led to that other repository.
 * Two repositories can also share a folder name, so the text cannot be the
 * key even now that it names one.
 *
 * The remedy is only offered when the refused repository IS the active one:
 * `handlePull` can carry a path pinned from a push-rejection suggestion, and a
 * button that cannot lead anywhere useful is worse than no button at all.
 * Whether it still leads anywhere is re-checked when it is pressed — see
 * `addRemoteToastAction`. A standing refusal that was raised WITHOUT the
 * remedy is replaced rather than repeated once that repository becomes the
 * active tab: the ask is a fresh gesture, and answering it with a toast that
 * cannot offer the remedy leaves the user where "add one first" left them.
 */
export function showNoRemoteToast(repoPath: string): void {
  // Anything the toast container has since dismissed — by timeout or by the
  // user — is no longer a refusal on screen, and must not silence the next
  // gesture.
  const live = new Set(uiStore.getState().toasts.map((t) => t.id));
  for (const [path, refusal] of refusalsOnScreen) {
    if (!live.has(refusal.toastId)) refusalsOnScreen.delete(path);
  }

  const isActive = repositoryStore.getState().getActiveRepository()?.repository.path === repoPath;
  const standing = refusalsOnScreen.get(repoPath);
  if (standing) {
    if (standing.hasRemedy || !isActive) return;
    uiStore.getState().removeToast(standing.toastId);
    refusalsOnScreen.delete(repoPath);
  }

  showToast(
    noRemoteMessage(repoPath),
    'warning',
    5000,
    isActive ? addRemoteToastAction(repoPath) : undefined,
  );
  // `addToast` mints the id, so the toast just added is the one the store did
  // not have a moment ago — found by id rather than by position, so nothing
  // depends on where it lands in the list.
  const added = uiStore.getState().toasts.find((t) => !live.has(t.id));
  if (added) refusalsOnScreen.set(repoPath, { toastId: added.id, hasRemedy: isActive });
}
