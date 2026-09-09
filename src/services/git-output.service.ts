/**
 * Real `git` invocations from the backend.
 *
 * A large share of the app's operations shell out to the git CLI — interactive
 * rebase, force push, difftool/mergetool, GPG signing, LFS, maintenance. Those
 * runs have a REAL command line and real stdout/stderr, and
 * `src-tauri/src/utils/command.rs` reports each of them on the
 * `git-command-executed` event. This service carries them into the Output
 * panel's log, where they appear as executed commands (never marked
 * synthesised) alongside the git2 equivalents of the operations that did NOT
 * shell out. When a run belongs to an IPC operation the panel is already about
 * to describe, it claims that operation so only this — the real — line is
 * shown; see the two-feed reconciliation in `output-log.service.ts`.
 *
 * Redaction happens in the backend, on the command line and on the captured
 * output, before the event is emitted — see `redact_secrets` there.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  claimGitOperationForEntry,
  logGitCommand,
} from './output-log.service.ts';
import { safeUnlisten } from './tauri-api.ts';

/** Payload of the backend's `git-command-executed` event. */
export interface GitCommandExecutedEvent {
  /** The effective, already-redacted command line (e.g. `git push --force origin main`) */
  command: string;
  /** Combined stderr/stdout of the run, already redacted and truncated */
  output: string;
  success: boolean;
  durationMs: number;
  repoPath?: string | null;
}

/**
 * Record one backend git invocation in the output log.
 *
 * Split out from the listener so the mapping is testable without a Tauri event
 * bridge — the listener below is a one-line adapter onto this.
 */
export function recordGitCommandEvent(payload: GitCommandExecutedEvent): void {
  const { command, output, success, durationMs, repoPath } = payload;
  const entryId = logGitCommand(command, output ?? '', success, {
    repoPath: repoPath ?? undefined,
    gitCommand: command,
    // This command really ran. Never marked synthesised — that flag is what
    // tells the user the difference between "git did this" and "this is the
    // equivalent of what libgit2 did".
    synthesized: false,
    durationMs,
  });
  // This IS the invocation the IPC layer would otherwise describe from its
  // arguments. Claim that operation so it writes no second, weaker row — the
  // synthesised line cannot know about flags the backend added (`-S` for a
  // commit signed because of `commit.gpgsign`), so the two could disagree.
  claimGitOperationForEntry(entryId, repoPath ?? undefined, command);
}

let unlisten: UnlistenFn | undefined;
let starting: Promise<void> | undefined;

/**
 * Start recording backend git invocations into the output log.
 *
 * Idempotent: a second call while a listener is attached (or being attached)
 * is a no-op, so the panel can never show one command twice.
 */
export async function startGitCommandLogging(): Promise<void> {
  if (unlisten || starting) {
    return starting;
  }

  starting = listen<GitCommandExecutedEvent>('git-command-executed', (event) => {
    recordGitCommandEvent(event.payload);
  })
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => {
      // No Tauri event bridge (unit tests, plain browser). The panel still
      // shows the git2 equivalents recorded by the IPC layer.
    })
    .finally(() => {
      starting = undefined;
    });

  return starting;
}

/**
 * Stop recording backend git invocations.
 *
 * Never throws or rejects, mirroring the start side: `listen()` can succeed
 * against a mocked `invoke` while the event plugin's own internals — which the
 * unlisten closure reads — are absent, and this runs from the shell's
 * disconnectedCallback, which has no one to hand a rejection to.
 */
export function stopGitCommandLogging(): void {
  safeUnlisten(unlisten);
  unlisten = undefined;
}
