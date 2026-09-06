/**
 * Output log service
 * Singleton store of git command executions displayed by <lv-output-panel>.
 * Entries are recorded by the IPC layer (tauri-api.ts) for state-changing
 * commands; read queries are excluded so the log stays meaningful.
 */

import { claimableSubcommands, gitSubcommand } from './git-command-format.ts';

const MAX_ENTRIES = 100;

export interface OutputLogEntry {
  /** Stable identity — UI state (e.g. row expansion) must key off this, not
   *  the array position, which shifts every time a new entry is prepended. */
  id: number;
  timestamp: number;
  command: string;
  output: string;
  success: boolean;
  /** Repository the command ran against (absent for repo-independent commands) */
  repoPath?: string;
  /**
   * The git command line for this entry: the REAL invocation for operations
   * that shell out to git, or the equivalent line for the git2-backed ones.
   * Absent when there is no honest line to show, in which case the panel falls
   * back to `command` (the IPC name).
   */
  gitCommand?: string;
  /**
   * True when `gitCommand` was SYNTHESISED from a git2 operation's arguments
   * rather than being a command line that actually executed. The panel must
   * mark these so it never implies the CLI ran — see `git-command-format.ts`.
   */
  synthesized?: boolean;
  /** Wall-clock duration of the operation in milliseconds, when measured. */
  durationMs?: number;
}

/** Optional detail a caller can attach to a log entry. */
export interface OutputLogDetails {
  repoPath?: string;
  gitCommand?: string;
  synthesized?: boolean;
  durationMs?: number;
}

// Singleton log entries array and listeners
const logEntries: OutputLogEntry[] = [];
const listeners: Set<() => void> = new Set();
let nextEntryId = 1;

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribe to log changes. Returns an unsubscribe function.
 */
export function subscribeOutputLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Log a git command execution result. Returns the new entry's id.
 *
 * The fourth parameter accepts either a bare repository path (its original
 * shape, still used by tests and injected setups) or a details object carrying
 * the git command line, timing and repo path.
 */
export function logGitCommand(
  command: string,
  output: string,
  success: boolean,
  repoPathOrDetails?: string | OutputLogDetails,
): number {
  const details: OutputLogDetails =
    typeof repoPathOrDetails === 'string'
      ? { repoPath: repoPathOrDetails }
      : (repoPathOrDetails ?? {});

  const id = nextEntryId++;
  logEntries.unshift({
    id,
    timestamp: Date.now(),
    command,
    output,
    success,
    repoPath: details.repoPath,
    gitCommand: details.gitCommand,
    synthesized: details.synthesized,
    durationMs: details.durationMs,
  });

  // Trim to max entries
  if (logEntries.length > MAX_ENTRIES) {
    logEntries.length = MAX_ENTRIES;
  }

  notifyListeners();
  return id;
}

/**
 * Get current log entries as a read-only snapshot. Returns a shallow copy so
 * callers cannot mutate the store behind the listeners' backs or hold a live
 * reference that changes underneath them.
 */
export function getLogEntries(): ReadonlyArray<OutputLogEntry> {
  return [...logEntries];
}

/**
 * Clear log entries.
 *
 * With no argument, ALL entries are cleared (used by tests and injected setups).
 *
 * When `repoPath` is given, the log is scoped: entries for that repository are
 * removed AND repo-independent entries (those with no repoPath) are removed too
 * — those are the entries the scoped <lv-output-panel> actually displays, so
 * clearing matches what the user sees. Other repositories' entries are preserved
 * so clearing repo A never destroys repo B's history.
 */
export function clearLogEntries(repoPath?: string): void {
  // The entries a settled operation still points at are about to disappear, so
  // a late backend event must no longer try to replace one of them.
  recentlySettled.length = 0;
  if (repoPath === undefined) {
    logEntries.length = 0;
  } else {
    // Keep only entries that belong to a DIFFERENT repository.
    const kept = logEntries.filter(
      (e) => e.repoPath !== undefined && e.repoPath !== repoPath,
    );
    logEntries.length = 0;
    logEntries.push(...kept);
  }
  notifyListeners();
}

