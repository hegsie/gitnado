/**
 * Tauri API wrapper for IPC communication
 * Provides type-safe command invocation and event listening
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CommandResult } from '../types/api.types.ts';
import {
  beginGitOperation,
  settleGitOperation,
  shouldLogToOutput,
} from './output-log.service.ts';
import { redactSecrets, synthesizeGitCommand } from './git-command-format.ts';

/**
 * Invoke a Tauri command with type safety
 */
export async function invokeCommand<T, A = unknown>(
  command: string,
  args?: A
): Promise<CommandResult<T>> {
  // Repo git commands carry the repository path so the output panel can scope
  // entries per repository in multi-repo sessions. Most commands pass it as
  // `path`, but a few (stage_hunk/unstage_hunk) pass it as `repoPath` — check
  // both so their entries are scoped to the right repo and survive a scoped Clear.
  const argsRecord = args as Record<string, unknown> | undefined;
  const repoPath =
    typeof argsRecord?.path === 'string'
      ? (argsRecord.path as string)
      : typeof argsRecord?.repoPath === 'string'
        ? (argsRecord.repoPath as string)
        : undefined;

  // The equivalent `git` command line for the operations that run through
  // libgit2, so the Output panel shows a git invocation rather than an IPC
  // name. Args are STILL never logged wholesale — they can carry credentials.
  // `synthesizeGitCommand` reads an explicit per-command allowlist of fields
  // (never `token`) and redacts what it renders; anything it does not cover
  // falls back to the command name, exactly as before.
  const logged = shouldLogToOutput(command);
  const gitCommand = logged ? synthesizeGitCommand(command, args) : undefined;
  // Register the operation for the duration of the call so a REAL `git` run
  // reported by the backend can claim it. Operations that shell out (a signed
  // commit, `push --force-with-lease`, a CLI clone, `rebase --continue`) would
  // otherwise produce two rows for one action — see output-log.service.ts.
  const operationId = logged
    ? beginGitOperation(command, repoPath, gitCommand)
    : undefined;
  const startedAt = Date.now();

  try {
    const data = await invoke<T>(command, args as Record<string, unknown>);
    if (operationId !== undefined) {
      settleGitOperation(operationId, command, '', true, {
        repoPath,
        gitCommand,
        synthesized: gitCommand !== undefined,
        durationMs: Date.now() - startedAt,
      });
    }
    return { success: true, data };
  } catch (error) {
    // Tauri errors from Rust are serialized as objects with code, message, details
    let message: string;
    let code = 'COMMAND_ERROR';

    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'object' && error !== null) {
      // Handle Tauri/Rust error objects
      const errObj = error as { code?: string; message?: string };
      message = errObj.message ?? JSON.stringify(error);
      code = errObj.code ?? 'COMMAND_ERROR';
    } else {
      message = String(error);
    }

    if (operationId !== undefined) {
      // Backend error messages routinely quote a remote URL, which can carry
      // `user:token@host` — scrub before it reaches the panel. When a real
      // invocation already claimed this operation, the error is carried onto
      // ITS row rather than opening a second one.
      settleGitOperation(operationId, command, redactSecrets(message), false, {
        repoPath,
        gitCommand,
        synthesized: gitCommand !== undefined,
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}

/**
 * Call a listener's unlisten function so that teardown can never throw or
 * reject, whatever state the event bridge is in.
 *
 * The closure `listen()` returns reads `window.__TAURI_EVENT_PLUGIN_INTERNALS__`
 * and then makes an IPC round trip. Outside a real webview (unit tests that
 * mock `invoke` and nothing else, a plain-browser preview) that global is
 * absent, so the call rejects — and a disconnectedCallback has nowhere to send
 * that rejection. It surfaces as an unhandled rejection that the test runner
 * charges to whichever test happens to be running, i.e. as an intermittent
 * failure of an unrelated test under load. The listener dies with the webview
 * anyway, so the failure is swallowed here, once, rather than at every
 * teardown site — that is the hand-enumerated list that goes stale.
 */
export function safeUnlisten(unlisten: UnlistenFn | null | undefined): void {
  if (!unlisten) return;
  try {
    // Typed as `() => void`, but the closure Tauri returns is async: a failure
    // arrives as a rejected promise, not a throw.
    const result = unlisten() as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {
        /* no event bridge — nothing to unregister */
      });
    }
  } catch {
    /* no event bridge — nothing to unregister */
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Listen to a Tauri event.
 *
 * The unlisten this resolves to is teardown-safe — see `safeUnlisten`.
 */
export async function listenToEvent<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (event) => {
    handler(event.payload);
  });
  return () => safeUnlisten(unlisten);
}

/**
 * Batch invoke multiple commands
 */
export async function invokeCommands<T extends readonly unknown[]>(
  commands: { command: string; args?: Record<string, unknown> }[]
): Promise<CommandResult<T[number]>[]> {
  return Promise.all(
    commands.map(({ command, args }) => invokeCommand(command, args))
  );
}
