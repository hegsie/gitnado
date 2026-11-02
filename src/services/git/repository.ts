import { invokeCommand } from "../tauri-api.ts";
import { showConfirm } from "../dialog.service.ts";
import { settingsStore } from "../../stores/settings.store.ts";
import type {
  Repository,
  Commit,
  StatusEntry,
  FileHunks,
  FileAtCommitResult,
  FileEncodingInfo,
  ConvertEncodingResult,
  SortedFileStatus,
  FileStatusSortBy,
  SortDirection,
  CloneFilterInfo,
} from "../../types/git.types.ts";
import type {
  OpenRepositoryCommand,
  CloneRepositoryCommand,
  InitRepositoryCommand,
  CreateCommitCommand,
  GetCommitHistoryCommand,
  AmendCommitCommand,
  AmendResult,
  EditCommitDateCommand,
  StageFilesCommand,
  UnstageFilesCommand,
  CheckoutFileFromCommitCommand,
  CheckoutFileFromBranchCommand,
  GetFileAtCommitCommand,
  CommandResult,
} from "../../types/api.types.ts";
import type {
  IntegrationAccount,
} from "../../types/unified-profile.types.ts";
import {
  blockedResult,
  checkNetworkPermission,
  getCloneToken,
  surfaceBackendRefusal,
} from "./shared.ts";

/**
 * Repository operations
 */
export async function openRepository(
  args: OpenRepositoryCommand,
): Promise<CommandResult<Repository>> {
  return invokeCommand<Repository>("open_repository", args);
}

/**
 * Hooks the clone dialog hands `cloneRepository`.
 */
export interface CloneRepositoryOptions {
  /**
   * Reports whether the user has cancelled the clone in the meantime.
   *
   * Everything before the `clone_repository` invoke is asynchronous — the
   * network gate can await a native confirm, and the token lookup a keyring
   * round trip — while the dialog already shows "Cancel Clone". A cancel
   * pressed in that window sets the backend's cancellation flag, but the
   * backend RESETS that flag when the clone starts (a stale cancellation must
   * not kill the next clone), so the clone it was meant to stop ran to
   * completion with the dialog locked on "Cancelling…". Checked immediately
   * before the invoke so a cancel that has already landed stops the clone
   * from ever starting.
   */
  isCancelled?: () => boolean;
  /**
   * The connected account the clone URL was picked from (the clone dialog's
   * account picker). Its token is attached ahead of the host-based lookup, so
   * the clone runs as the identity the repository was listed under rather
   * than as the host's default account. Ignored when `args.token` is set.
   */
  account?: IntegrationAccount | null;
}