// ---------------------------------------------------------------------------
// Reconciling the panel's TWO feeds
// ---------------------------------------------------------------------------
//
// The Output panel is fed from two independent places:
//
//   1. `tauri-api.ts` records one row for every state-changing IPC command,
//      showing the EQUIVALENT `git` line it synthesises from the arguments.
//   2. `git-output.service.ts` records one row for every REAL `git` subprocess
//      the backend runs, from the `git-command-executed` event.
//
// Most operations run through libgit2 and only produce (1). But whether an
// operation shells out is the BACKEND's decision, made per call — a commit is
// signed through the CLI because `commit.gpgsign` is set, a push goes through
// it for `--force-with-lease`, a rebase for `--continue` — and every one that
// does produces BOTH, which showed the user two rows for one operation. Worse,
// the two could contradict each other: the synthesised line is built from the
// IPC arguments, so a commit signed because `commit.gpgsign` is set in the
// repository config rendered WITHOUT `-S` next to the real invocation that
// carried it.
//
// The real line is the truthful one — it is the actual argv — so it wins. An
// IPC call registers itself here for the duration of the operation; a real
// invocation reported while it is registered CLAIMS it, and the synthesised row
// is then never written.
//
// A claim requires the repository and the git subcommand to be COMPATIBLE: two
// KNOWN values that differ block it, so a background fetch in the same
// repository cannot swallow a commit's row and repository A's real line cannot
// swallow repository B's synthesised one. The subcommands an operation accepts
// are the one its synthesised line names plus any its backend is known to run
// INSTEAD (`claimableSubcommands`): a `merge` commits through `git commit -S`
// when signing is on, and refusing that as "a different subcommand" was
// exactly the doubling this module exists to remove. Many operations have no
// synthesised line and therefore no known subcommand at all
// (`clone_repository`, `run_gc`, `bundle_create`, the index builders), and
// those must still be claimable or they would double every time they shell
// out. So an unknown subcommand stays compatible — as a FALLBACK only: an
// operation whose subcommand IS this run's is always preferred, and an unknown
// one can never take the claim ahead of it.
//
// One more thing a claim needs is somewhere to anchor: a real run that reports
// NO repository (`git clone` has no working directory yet, so the backend
// cannot attach one) is compatible with every candidate on that axis, and
// attributing it to the first of several would be a guess that could silence
// the wrong operation's row. Such a run is claimed only when exactly one
// candidate remains; otherwise both rows stand.
//
// A claim taken on that fallback is a compatibility guess rather than a
// confirmed identity, so a failure arriving afterwards is carried onto the real
// row only when the subcommand CONFIRMED the claim; otherwise it gets a row of
// its own, because marking a real, successful invocation as failed with an
// unrelated error is worse than one extra row.
//
// Event delivery and IPC resolution are separate channels, so the real line can
// also arrive just AFTER the operation settles. A briefly-remembered settled
// operation covers that order too, replacing the row it already wrote.

/** An IPC operation that may or may not turn into a real `git` subprocess. */
interface GitOperation {
  id: number;
  /** IPC command name, e.g. `create_commit`. */
  command: string;
  /** Repository the operation targets, when it has one. */
  repoPath?: string;
  /**
   * git subcommands a real run of this operation may carry, when known: the
   * one its synthesised line names, plus any its backend runs instead.
   */
  subcommands?: readonly string[];
  /** Log entry id of the real invocation that claimed this operation. */
  claimedEntryId?: number;
  /**
   * True when the claim was confirmed by a matching git subcommand rather than
   * merely tolerated because one side's subcommand was unknown. Only a
   * confirmed claim may have this operation's failure stamped onto its row.
   */
  claimConfirmed?: boolean;
  /** Log entry id of the synthesised row written when it settled unclaimed. */
  settledEntryId?: number;
  /** Error text of a settled failure, so a late claim can carry it over. */
  settledFailure?: string;
  settledAt?: number;
}

/**
 * How long after an operation settles a real invocation may still be its own.
 * Long enough to absorb event-delivery lag, short enough that the NEXT
 * operation of the same shape is never mistaken for this one.
 */
const LATE_CLAIM_WINDOW_MS = 1500;
/** How many settled operations stay claimable. */
const RECENTLY_SETTLED_LIMIT = 4;
/** Guards against a caller that begins an operation and never settles it. */
const MAX_PENDING_OPERATIONS = 64;

/** In flight, oldest first. */
const pendingOperations: GitOperation[] = [];
/** Settled but still claimable, newest first. */
const recentlySettled: GitOperation[] = [];
let nextOperationId = 1;

/**
 * Whether a real invocation could belong to this operation.
 *
 * Deliberately permissive about what it does not know and strict about what it
 * does: an unknown repository or an unknown subcommand on either side is not
 * evidence of a mismatch, but two KNOWN values that differ are.
 */
