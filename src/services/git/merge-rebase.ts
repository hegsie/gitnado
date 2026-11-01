import { invokeCommand } from "../tauri-api.ts";
import type {
  RebasePlan,
  RebaseState,
  RebaseTodo,
  RebaseTodoEntry,
  ConflictFile,
  ConflictMarkerFile,
  ConflictDetails,
} from "../../types/git.types.ts";
import type {
  MergeCommand,
  AbortMergeCommand,
  RebaseCommand,
  ContinueRebaseCommand,
  AbortRebaseCommand,
  CommandResult,
  InteractiveRebaseOutcome,
} from "../../types/api.types.ts";

/**
 * Merge operations
 */
export async function merge(args: MergeCommand): Promise<CommandResult<void>> {
  return invokeCommand<void>("merge", args);
}

export interface MergePreview {
  /**
   * What the merge would do. `unborn` means the branch being merged INTO has
   * no commits yet, which `merge` cannot fast-forward.
   */
  outcome: "upToDate" | "fastForward" | "normal" | "unborn";
  /** Exact number of paths that would conflict. */
  conflictCount: number;
  /** The conflicting paths, sorted — capped, so it can be shorter than the count. */
  conflictingFiles: string[];
  /** The two sides share no common ancestor. */
  unrelatedHistories: boolean;
  /** Repository state blocking the merge (e.g. "Merge"), or null when clean. */
  operationInProgress: string | null;
}

/**
 * Predict a merge without performing it.
 *
 * Purely in-memory in the backend (libgit2 merges the two trees into an index
 * that is never checked out), so it touches neither the working tree nor the
 * index and leaves nothing to clean up. `intoRef` names the branch the merge
 * will land on; omit it for HEAD.
 */
export async function previewMerge(
  path: string,
  sourceRef: string,
  intoRef?: string,
): Promise<CommandResult<MergePreview>> {
  return invokeCommand<MergePreview>("preview_merge", {
    path,
    sourceRef,
    intoRef,
  });
}

export async function abortMerge(
  args: AbortMergeCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_merge", args);
}

/**
 * Complete an in-progress merge after all conflicts are resolved: creates
 * the merge commit (HEAD + MERGE_HEAD parents) and clears the MERGING state.
 * When `squash` is true, a single-parent commit is created instead so a
 * conflicted gitflow squash finish completes as a squash rather than a merge.
 */
export async function commitMerge(
  path: string,
  message?: string,
  squash?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("commit_merge", { path, message, squash });
}

/**
 * Rebase operations
 */
/**
 * Resolves with the number of commits the rebase skipped because their patch
 * was already applied on the target — see `rebasedOntoMessage`.
 */
export async function rebase(
  args: RebaseCommand,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("rebase", args);
}

export interface RebasePreview {
  totalCommits: number;
  cleanCommits: number;
  conflictingCommits: number;
  conflicts: PredictedConflict[];
}

export interface PredictedConflict {
  filePath: string;
  commitSummary: string;
}

export async function previewRebase(
  path: string,
  onto: string,
): Promise<CommandResult<RebasePreview>> {
  return invokeCommand<RebasePreview>("preview_rebase", { path, onto });
}

/** Resolves with how many commits the rebase dropped as already applied. */
export async function continueRebase(
  args: ContinueRebaseCommand,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("continue_rebase", args);
}

export async function abortRebase(
  args: AbortRebaseCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_rebase", args);
}

export async function getRebaseCommits(
  path: string,
  onto: string,
): Promise<CommandResult<RebasePlan>> {
  return invokeCommand<RebasePlan>("get_rebase_commits", { path, onto });
}

/** Is `oid` reachable from HEAD? Gates the reword/amend rebase route. */
export async function isAncestorOfHead(
  path: string,
  oid: string,
): Promise<CommandResult<boolean>> {
  return invokeCommand<boolean>("is_ancestor_of_head", { path, oid });
}

export async function executeInteractiveRebase(
  path: string,
  onto: string,
  todo: string,
): Promise<CommandResult<InteractiveRebaseOutcome>> {
  return invokeCommand<InteractiveRebaseOutcome>("execute_interactive_rebase", {
    path,
    onto,
    todo,
  });
}

/**
 * Interactive rebase state management
 */
export async function getRebaseState(
  path: string,
): Promise<CommandResult<RebaseState>> {
  return invokeCommand<RebaseState>("get_rebase_state", { path });
}

export async function getRebaseTodo(
  path: string,
): Promise<CommandResult<RebaseTodo>> {
  return invokeCommand<RebaseTodo>("get_rebase_todo", { path });
}