/** The result every cancellable operation returns for the user's own Cancel. */
function cancelledResult<T>(): CommandResult<T> {
  return {
    success: false,
    error: { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' },
  };
}

export async function cloneRepository(
  args: CloneRepositoryCommand,
  options?: CloneRepositoryOptions,
): Promise<CommandResult<Repository>> {
  // A clone URL is a git remote: `git clone sub/mybackup.git` is a copy from a
  // repository on this disk, and the backend's `guard_remote_url` says so too.
  if (!await checkNetworkPermission('clone', null, args.url, undefined, undefined, 'remote')) {
    return blockedResult();
  }

  // No token supplied: use the account the URL was picked from, else fall
  // back to the one stored for the account that owns this URL's host.
  if (args && !args.token) {
    const token = await getCloneToken(args.url, options?.account);
    if (token) {
      args.token = token;
    }
  }
  // Apply the same network timeout fetch/pull/push use. Without it a clone
  // against an unreachable host hangs forever, and the dialog cannot be closed
  // while one is in flight.
  const timeoutSecs = settingsStore.getState().networkOperationTimeout;
  if (args && timeoutSecs > 0) {
    args.timeoutSecs = timeoutSecs;
  }

  // Last chance to honour a cancel that landed during the awaits above: once
  // the command is sent the backend clears the cancellation flag and the clone
  // runs. See `CloneRepositoryOptions.isCancelled`.
  if (options?.isCancelled?.()) {
    return cancelledResult();
  }

  return invokeCommand<Repository>("clone_repository", args);
}

/**
 * Cancel the clone currently in flight.
 *
 * Kills the `git clone` child process on the CLI path and aborts the transfer
 * on the git2 path, then clears the partial destination directory.
 */
export async function cancelClone(): Promise<CommandResult<void>> {
  return invokeCommand<void>("cancel_clone", {});
}

export async function initRepository(
  args: InitRepositoryCommand,
): Promise<CommandResult<Repository>> {
  return invokeCommand<Repository>("init_repository", args);
}

export async function getCloneFilterInfo(
  path: string,
): Promise<CommandResult<CloneFilterInfo>> {
  return invokeCommand<CloneFilterInfo>("get_clone_filter_info", { path });
}

/**
 * `git fetch --deepen` is a fetch: it contacts the remote for the history the
 * shallow clone left behind. It named no remote and had no frontend gate at
 * all, so offline mode let it go straight out; the backend `guard_remote` was
 * the only thing standing in front of it, and a backend-only refusal is one
 * the user is never shown a reason for. Neither names a remote, so the gate
 * resolves the one git itself would fetch from.
 */
export async function deepenRepository(
  path: string,
  depth: number,
): Promise<CommandResult<void>> {
  if (!await checkNetworkPermission('deepen', path)) {
    return blockedResult();
  }
  return surfaceBackendRefusal(
    await invokeCommand<void>("deepen_repository", { path, depth }),
  );
}

/** `git fetch --unshallow`, the whole history in one request. Gated exactly
 * like {@link deepenRepository}. */
export async function unshallowRepository(
  path: string,
): Promise<CommandResult<void>> {
  if (!await checkNetworkPermission('unshallow', path)) {
    return blockedResult();
  }
  return surfaceBackendRefusal(
    await invokeCommand<void>("unshallow_repository", { path }),
  );
}

export async function listTrackedFiles(
  path: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("list_tracked_files", { path });
}


/**
 * Commit operations
 */
export async function getCommitHistory(
  args: GetCommitHistoryCommand,
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("get_commit_history", args);
}

/**
 * Total number of commits reachable from any ref (size of the all-branches
 * graph walk). Cheap when the backend walk cache is warm.
 */
export async function getCommitTotal(
  repoPath: string,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("get_commit_total", { path: repoPath });
}

export async function getCommit(
  repoPath: string,
  oid: string,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("get_commit", { path: repoPath, oid });
}

/**
 * Search commits with filters
 */
export async function searchCommits(
  repoPath: string,
  options: {
    query?: string;
    author?: string;
    dateFrom?: number;
    dateTo?: number;
    filePath?: string;
    branch?: string;
    limit?: number;
  },
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("search_commits", {
    path: repoPath,
    query: options.query,
    author: options.author,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    filePath: options.filePath,
    branch: options.branch,
    limit: options.limit,
  });
}

/**
 * Whether HEAD is already on its upstream, so amending would rewrite history
 * other people may already have.
 *
 * A failure to find out answers false: the check exists to add a warning, and
 * a broken check must not become a wall in front of an ordinary local amend.
 */
async function amendWouldRewritePublishedHistory(path: string): Promise<boolean> {
  const result = await invokeCommand<boolean>("is_head_published", { path });
  return result.success && result.data === true;
}

export async function createCommit(
  path: string,
  args: CreateCommitCommand,
): Promise<CommandResult<Commit>> {
  // Amend rewrites HEAD. When HEAD is already published, that rewrites history
  // the remote and everyone else already has: the branch and its upstream
  // diverge, the next push is rejected, and the only way on is a force push
  // that discards whatever anyone based on that commit.
  //
  // No amend surface said so — not the commit panel's Amend checkbox, not the
  // graph's Quick Amend, not the reword-HEAD route. The confirm goes HERE, at
  // the one call all three share, so none of them can be forgotten.
  if (args.amend && (await amendWouldRewritePublishedHistory(path))) {
    const proceed = await showConfirm(
      "Amend a pushed commit?",
      "This commit is already on the remote. Amending replaces it, so your " +
        "branch and its upstream will diverge and the next push will be " +
        "rejected until you force push — which discards any work others based " +
        "on it.\n\nAmend anyway?",
      "warning",
    );
    if (!proceed) {
      // The SAME shape a declined network gate returns, so isNetworkGateRefusal
      // recognises it and callers do not report the user's own choice back to
      // them as a failure.
      return { success: false, error: { code: "CANCELLED", message: "Cancelled" } };
    }
  }
  return invokeCommand<Commit>("create_commit", { path, ...args });
}

/**
 * Amend the HEAD commit
 * @param path Repository path
 * @param args Options for amending (message, resetAuthor, and/or signAmend)
 */
export async function amendCommit(
  path: string,
  args?: AmendCommitCommand,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("amend_commit", {
    path,
    message: args?.message,
    resetAuthor: args?.resetAuthor,
    signAmend: args?.signAmend,
  });
}

/**
 * Get the full commit message for a commit
 * @param path Repository path
 * @param oid Commit OID
 */
export async function getCommitMessage(
  path: string,
  oid: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_commit_message", { path, oid });
}

/**
 * Edit the author and/or committer date of an existing commit
 * For HEAD commits, this recreates the commit with updated signatures.
 * For non-HEAD commits, this uses interactive rebase with GIT_AUTHOR_DATE/GIT_COMMITTER_DATE.
 * @param path Repository path
 * @param args Options including oid and date(s) to set (ISO 8601 or unix timestamp)
 */
export async function editCommitDate(
  path: string,
  args: EditCommitDateCommand,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("edit_commit_date", {
    path,
    oid: args.oid,
    authorDate: args.authorDate,
    committerDate: args.committerDate,
  });
}

/**
 * Reword a commit (change its message)
 * For HEAD commits, this uses amend. For non-HEAD commits, this uses interactive rebase.
 * @param path Repository path
 * @param oid Commit OID to reword
 * @param message New commit message
 */
export async function rewordCommit(
  path: string,
  oid: string,
  message: string,
): Promise<CommandResult<AmendResult>> {
  return invokeCommand<AmendResult>("reword_commit", { path, oid, message });
}

/**
 * Staging operations
 */
export async function getStatus(
  path: string,
): Promise<CommandResult<StatusEntry[]>> {
  return invokeCommand<StatusEntry[]>("get_status", { path });
}

/**
 * Get sorted file status with enriched metadata for file tree display
 * @param path Repository path
 * @param sortBy Sort criteria: "name", "status", "path", or "extension"
 * @param sortDirection Sort direction: "asc" or "desc" (default "asc")
 * @param groupByDirectory Whether to group files by directory
 */
export async function getSortedFileStatus(
  path: string,
  sortBy: FileStatusSortBy,
  sortDirection?: SortDirection,
  groupByDirectory: boolean = false,
): Promise<CommandResult<SortedFileStatus>> {
  return invokeCommand<SortedFileStatus>("get_sorted_file_status", {
    path,
    sortBy,
    sortDirection,
    groupByDirectory,
  });
}

export async function stageFiles(
  repoPath: string,
  args: StageFilesCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_files", { path: repoPath, ...args });
}

export async function unstageFiles(
  repoPath: string,
  args: UnstageFilesCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_files", { path: repoPath, ...args });
}

export async function discardChanges(
  repoPath: string,
  paths: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("discard_changes", { path: repoPath, paths });
}

/**
 * Stage a specific hunk from a diff
 * @param repoPath Repository path
 * @param patch The patch content for the hunk (with proper diff headers)
 */
export async function stageHunk(
  repoPath: string,
  patch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_hunk", { repoPath, patch });
}

/**
 * Unstage a specific hunk from the index
 * @param repoPath Repository path
 * @param patch The patch content for the hunk (with proper diff headers)
 */
export async function unstageHunk(
  repoPath: string,
  patch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_hunk", { repoPath, patch });
}

/**
 * Get hunks for a file (staged or unstaged)
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param staged Whether to get staged (true) or unstaged (false) hunks
 */
export async function getFileHunks(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<CommandResult<FileHunks>> {
  return invokeCommand<FileHunks>("get_file_hunks", {
    path: repoPath,
    filePath,
    staged,
  });
}

/**
 * Stage a specific hunk by its index
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param hunkIndex Index of the hunk to stage
 */
export async function stageHunkByIndex(
  repoPath: string,
  filePath: string,
  hunkIndex: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_hunk_by_index", {
    path: repoPath,
    filePath,
    hunkIndex,
  });
}

