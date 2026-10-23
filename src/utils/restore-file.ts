/**
 * Restoring a single file to its version in a commit, shared by the commit
 * details file list and the file history panel.
 *
 * `checkout_file_from_commit` is `git checkout <commit> -- <file>`: it
 * overwrites the working-tree copy AND stages it (checkout_file.rs writes the
 * blob, then index.add_path/index.write). Uncommitted work in that file is
 * gone with no reflog entry and no stash, so it needs the same irreversibility
 * confirm a discard has — and it must be worded once, here, rather than
 * per surface. Same rationale as `maintenance-confirms.ts`, which shares the
 * gc/prune confirms between the command palette and the health dialog.
 */

import { showConfirm } from '../services/dialog.service.ts';
import { showToast } from '../services/notification.service.ts';
import * as gitService from '../services/git.service.ts';
import { tryAcquireRefOpOrWarn, releaseRefOp } from './ref-lock.ts';

/** The one wording both restore surfaces use, so they cannot drift apart. */
export function restoreFileConfirmCopy(
  filePath: string,
  shortId: string
): { title: string; message: string } {
  return {
    title: 'Restore File',
    message:
      `Restore "${filePath}" to its version in ${shortId}? This overwrites your ` +
      'working copy of the file and stages it — uncommitted changes to it will be lost.',
  };
}

/**
 * Confirm, then restore. Resolves true only when the file was restored.
 *
 * The confirm is deliberately NOT gated on the "Confirm Before Discard"
 * setting: that setting is scoped to discarding uncommitted work from the
 * Changes list, where the user is looking straight at the files being thrown
 * away. Restore is a rare, deliberate action reached from a history view whose
 * rows say nothing about the working tree, so silently overwriting an edited
 * file from a context menu is not something a fewer-dialogs preference should
 * buy.
 */
export async function restoreFileFromCommit(
  repoPath: string,
  filePath: string,
  commitOid: string,
  shortId: string
): Promise<boolean> {
  // Claimed BEFORE the confirm: showConfirm is an IPC round trip, so a claim
  // taken after it does not serialize a double-clicked menu item — and this
  // writes the same working tree a checkout/reset/rebase mutates while the
  // backend takes no per-repo lock.
  if (!tryAcquireRefOpOrWarn(repoPath)) return false;
  try {
    const { title, message } = restoreFileConfirmCopy(filePath, shortId);
    if (!(await showConfirm(title, message, 'warning'))) return false;

    const result = await gitService.checkoutFileFromCommit(repoPath, {
      filePath,
      commit: commitOid,
    });
    if (!result.success) {
      showToast(result.error?.message ?? 'Failed to restore file', 'error');
      return false;
    }

    showToast(`Restored "${filePath}" from ${shortId}`, 'success');
    // Pinned refresh: repoPath was captured before the awaits, so a tab switch
    // mid-operation cannot refresh the wrong repo (app-shell
    // handleWindowRefresh -> refreshConflictDialogRepo). `status-refresh` makes
    // gn-file-status reload now, so the newly staged file shows up in Changes
    // instead of waiting on the watcher debounce — the same pair app-shell's
    // fixup/squash handlers dispatch.
    window.dispatchEvent(new CustomEvent('repository-refresh', { detail: { repoPath } }));
    window.dispatchEvent(new CustomEvent('status-refresh'));
    return true;
  } finally {
    releaseRefOp(repoPath);
  }
}
