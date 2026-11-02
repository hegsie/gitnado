/**
 * Live change feed (roadmap 4.1, #606): what an agent has changed in a
 * worktree, hunk by hunk, with accept / revert / feedback.
 *
 * "Accept" stages the hunk (the agent's change becomes part of what you will
 * commit), "Revert" puts that part of the file back to the index, and
 * "Feedback" types a note into the agent's terminal session running in that
 * worktree (or copies it when none is running).
 */
import * as gitService from './git.service.ts';
import { getTerminalSessions, writeToTerminal, type TerminalSession } from './terminal.service.ts';
import type { IndexedDiffHunk, StatusEntry } from '../types/git.types.ts';

/** Files beyond this are listed but their hunks are not loaded. */
export const MAX_FEED_FILES = 50;

export interface FeedFile {
  path: string;
  /** Untracked: a brand-new file with no hunks; accept/revert apply to the file. */
  isNew: boolean;
  isDeleted: boolean;
  hunks: IndexedDiffHunk[];
  /** Hunks were not loaded (over the file cap, or the read failed). */
  hunksError: string | null;
}

/** The unstaged side of a status listing: what the agent changed, not yet accepted. */
export function unstagedEntries(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter((e) => !e.isStaged && e.status !== 'ignored' && !e.isConflicted);
}

/** A cheap fingerprint of the unstaged changes, to know when to reload. */
export function feedSignature(entries: StatusEntry[]): string {
  return unstagedEntries(entries)
    .map((e) => `${e.status}:${e.path}`)
    .sort()
    .join('\n');
}

/** Load the feed for one worktree: every unstaged file and its hunks. */
export async function loadFeed(worktreePath: string, entries: StatusEntry[]): Promise<FeedFile[]> {
  const files = unstagedEntries(entries).sort((a, b) => a.path.localeCompare(b.path));
  return Promise.all(
    files.map(async (entry, i): Promise<FeedFile> => {
      const base = {
        path: entry.path,
        isNew: entry.status === 'untracked' || entry.status === 'new',
        isDeleted: entry.status === 'deleted',
      };
      if (base.isNew) return { ...base, hunks: [], hunksError: null };
      if (i >= MAX_FEED_FILES) return { ...base, hunks: [], hunksError: `Only the first ${MAX_FEED_FILES} files are shown in detail` };
      const result = await gitService.getFileHunks(worktreePath, entry.path, false);
      return result.success && result.data
        ? { ...base, hunks: result.data.hunks, hunksError: null }
        : { ...base, hunks: [], hunksError: result.error?.message ?? 'Could not read the changes' };
    }),
  );
}

/** "lines 12–18" for a hunk (the working-tree side). */
export function hunkRange(hunk: IndexedDiffHunk): string {
  if (hunk.newLines === 0) return `after line ${hunk.newStart}`;
  const end = hunk.newStart + hunk.newLines - 1;
  return end === hunk.newStart ? `line ${hunk.newStart}` : `lines ${hunk.newStart}-${end}`;
}

/** The note typed into the agent's terminal. One line per paragraph keeps it a single prompt. */
export function formatFeedback(file: string, hunk: IndexedDiffHunk | null, text: string): string {
  const where = hunk ? `${file} (${hunkRange(hunk)})` : file;
  const body = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  return `Feedback on ${where}: ${body}`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** The running terminal session in `worktreePath`, newest first. */
export function findAgentTerminal(worktreePath: string): TerminalSession | undefined {
  return getTerminalSessions()
    .filter((s) => s.status === 'running' && samePath(s.cwd, worktreePath))
    .pop();
}

export type FeedbackDelivery = 'terminal' | 'clipboard' | 'failed';

/**
 * Deliver feedback: typed into the worktree's running agent terminal and
 * submitted, or copied to the clipboard when no session is running there.
 */
export async function sendFeedback(worktreePath: string, message: string): Promise<{ via: FeedbackDelivery; label?: string }> {
  const session = findAgentTerminal(worktreePath);
  if (session && (await writeToTerminal(session, `${message}\r`))) {
    return { via: 'terminal', label: session.label };
  }
  try {
    await navigator.clipboard.writeText(message);
    return { via: 'clipboard' };
  } catch {
    return { via: 'failed' };
  }
}