/**
 * Unstage a specific hunk by its index
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param hunkIndex Index of the hunk to unstage
 */
export async function unstageHunkByIndex(
  repoPath: string,
  filePath: string,
  hunkIndex: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unstage_hunk_by_index", {
    path: repoPath,
    filePath,
    hunkIndex,
  });
}

/**
 * Stage specific lines from a diff
 * @param repoPath Repository path
 * @param filePath File path relative to repo root
 * @param startLine Start line index (0-indexed in the diff output)
 * @param endLine End line index (inclusive, 0-indexed in the diff output)
 */
export async function stageLines(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("stage_lines", {
    path: repoPath,
    filePath,
    startLine,
    endLine,
  });
}

/**
 * Write content to a file in the working directory
 * @param repoPath Repository path
 * @param filePath Path to the file relative to repo root
 * @param content Content to write
 * @param stageAfter Whether to stage the file after writing
 */
export async function writeFileContent(
  repoPath: string,
  filePath: string,
  content: string,
  stageAfter?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("write_file_content", {
    repoPath,
    filePath,
    content,
    stageAfter,
  });
}

/**
 * Read file content from working directory or index
 * @param repoPath Repository path
 * @param filePath Path to the file relative to repo root
 * @param fromIndex Whether to read from index instead of working directory
 */