function operationMatches(
  operation: GitOperation,
  repoPath: string | undefined,
  subcommand: string | undefined,
): boolean {
  if (operation.claimedEntryId !== undefined) return false;
  if (
    operation.repoPath !== undefined &&
    repoPath !== undefined &&
    operation.repoPath !== repoPath
  ) {
    return false;
  }
  if (
    operation.subcommands !== undefined &&
    subcommand !== undefined &&
    !operation.subcommands.includes(subcommand)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether a real run's subcommand CONFIRMS it belongs to this operation, as
 * opposed to being merely tolerated because one side's subcommand is unknown.
 */
function confirms(
  operation: GitOperation,
  subcommand: string | undefined,
): boolean {
  return (
    subcommand !== undefined &&
    operation.subcommands !== undefined &&
    operation.subcommands.includes(subcommand)
  );
}

function findClaimable(
  candidates: readonly GitOperation[],
  repoPath: string | undefined,
  subcommand: string | undefined,
): GitOperation | undefined {
  const matches = candidates.filter((op) =>
    operationMatches(op, repoPath, subcommand),
  );
  if (matches.length === 0) return undefined;
  // Prefer the operation whose subcommand IS this run's. `operationMatches` is
  // permissive about an unknown subcommand so the operations with no
  // synthesised line (`clone_repository`, `run_gc`, `bundle_create`, the index
  // builders) can still be claimed — but those are pending far more often, and
  // `matches` is oldest-first, so without this a background index refresh would
  // take a push's claim and the push would write a second, contradictory row.
  const confirmed = matches.filter((op) => confirms(op, subcommand));
  const preferred = confirmed.length > 0 ? confirmed : matches;
  // A run that reports NO repository (`git clone` has no working directory
  // yet) matches every candidate on the repository axis, so with more than
  // one left there is nothing to say which operation it was — and claiming the
  // first would silence the wrong one's row. Only an unambiguous candidate is
  // attributed; otherwise the real row and the synthesised rows all stand.
  if (repoPath === undefined && preferred.length > 1) return undefined;
  return preferred[0];
}

function entryIndex(id: number): number {
  return logEntries.findIndex((e) => e.id === id);
}

/**
 * Combine an entry's existing output with an operation error.
 *
 * The backend usually wraps the git stderr it already reported into the error
 * it returns, so one text routinely contains the other; keeping the longer of
 * the two avoids showing the same failure twice in one row.
 */
function mergeFailureText(existing: string, message: string): string {
  if (message === '') return existing;
  if (existing === '') return message;
  if (existing.includes(message)) return existing;
  if (message.includes(existing)) return message;
  return `${existing}\n${message}`;
}

/**
 * Mark an already-recorded entry as failed, carrying the IPC error onto it.
 *
 * Used when a real invocation reported success but the operation as a whole
 * failed afterwards: the user must still see why, and a second row would be the
 * doubling this module exists to remove. Returns false when the entry is gone
 * (trimmed or cleared), so the caller can fall back to a row of its own.
 */
function applyFailureToEntry(id: number, message: string): boolean {
  const index = entryIndex(id);
  if (index < 0) return false;
  const entry = logEntries[index];
  logEntries[index] = {
    ...entry,
    success: false,
    output: mergeFailureText(entry.output, message),
  };
  notifyListeners();
  return true;
}

/**
 * Register an IPC operation that is about to run.
 *
 * Returns the id to hand back to `settleGitOperation` when it finishes.
 */
export function beginGitOperation(
  command: string,
  repoPath: string | undefined,
  gitCommand: string | undefined,
  claimSubcommands: readonly string[] = claimableSubcommands(command, gitCommand) ?? [],
): number {
  // A caller that never settles would otherwise pin an operation forever and
  // let it swallow an unrelated real invocation later on.
  if (pendingOperations.length >= MAX_PENDING_OPERATIONS) {
    pendingOperations.shift();
  }
  const id = nextOperationId++;
  pendingOperations.push({
    id,
    command,
    repoPath,
    // An empty list means "unknown", which keeps the operation permissive; it
    // must never mean "accepts nothing", or the operation could never be
    // claimed and would double every time it shelled out.
    subcommands: claimSubcommands.length > 0 ? claimSubcommands : undefined,
  });
  return id;
}

/**
 * Finish an operation started with `beginGitOperation`.
 *
 * Writes the synthesised row, UNLESS a real `git` invocation already reported
 * this operation — in which case that row is the whole truth and this one would
 * only repeat (or contradict) it.
 */
export function settleGitOperation(
  id: number,
  command: string,
  output: string,
  success: boolean,
  details: OutputLogDetails,
): void {
  const index = pendingOperations.findIndex((op) => op.id === id);
  const operation = index >= 0 ? pendingOperations[index] : undefined;
  if (index >= 0) pendingOperations.splice(index, 1);

  if (!operation) {
    // Unknown id (settled twice, or evicted by the pending cap): recording the
    // row is the safe fallback — a duplicate row beats a missing one.
    logGitCommand(command, output, success, details);
    return;
  }

  if (operation.claimedEntryId !== undefined) {
    if (success) return;
    // Only a claim CONFIRMED by a matching subcommand may recolour the real
    // invocation's row: an operation claimed on the permissive fallback is not
    // provably the same action, and stamping its error onto that row would
    // report a git command that actually succeeded as having failed.
    if (
      operation.claimConfirmed === true &&
      applyFailureToEntry(operation.claimedEntryId, output)
    ) {
      return;
    }
    // Either the claim was unconfirmed, or the claimed entry is gone (cleared
    // or trimmed) — fall through and record the failure rather than losing it
    // or attaching it to a row that may not be this operation's.
  }

  operation.settledAt = Date.now();
  operation.settledFailure = success ? undefined : output;
  operation.settledEntryId = logGitCommand(command, output, success, details);
  recentlySettled.unshift(operation);
  if (recentlySettled.length > RECENTLY_SETTLED_LIMIT) {
    recentlySettled.length = RECENTLY_SETTLED_LIMIT;
  }
}

/**
 * Attribute a real `git` invocation (already recorded as `entryId`) to the IPC
 * operation that caused it, so that operation writes no second row.
 *
 * Called by `git-output.service.ts` right after it records the backend event.
 */
export function claimGitOperationForEntry(
  entryId: number,
  repoPath: string | undefined,
  commandLine: string,
): void {
  const subcommand = gitSubcommand(commandLine);

  const inFlight = findClaimable(pendingOperations, repoPath, subcommand);
  if (inFlight) {
    inFlight.claimedEntryId = entryId;
    inFlight.claimConfirmed = confirms(inFlight, subcommand);
    return;
  }

  // The event arrived after its own operation settled. Drop the synthesised row
  // it already wrote, carrying over an error the real run cannot know about.
  const now = Date.now();
  const settled = findClaimable(
    recentlySettled.filter(
      (op) =>
        op.settledEntryId !== undefined &&
        op.settledAt !== undefined &&
        now - op.settledAt <= LATE_CLAIM_WINDOW_MS,
    ),
    repoPath,
    subcommand,
  );
  if (!settled || settled.settledEntryId === undefined) return;

  // Same rule as `settleGitOperation`: a failure may only be carried onto the
  // real row when the subcommand CONFIRMS the claim. An unconfirmed operation
  // that failed keeps the row it already wrote — two rows are the honest
  // outcome, and recolouring a real invocation that succeeded with an
  // unrelated error is not.
  const confirmed = confirms(settled, subcommand);
  if (settled.settledFailure !== undefined && !confirmed) return;

  const index = entryIndex(settled.settledEntryId);
  if (index < 0) return;
  settled.claimedEntryId = entryId;
  settled.claimConfirmed = confirmed;
  logEntries.splice(index, 1);
  if (settled.settledFailure !== undefined) {
    // applyFailureToEntry notifies; when it cannot (entry gone) notify anyway
    // so the panel drops the row that was just removed.
    if (!applyFailureToEntry(entryId, settled.settledFailure)) notifyListeners();
  } else {
    notifyListeners();
  }
}

/** Reset the two-feed bookkeeping. Exported for tests. */
export function resetGitOperationTracking(): void {
  pendingOperations.length = 0;
  recentlySettled.length = 0;
}

// Read queries would flood the 100-entry buffer with noise (status polls,
// graph loads), and keyring/watcher plumbing isn't a git operation the user
// initiated — only state-changing commands belong in the output panel.
const SKIP_PREFIXES = [
  'get_',
  'list_',
  'check_',
  'detect_',
  'read_',
  'search_',
  'preview_',
  'is_',
  'plugin:',
];
const SKIP_COMMANDS = new Set([
  'start_watching',
  'stop_watching',
  'store_keyring_token',
  'delete_keyring_token',
  // App plumbing, not git operations the user ran
  'open_repository',
  'close_repository',
  // Native menu sync: fired at startup and on every tab open/close and
  // shortcut rebind, with no repository and nothing a user asked for.
  'sync_app_menu',
  // Repository discovery: the "Add repository" browse/scan plumbing.
  'classify_repository_path',
  'scan_for_repositories',
  'cancel_repository_scan',
  // Search/embedding index maintenance: background bookkeeping the user never
  // ran, and — because none of them has a git line — a stray claimant for the
  // real invocations of the operations the user DID run.
  'refresh_search_index',
  'build_search_index',
  'drop_search_index',
  'build_embedding_index',
  'cancel_embedding_build',
]);

/**
 * Whether an IPC command's result should be recorded in the output panel.
 */
export function shouldLogToOutput(command: string): boolean {
  if (SKIP_COMMANDS.has(command)) return false;
  return !SKIP_PREFIXES.some((prefix) => command.startsWith(prefix));
}
