/**
 * Open Location Service
 *
 * Opens a repository's working directory in the OS terminal, the OS file
 * manager, or the configured editor. Shared by the repository tab context
 * menu (which acts on the clicked tab) and the command palette (which acts on
 * the active repository) so both surfaces report failures identically.
 *
 * Success is the OS opening something, so there is no success toast — but the
 * backend can fail for reasons the user must see (no terminal emulator on
 * Linux, a path that has since been removed, an editor that cannot be
 * spawned), and `invokeCommand` never throws: it resolves to
 * `{success:false}`. Every helper therefore inspects the result and surfaces
 * the backend message as an error toast.
 */

import * as gitService from './git.service.ts';
import { showToast } from './notification.service.ts';
import { loggers } from '../utils/logger.ts';

const log = loggers.git;

/** Report a failed open with the backend's own message, never silently. */
function reportFailure(fallback: string, message?: string): false {
  const text = message && message.trim().length > 0 ? message : fallback;
  log.error(fallback, text);
  showToast(text, 'error');
  return false;
}

/**
 * Open a system terminal in the repository directory.
 * @returns true when the backend reported success.
 */
export async function openRepositoryInTerminal(repoPath: string): Promise<boolean> {
  if (!repoPath) return reportFailure('Failed to open terminal', 'No repository path');
  const result = await gitService.openTerminal(repoPath);
  if (!result.success) {
    return reportFailure('Failed to open terminal', result.error?.message);
  }
  return true;
}

/**
 * Open the repository directory in the system file manager.
 * @returns true when the backend reported success.
 */
export async function openRepositoryInFileManager(repoPath: string): Promise<boolean> {
  if (!repoPath) return reportFailure('Failed to open file manager', 'No repository path');
  const result = await gitService.openFileManager(repoPath);
  if (!result.success) {
    return reportFailure('Failed to open file manager', result.error?.message);
  }
  return true;
}

/**
 * Open the repository directory in the configured editor.
 *
 * Reuses the existing `open_in_configured_editor` command (git `core.editor`,
 * then GIT_EDITOR/VISUAL/EDITOR, then the system default handler) with the
 * repository root as the target — the same mechanism the palette's
 * "open file in editor" action uses, just pointed at the directory.
 *
 * @returns true when the backend reported success.
 */
export async function openRepositoryInEditor(repoPath: string): Promise<boolean> {
  if (!repoPath) return reportFailure('Failed to open editor', 'No repository path');
  const result = await gitService.openInConfiguredEditor(repoPath, repoPath);
  // The command resolves with an OpenResult that carries its own success flag,
  // so a resolved call is not proof the editor opened.
  if (!result.success || !result.data?.success) {
    return reportFailure(
      'Failed to open editor',
      result.data?.message ?? result.error?.message,
    );
  }
  if (result.data.notice) showToast(result.data.notice, 'info');
  return true;
}