export async function readFileContent(
  repoPath: string,
  filePath: string,
  fromIndex?: boolean,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("read_file_content", {
    repoPath,
    filePath,
    fromIndex,
  });
}


// ============================================================================
// Commit Templates
// ============================================================================

export interface CommitTemplate {
  id: string;
  name: string;
  content: string;
  isConventional: boolean;
  createdAt: number;
}

export interface ConventionalType {
  typeName: string;
  description: string;
  emoji?: string;
}

/**
 * Get commit template from git config or .gitmessage file
 */
export async function getCommitTemplate(
  repoPath: string,
): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>("get_commit_template", {
    path: repoPath,
  });
}

/**
 * List all saved commit templates
 */
export async function listTemplates(): Promise<
  CommandResult<CommitTemplate[]>
> {
  return invokeCommand<CommitTemplate[]>("list_templates", {});
}

/**
 * Save a commit template
 */
export async function saveTemplate(
  template: CommitTemplate,
): Promise<CommandResult<CommitTemplate>> {
  return invokeCommand<CommitTemplate>("save_template", { template });
}

/**
 * Delete a commit template
 */
export async function deleteTemplate(id: string): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_template", { id });
}

/**
 * Get conventional commit types
 */
export async function getConventionalTypes(): Promise<
  CommandResult<ConventionalType[]>
> {
  return invokeCommand<ConventionalType[]>("get_conventional_types", {});
}


/**
 * Gitignore management
 */
export interface GitignoreEntry {
  pattern: string;
  lineNumber: number;
  isComment: boolean;
  isNegation: boolean;
  isEmpty: boolean;
}

export interface GitignoreTemplate {
  name: string;
  patterns: string[];
}

export async function getGitignore(
  repoPath: string,
): Promise<CommandResult<GitignoreEntry[]>> {
  return invokeCommand<GitignoreEntry[]>("get_gitignore", { path: repoPath });
}

export async function addToGitignore(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<void>> {
  return invokeCommand<void>("add_to_gitignore", { path: repoPath, patterns });
}

/**
 * Remove the rule on `lineNumber` (1-based, as reported by `getGitignore`).
 *
 * The line is required, not the pattern alone: a .gitignore can repeat a line,
 * and the backend used to drop every line with matching text — removing one
 * displayed row took its twins with it.
 */
export async function removeFromGitignore(
  repoPath: string,
  pattern: string,
  lineNumber: number,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_from_gitignore", {
    path: repoPath,
    pattern,
    lineNumber,
  });
}

export async function isIgnored(
  repoPath: string,
  filePath: string,
): Promise<CommandResult<boolean>> {
  return invokeCommand<boolean>("is_ignored", { path: repoPath, filePath });
}

export async function getGitignoreTemplates(): Promise<
  CommandResult<GitignoreTemplate[]>
> {
  return invokeCommand<GitignoreTemplate[]>("get_gitignore_templates", {});
}

export interface IgnoreCheckResult {
  path: string;
  isIgnored: boolean;
}

