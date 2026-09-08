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
 * "remote 'origin' does not exist". The REFUSAL now lives at the point they
 * all converge on, `remote-operations.service`'s runner, which no surface can
 * start one of these operations without. What is left here is what only a
 * surface can do: grey the button out BEFORE the click and say why.
 */

/**
 * A repository as these buttons see it. The store seeds `remotes` as `[]` and
 * the backend returns a Vec, so it is never missing in the app — but this is
 * read inside `render()`, where a throw rejects the whole component update, so
 * a missing collection is tolerated rather than assumed away.
 */
interface RemoteBearing {
  remotes?: readonly unknown[] | null;
}

/** True when the repository has at least one remote configured. */
export function hasConfiguredRemote(repo?: RemoteBearing | null): boolean {
  return (repo?.remotes ?? []).length > 0;
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
