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

import { dialogs } from '../stores/dialog.store.ts';
import type { ToastAction } from '../stores/ui.store.ts';

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

/**
 * What a refused fetch, pull or push says, wherever it was asked for.
 *
 * On a button surface this is only reachable in the race window between a
 * render and the click (they carry `?disabled`), where a silent return would
 * look like a dead button. The keyboard, the command palette and the native
 * menu have no disabled state at all, so for them it is the whole answer —
 * which is why the runner shows it rather than each surface remembering to.
 */
export const NO_REMOTE_MESSAGE = 'No remote configured for this repository — add one first.';

/**
 * The remedy the message names, as something the user can actually press.
 *
 * "add one first" was a dead end for anyone who does not already know the
 * command palette carries "Manage remotes": the Remotes dialog is now in the
 * native Repository menu too, but the toast is where the user IS when they are
 * told to add a remote, so it carries the route as well.
 *
 * The dialog is bound to the ACTIVE repository, so a refusal pinned to some
 * other repository (a pull suggested for the repo a push was rejected from,
 * say) must not offer it — it would open the wrong repository's remotes.
 */
export function addRemoteToastAction(): ToastAction {
  return {
    label: 'Add a remote…',
    callback: () => {
      dialogs.open('remotes');
    },
  };
}