export interface IgnoreCheckVerboseResult {
  path: string;
  isIgnored: boolean;
  /** Which .gitignore file contains the matching rule */
  sourceFile: string | null;
  /** Line number in the .gitignore file */
  sourceLine: number | null;
  /** The matching pattern */
  pattern: string | null;
  /** Whether the matching pattern is negated (! prefix) */
  isNegated: boolean;
}

export async function checkIgnore(
  repoPath: string,
  filePaths: string[],
): Promise<CommandResult<IgnoreCheckResult[]>> {
  return invokeCommand<IgnoreCheckResult[]>("check_ignore", {
    path: repoPath,
    filePaths,
  });
}

export async function checkIgnoreVerbose(
  repoPath: string,
  filePaths: string[],
): Promise<CommandResult<IgnoreCheckVerboseResult[]>> {
  return invokeCommand<IgnoreCheckVerboseResult[]>("check_ignore_verbose", {
    path: repoPath,
    filePaths,
  });
}

/**
 * Gitattributes management
 */
/**
 * Mirrors the externally-tagged Rust `AttributeValue`. Serde emits the unit
 * variants as the bare strings `"set"` / `"unset"` / `"unspecified"` and the
 * valued variant as `{ value }` — never `{ type: "set" }`. The previous
 * object-only union here never matched the wire, so anything rendered from it
 * showed `undefined`; `attribute_value_unit_variants_serialize_as_bare_strings`
 * in `src-tauri/src/commands/gitattributes.rs` pins the other side.
 */
export type AttributeValue =
  | "set"
  | "unset"
  | "unspecified"
  | { value: string };

export interface AttributeEntry {
  name: string;
  value: AttributeValue;
}

export interface GitAttribute {
  pattern: string;
  attributes: AttributeEntry[];
  lineNumber: number;
  rawLine: string;
}

export interface CommonAttribute {
  name: string;
  description: string;
  example: string;
}

export async function getGitattributes(
  repoPath: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("get_gitattributes", { path: repoPath });
}

export async function addGitattribute(
  repoPath: string,
  pattern: string,
  attributes: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("add_gitattribute", {
    path: repoPath,
    pattern,
    attributes,
  });
}

export async function removeGitattribute(
  repoPath: string,
  lineNumber: number,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("remove_gitattribute", {
    path: repoPath,
    lineNumber,
  });
}

export async function updateGitattribute(
  repoPath: string,
  lineNumber: number,
  pattern: string,
  attributes: string,
): Promise<CommandResult<GitAttribute[]>> {
  return invokeCommand<GitAttribute[]>("update_gitattribute", {
    path: repoPath,
    lineNumber,
    pattern,
    attributes,
  });
}

export async function getCommonAttributes(): Promise<
  CommandResult<CommonAttribute[]>
> {
  return invokeCommand<CommonAttribute[]>("get_common_attributes", {});
}


/**
 * Repository statistics
 */
export interface ContributorStats {
  name: string;
  email: string;
  commitCount: number;
  firstCommit: number;
  latestCommit: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface MonthActivity {
  year: number;
  month: number;
  commitCount: number;
}

export interface DayOfWeekActivity {
  day: string;
  dayIndex: number;
  commitCount: number;
}

export interface HourActivity {
  hour: number;
  commitCount: number;
}

export interface RepoStats {
  totalCommits: number;
  totalBranches: number;
  totalTags: number;
  totalContributors: number;
  firstCommitDate: number | null;
  latestCommitDate: number | null;
  contributors: ContributorStats[];
  activityByMonth: MonthActivity[];
  activityByDayOfWeek: DayOfWeekActivity[];
  activityByHour: HourActivity[];
  filesCount: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
}

export async function getRepoStats(
  repoPath: string,
  maxCommits?: number,
): Promise<CommandResult<RepoStats>> {
  return invokeCommand<RepoStats>("get_repo_stats", {
    path: repoPath,
    maxCommits,
  });
}

export async function getContributorStats(
  repoPath: string,
  maxCommits?: number,
): Promise<CommandResult<ContributorStats[]>> {
  return invokeCommand<ContributorStats[]>("get_contributor_stats", {
    path: repoPath,
    maxCommits,
  });
}

/**
 * Enhanced repository statistics for dashboard
 */
export interface EnhancedMonthActivity {
  year: number;
  month: number;
  commits: number;
  authors: number;
}

export interface WeekdayActivity {
  day: string;
  commits: number;
}

export interface EnhancedHourActivity {
  hour: number;
  commits: number;
}

export interface EnhancedContributorStats {
  name: string;
  email: string;
  commits: number;
  linesAdded: number;
  linesDeleted: number;
  firstCommit: number;
  lastCommit: number;
}

export interface FileTypeStats {
  extension: string;
  fileCount: number;
  totalLines: number;
}

export interface RepoStatistics {
  // Basics
  totalCommits: number;
  totalBranches: number;
  totalTags: number;
  totalContributors: number;
  totalFiles: number;
  repoSizeBytes: number;