export async function updateRebaseTodo(
  path: string,
  entries: RebaseTodoEntry[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("update_rebase_todo", { path, entries });
}

export async function skipRebaseCommit(
  path: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("skip_rebase_commit", { path });
}

/**
 * Conflict resolution operations
 */
export async function getConflicts(
  path: string,
): Promise<CommandResult<ConflictFile[]>> {
  return invokeCommand<ConflictFile[]>("get_conflicts", { path });
}

export async function getBlobContent(
  path: string,
  oid: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_blob_content", { path, oid });
}

export async function resolveConflict(
  path: string,
  filePath: string,
  content: string,
  deleteFile?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("resolve_conflict", {
    path,
    filePath,
    content,
    deleteFile,
  });
}

/**
 * Resolve a conflict by taking one side's blob verbatim (binary-safe).
 * If the chosen side deleted the file, the resolution is the file's removal.
 */
export async function resolveConflictTakeSide(
  path: string,
  filePath: string,
  side: "ours" | "theirs",
): Promise<CommandResult<void>> {
  return invokeCommand<void>("resolve_conflict_take_side", {
    path,
    filePath,
    side,
  });
}

/**
 * Detect conflict markers in files
 *
 * Scans for Git conflict markers (<<<<<<< ======= >>>>>>>) in working directory files.
 * @param path Repository path
 * @param filePath Optional specific file to scan. If not provided, scans all conflicted files.
 */
export async function detectConflictMarkers(
  path: string,
  filePath?: string,
): Promise<CommandResult<ConflictMarkerFile[]>> {
  return invokeCommand<ConflictMarkerFile[]>("detect_conflict_markers", {
    path,
    filePath,
  });
}

/**
 * Get detailed conflict information for a specific file
 *
 * Returns conflict details including ref names and marker positions
 * @param path Repository path
 * @param filePath Path to the conflicted file
 */
export async function getConflictDetails(
  path: string,
  filePath: string,
): Promise<CommandResult<ConflictDetails>> {
  return invokeCommand<ConflictDetails>("get_conflict_details", {
    path,
    filePath,
  });
}


// ============================================================================
// External Merge Tool
// ============================================================================

/**
 * Merge tool configuration
 */
export interface MergeToolConfig {
  /** Name of the configured merge tool */
  toolName: string | null;
  /** Custom command for the merge tool */
  toolCmd: string | null;
}

/**
 * Information about a known merge tool
 */
export interface MergeToolInfo {
  /** Tool identifier name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Command used to launch the tool */
  command: string;
  /** Whether the tool is available on the system */
  available: boolean;
}

/**
 * Result of launching a merge tool
 */
export interface MergeToolResult {
  /** Whether the merge tool exited successfully */
  success: boolean;
  /** Output or error message from the merge tool */
  message: string;
}

/**
 * Get the current merge tool configuration
 * @param path Repository path
 * @returns Merge tool configuration
 */
export async function getMergeToolConfig(
  path: string,
): Promise<CommandResult<MergeToolConfig>> {
  return invokeCommand<MergeToolConfig>("get_merge_tool_config", {
    path,
  });
}

/**
 * Set the merge tool configuration
 * @param path Repository path
 * @param toolName Tool name (e.g., "kdiff3", "meld", "bc", "vscode")
 * @param toolCmd Custom command (optional, if not using standard tool)
 */
export async function setMergeToolConfig(
  path: string,
  toolName: string,
  toolCmd?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_merge_tool_config", {
    path,
    toolName,
    toolCmd,
  });
}

/**
 * Launch the configured merge tool for a specific file
 * @param path Repository path
 * @param filePath File to merge (relative to repo root)
 * @returns Result of launching the merge tool
 */
export async function launchMergeTool(
  path: string,
  filePath: string,
): Promise<CommandResult<MergeToolResult>> {
  return invokeCommand<MergeToolResult>("launch_merge_tool", {
    path,
    filePath,
  });
}

/**
 * Get a list of commonly available merge tools
 * @returns List of known merge tools
 */
export async function getAvailableMergeTools(): Promise<CommandResult<MergeToolInfo[]>> {
  return invokeCommand<MergeToolInfo[]>("get_available_merge_tools", {});
}

/**
 * Auto-detect the first available merge tool on the system
 * @returns The first available merge tool, or null if none found
 */
export async function autoDetectMergeTool(): Promise<CommandResult<MergeToolInfo | null>> {
  return invokeCommand<MergeToolInfo | null>("auto_detect_merge_tool", {});
}

