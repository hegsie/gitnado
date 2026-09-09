/**
 * Ordering and reporting for actions that run over a graph multi-selection.
 *
 * The graph builds its selection from a `Set` filled in CLICK order, so a user
 * who ctrl+clicks a child before its parent hands us a list that would replay
 * the history backwards. Every batch action here is order-sensitive — a
 * cherry-pick sequence applied newest-first fails or produces a different tree
 * — so the order is derived from the loaded commit list (the graph's own
 * newest-first walk), never from the order the user happened to click.
 */

import type { Commit } from '../types/git.types.ts';

/**
 * Put a selection into ancestor→descendant order, using the graph's loaded
 * commit list as the authority.
 *
 * `loaded` is the graph's walk, newest first, so reversing its ranks gives the
 * order git itself would apply the commits in. Commits that are no longer in
 * the loaded list are DROPPED: a graph reload can rewrite history away under a
 * standing selection, and applying "the rest" while a menu label promised N
 * commits is worse than acting on the ones that are still real. Callers build
 * both the label and the work from this same list, so the count a user reads
 * always matches the commits that will be touched.
 */
export function orderCommitsForApply(
  selected: readonly Commit[],
  loaded: readonly Commit[],
): Commit[] {
  const rank = new Map<string, number>();
  loaded.forEach((commit, index) => {
    // First occurrence wins — a duplicated oid in the walk must not move the
    // commit's rank.
    if (!rank.has(commit.oid)) rank.set(commit.oid, index);
  });

  const seen = new Set<string>();
  const known: Commit[] = [];
  for (const commit of selected) {
    if (!rank.has(commit.oid) || seen.has(commit.oid)) continue;
    seen.add(commit.oid);
    known.push(commit);
  }

  // Higher rank = further down the newest-first walk = older, so descending
  // rank is ancestor→descendant.
  return known.sort((a, b) => (rank.get(b.oid) ?? 0) - (rank.get(a.oid) ?? 0));
}

/**
 * `abc1234 Fix the thing` — the one shape every list in these messages uses.
 *
 * The summary is capped: these strings go into a native confirm and into
 * `<option>` labels, neither of which wraps, so one commit with a 200-column
 * subject would push the rest of the list off the side.
 */
export function shortCommitLabel(commit: Commit, maxSummary = 60): string {
  const short = commit.shortId || commit.oid.substring(0, 7);
  const summary =
    commit.summary.length > maxSummary
      ? `${commit.summary.substring(0, maxSummary - 1).trimEnd()}…`
      : commit.summary;
  return `${short} ${summary}`;
}

/** A numbered, one-per-line rendering of an ordered commit list. */
export function numberedCommitList(commits: readonly Commit[]): string {
  return commits.map((commit, i) => `${i + 1}. ${shortCommitLabel(commit)}`).join('\n');
}

/**
 * The confirm body for a multi-commit cherry-pick.
 *
 * It names the ORDER, because that order is the whole reason this flow exists
 * and it is not the order the user clicked in.
 */
export function cherryPickConfirmMessage(commits: readonly Commit[], branch: string): string {
  return (
    `Cherry-pick ${commits.length} commits onto ${branch}, oldest first:\n\n` +
    `${numberedCommitList(commits)}\n\n` +
    'They are applied one at a time. If one conflicts or fails, the ' +
    'sequence stops there and the remaining commits are left alone.'
  );
}

/**
 * "2 of 5 applied, here is exactly where it stopped and what is left."
 *
 * A batch that dies halfway is the one case where a bare error message is
 * useless: the repository is now in a state the user did not ask for, and the
 * only way to finish the job is to know which commits still need applying.
 */
export function cherryPickFailureMessage(
  applied: readonly Commit[],
  notApplied: readonly Commit[],
  total: number,
  reason: string,
): string {
  const [failed, ...rest] = notApplied;
  const head =
    applied.length === 0
      ? `Cherry-pick stopped on the first of ${total} commits`
      : `Cherry-picked ${applied.length} of ${total} commits, then stopped`;
  const at = failed ? ` at ${shortCommitLabel(failed)}` : '';
  const because = reason ? `: ${reason}` : '';
  const remaining =
    rest.length > 0
      ? ` Still to apply after it: ${rest.map((c) => c.shortId || c.oid.substring(0, 7)).join(', ')}.`
      : ' It was the last one in the sequence.';
  return `${head}${at}${because}.${remaining}`;
}