  // First/Last commits
  firstCommitDate: number | null;
  lastCommitDate: number | null;
  repoAgeDays: number;

  // Activity breakdown (if includeActivity)
  activityByMonth: EnhancedMonthActivity[] | null;
  activityByWeekday: WeekdayActivity[] | null;
  activityByHour: EnhancedHourActivity[] | null;

  // Contributor breakdown (if includeContributors)
  topContributors: EnhancedContributorStats[] | null;

  // File type breakdown (if includeFileTypes)
  fileTypes: FileTypeStats[] | null;

  // Code stats
  totalLinesAdded: number;
  totalLinesDeleted: number;
}

export interface GetRepoStatisticsOptions {
  includeActivity?: boolean;
  includeContributors?: boolean;
  includeFileTypes?: boolean;
  since?: string; // ISO 8601 date
  until?: string; // ISO 8601 date
}

export async function getRepoStatistics(
  repoPath: string,
  options?: GetRepoStatisticsOptions,
): Promise<CommandResult<RepoStatistics>> {
  return invokeCommand<RepoStatistics>("get_repo_statistics", {
    path: repoPath,
    includeActivity: options?.includeActivity ?? false,
    includeContributors: options?.includeContributors ?? false,
    includeFileTypes: options?.includeFileTypes ?? false,
    since: options?.since,
    until: options?.until,
  });
}


/**
 * Checkout file operations
 */

/**
 * Checkout a file from a specific commit, restoring it in the working directory.
 * This overwrites the file in the working directory and stages the change.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.commit Commit OID or ref (e.g., "HEAD~1", tag name, branch name)
 * @returns The file content and metadata at the specified commit
 */
export async function checkoutFileFromCommit(
  path: string,
  args: CheckoutFileFromCommitCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("checkout_file_from_commit", {
    path,
    filePath: args.filePath,
    commit: args.commit,
  });
}

/**
 * Checkout a file from a specific branch, restoring it in the working directory.
 * This resolves the branch to its tip commit and checks out the file from there.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.branch Branch name (local or remote)
 * @returns The file content and metadata at the branch tip
 */
export async function checkoutFileFromBranch(
  path: string,
  args: CheckoutFileFromBranchCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("checkout_file_from_branch", {
    path,
    filePath: args.filePath,
    branch: args.branch,
  });
}

/**
 * View a file at a specific commit without modifying the working directory.
 * This is a read-only operation for previewing file contents at a point in history.
 *
 * @param path Repository path
 * @param args.filePath File path relative to the repository root
 * @param args.commit Commit OID or ref (e.g., "HEAD~1", tag name, branch name)
 * @returns The file content and metadata at the specified commit
 */
export async function getFileAtCommit(
  path: string,
  args: GetFileAtCommitCommand,
): Promise<CommandResult<FileAtCommitResult>> {
  return invokeCommand<FileAtCommitResult>("get_file_at_commit", {
    path,
    filePath: args.filePath,
    commit: args.commit,
  });
}

/**
 * File encoding operations
 */

/**
 * Detect the encoding of a file in the repository.
 * Returns encoding name, confidence, BOM detection, line ending style, and binary status.
 *
 * @param path Repository path
 * @param filePath File path relative to the repository root
 * @returns Encoding information for the file
 */
export async function detectFileEncoding(
  path: string,
  filePath: string,
): Promise<CommandResult<FileEncodingInfo>> {
  return invokeCommand<FileEncodingInfo>("detect_file_encoding", {
    path,
    filePath,
  });
}

/**
 * Convert a file's encoding to a target encoding.
 * The file is read with its detected encoding, decoded, and re-encoded to the target.
 *
 * @param path Repository path
 * @param filePath File path relative to the repository root
 * @param targetEncoding Target encoding name (e.g., "utf-8", "utf-16le", "shift_jis")
 * @returns Conversion result with source/target encodings and bytes written
 */
export async function convertFileEncoding(
  path: string,
  filePath: string,
  targetEncoding: string,
): Promise<CommandResult<ConvertEncodingResult>> {
  return invokeCommand<ConvertEncodingResult>("convert_file_encoding", {
    path,
    filePath,
    targetEncoding,
  });
}

// ── Commit Message Validation ──────────────────────────────────────

/**
 * Rules for validating commit messages
 */
export interface CommitMessageRules {
  /** Maximum length of the subject line (e.g., 72) */
  maxSubjectLength: number | null;
  /** Maximum length of each body line (e.g., 100) */
  maxBodyLineLength: number | null;
  /** Require a blank line between subject and body */
  requireBlankLineBeforeBody: boolean;
  /** Require conventional commit format: type(scope): description */
  requireConventionalFormat: boolean;
  /** Allowed conventional commit types (e.g., feat, fix, chore) */
  allowedTypes: string[];
  /** Require a scope in conventional commits */
  requireScope: boolean;
  /** Require a body in the commit message */
  requireBody: boolean;
  /** Phrases that are not allowed in commit messages (e.g., "WIP", "TODO") */
  forbiddenPhrases: string[];
}

/**
 * A single validation error or warning
 */
export interface CommitValidationError {
  /** The rule that was violated */
  rule: string;
  /** Human-readable description of the violation */
  message: string;
  /** The line number where the violation occurred (1-based), if applicable */
  line: number | null;
}

/**
 * Result of validating a commit message
 */
export interface CommitValidationResult {
  /** Whether the message passes all rules */
  isValid: boolean;
  /** Errors that must be fixed */
  errors: CommitValidationError[];
  /** Warnings that are advisory */
  warnings: CommitValidationError[];
}

/**
 * Validate a commit message against the provided rules.
 *
 * @param message - The commit message to validate
 * @param rules - The validation rules to apply
 * @returns Validation result with errors and warnings
 */
export async function validateCommitMessage(
  message: string,
  rules: CommitMessageRules,
): Promise<CommandResult<CommitValidationResult>> {
  return invokeCommand<CommitValidationResult>("validate_commit_message", {
    message,
    rules,
  });
}

/**
 * Get the commit message rules for a repository.
 * Returns null if no rules have been configured.
 *
 * @param path - Repository path
 * @returns Commit message rules or null
 */
export async function getCommitMessageRules(
  path: string,
): Promise<CommandResult<CommitMessageRules | null>> {
  return invokeCommand<CommitMessageRules | null>(
    "get_commit_message_rules",
    { path },
  );
}

/**
 * Set the commit message rules for a repository.
 * Rules are stored in .git/gitnado/commit_rules.json.
 *
 * @param path - Repository path
 * @param rules - The rules to set
 * @returns The saved rules
 */
export async function setCommitMessageRules(
  path: string,
  rules: CommitMessageRules,
): Promise<CommandResult<CommitMessageRules>> {
  return invokeCommand<CommitMessageRules>("set_commit_message_rules", {
    path,
    rules,
  });
}

/** A scan of the commits a push of `branch` would publish. */
export interface OutgoingScan {
  branch: string;
  commits: number;
  findings: Array<{ category: string; severity: 'info' | 'warning' | 'error'; message: string; filePath: string | null }>;
  riskLevel: 'low' | 'medium' | 'high';
  /** The outgoing diff exceeded the scan limit; its tail was not scanned. */
  truncated: boolean;
}

/**
 * Scan the commits a push of `branch` would publish (those no remote has yet)
 * for secrets. Local only: the Vibe Check's regex scan, no model.
 */
export async function scanOutgoingChanges(
  path: string,
  branch: string,
): Promise<CommandResult<OutgoingScan>> {
  return invokeCommand<OutgoingScan>("scan_outgoing_changes", { path, branch });
}
