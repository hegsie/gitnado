/**
 * The merge confirm's prediction, shared by every surface that starts a merge.
 *
 * A merge used to be confirmed with nothing but "Merge X into the current
 * branch?" — the user learned it would conflict only once the working tree was
 * already conflicted and the conflict-resolution flow had taken over. The
 * backend can answer the question first: `preview_merge` merges the two trees
 * in memory (no checkout, no index, no worktree, nothing to clean up) and
 * reports whether the merge fast-forwards, records a merge commit, or
 * conflicts — and in which files.
 *
 * Worded once, here, rather than per surface, for the same reason
 * `maintenance-confirms.ts` and `restore-file.ts` share theirs: the branch
 * context menu, the drag-to-merge drop and the graph's ref menu all confirm the
 * same operation and must not drift apart.
 *
 * The prediction NEVER blocks the merge. A user may deliberately merge into a
 * conflict to resolve it; the point is that they choose to.
 */

import * as gitService from '../services/git.service.ts';
import type { MergePreview } from '../services/git.service.ts';
import { loggers } from './logger.ts';

/** How many conflicting paths the confirm lists before it summarises the rest. */
export const MERGE_PREVIEW_LISTED_PATHS = 8;

/**
 * The prediction as a block appended to a merge confirm, starting with a blank
 * line. Empty string when there is nothing to say.
 */
export function formatMergePreview(preview: MergePreview, sourceLabel: string): string {
  const lines: string[] = [];

  switch (preview.outcome) {
    case 'upToDate':
      lines.push('Already up to date — this merge would do nothing.');
      break;
    case 'fastForward':
      lines.push('This will fast-forward — no merge commit, no conflicts.');
      break;
    case 'unborn':
      lines.push(
        `The branch being merged into has no commits yet — it will be set to "${sourceLabel}".`,
      );
      break;
    case 'normal':
      if (preview.conflictCount === 0) {
        lines.push('This will create a merge commit. No conflicts predicted.');
      } else {
        const shown = preview.conflictingFiles.slice(0, MERGE_PREVIEW_LISTED_PATHS);
        lines.push(
          preview.conflictCount === 1
            ? '1 file would conflict:'
            : `${preview.conflictCount} files would conflict:`,
        );
        for (const file of shown) lines.push(`  • ${file}`);
        // `conflictingFiles` is itself capped by the backend, so the remainder
        // is counted from conflictCount — the only exact number available.
        const remaining = preview.conflictCount - shown.length;
        if (remaining > 0) lines.push(`  …and ${remaining} more`);
        lines.push('You can still merge and resolve the conflicts.');
      }
      break;
    default:
      // An outcome this build does not know about. Saying nothing beats
      // guessing — the confirm still works, just without a prediction.
      break;
  }

  if (preview.unrelatedHistories) {
    lines.push('These branches share no common history.');
  }
  if (preview.operationInProgress) {
    lines.push(
      `A ${preview.operationInProgress.toLowerCase()} is already in progress — ` +
        'finish or abort it first, or this merge will be refused.',
    );
  }

  return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
}

/**
 * Predict the merge and return the block to append to its confirm.
 *
 * Resolves to '' when the preview could not be computed, so the confirm is
 * shown WITHOUT a prediction rather than the merge being blocked on a
 * best-effort extra. Callers must already hold the repository's working-tree
 * claim (see `ref-lock.ts`); the preview itself takes no lock and writes
 * nothing, so it cannot deadlock against the merge it is previewing.
 *
 * @param intoRef Branch the merge will land on; omit for HEAD.
 */
export async function mergePreviewSummary(
  repoPath: string,
  sourceRef: string,
  intoRef?: string,
): Promise<string> {
  try {
    const result = await gitService.previewMerge(repoPath, sourceRef, intoRef);
    if (!result.success || !result.data) {
      // Deliberately not a toast: the confirm that follows is the user-visible
      // feedback, and a warning about a prediction they never asked for would
      // be noise in front of the question they did ask.
      loggers.git.warn('Merge preview unavailable:', result.error);
      return '';
    }
    return formatMergePreview(result.data, sourceRef);
  } catch (error) {
    loggers.git.warn('Merge preview failed:', error);
    return '';
  }
}
