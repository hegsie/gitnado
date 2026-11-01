import { invokeCommand } from "../tauri-api.ts";
import { commitStatsCache, createCacheKey } from "../cache.service.ts";
import type {
  FileHistoryEntry,
  DiffFile,
  RefsByCommit,
  CommitFileEntry,
  CommitStats,
  BlameResult,
  ImageVersions,
} from "../../types/git.types.ts";
import type {
  GetDiffCommand,
  GetDiffWithOptionsCommand,
  DiffWhitespaceMode,
  CommandResult,
} from "../../types/api.types.ts";

/**
 * Diff operations
 */
export async function getDiff(
  args?: GetDiffCommand,
): Promise<CommandResult<DiffFile[]>> {
  return invokeCommand<DiffFile[]>("get_diff", args);
}

/**
 * Get diff with advanced options including whitespace handling,
 * custom context lines, and diff algorithm selection.
 *
 * @param options - Advanced diff options
 * @returns Array of diff files with hunks
 */
export async function getDiffWithOptions(
  options: GetDiffWithOptionsCommand,
): Promise<CommandResult<DiffFile[]>> {
  return invokeCommand<DiffFile[]>("get_diff_with_options", options);
}

/**
 * Per-view diff rendering options shared by the single-file diff commands.
 * Both are optional: omitting them keeps git's defaults (3 context lines, no
 * whitespace ignored).
 */
export interface DiffRenderOptions {
  /** Lines of unchanged context around each hunk. */
  contextLines?: number;
  /** Whitespace handling mode ("none" shows every change). */
  ignoreWhitespace?: DiffWhitespaceMode;
}

export async function getFileDiff(
  repoPath: string,
  filePath: string,
  staged?: boolean,
  maxLines?: number,
  options?: DiffRenderOptions,
): Promise<CommandResult<DiffFile>> {
  return invokeCommand<DiffFile>("get_file_diff", {
    path: repoPath,
    filePath,
    staged,
    maxLines,
    contextLines: options?.contextLines,
    ignoreWhitespace: options?.ignoreWhitespace,
  });
}

export async function getCommitFiles(
  repoPath: string,
  commitOid: string,
): Promise<CommandResult<CommitFileEntry[]>> {
  return invokeCommand<CommitFileEntry[]>("get_commit_files", {
    path: repoPath,
    commitOid,
  });
}

export async function getCommitFileDiff(
  repoPath: string,
  commitOid: string,
  filePath: string,
  maxLines?: number,
  options?: DiffRenderOptions,
): Promise<CommandResult<DiffFile>> {
  return invokeCommand<DiffFile>("get_commit_file_diff", {
    path: repoPath,
    commitOid,
    filePath,
    maxLines,
    contextLines: options?.contextLines,
    ignoreWhitespace: options?.ignoreWhitespace,
  });
}

/**
 * Get stats (additions/deletions) for multiple commits in bulk
 * Optimized for graph view to show commit sizes
 * Uses caching to avoid redundant API calls
 */
export async function getCommitsStats(
  repoPath: string,
  commitOids: string[],
): Promise<CommandResult<CommitStats[]>> {
  // Check cache for already-fetched stats
  const cachedStats: CommitStats[] = [];
  const uncachedOids: string[] = [];

  for (const oid of commitOids) {
    const cacheKey = createCacheKey(repoPath, oid);
    const cached = commitStatsCache.get(cacheKey);
    if (cached) {
      cachedStats.push({
        oid,
        additions: cached.additions,
        deletions: cached.deletions,
        filesChanged: cached.filesChanged,
      });
    } else {
      uncachedOids.push(oid);
    }
  }

  // If all are cached, return immediately
  if (uncachedOids.length === 0) {
    return { success: true, data: cachedStats };
  }

  // Fetch uncached stats
  const result = await invokeCommand<CommitStats[]>("get_commits_stats", {
    path: repoPath,
    commitOids: uncachedOids,
  });

  if (!result.success || !result.data) {
    // Return cached ones even if fetch fails
    if (cachedStats.length > 0) {
      return { success: true, data: cachedStats };
    }
    return result;
  }

  // Cache the new stats
  for (const stat of result.data) {
    const cacheKey = createCacheKey(repoPath, stat.oid);
    commitStatsCache.set(cacheKey, {
      additions: stat.additions,
      deletions: stat.deletions,
      filesChanged: stat.filesChanged,
    });
  }

  // Combine cached and newly fetched
  return {
    success: true,
    data: [...cachedStats, ...result.data],
  };
}

/**
 * Get blame information for a file
 *
 * @param repoPath - Repository path
 * @param filePath - Path to the file to blame
 * @param commitOid - Optional commit to blame at (default: HEAD)
 * @param startLine - Optional start line for range blame (1-indexed)
 * @param endLine - Optional end line for range blame (1-indexed, inclusive)
 */
export async function getFileBlame(
  repoPath: string,
  filePath: string,
  commitOid?: string,
  startLine?: number,
  endLine?: number,
): Promise<CommandResult<BlameResult>> {
  return invokeCommand<BlameResult>("get_file_blame", {
    path: repoPath,
    filePath,
    commitOid,
    startLine,
    endLine,
  });
}

/**
 * Get image versions for comparison (old and new base64-encoded data)
 */
export async function getImageVersions(
  repoPath: string,
  filePath: string,
  staged?: boolean,
  commitOid?: string,
): Promise<CommandResult<ImageVersions>> {
  return invokeCommand<ImageVersions>("get_image_versions", {
    path: repoPath,
    filePath,
    staged,
    commitOid,
  });
}

/**
 * Get all commits that modified a specific file, each paired with the path the
 * file had in that commit (which differs from `filePath` before a rename).
 */
export async function getFileHistory(
  repoPath: string,
  filePath: string,
  limit?: number,
  followRenames?: boolean,
): Promise<CommandResult<FileHistoryEntry[]>> {
  return invokeCommand<FileHistoryEntry[]>("get_file_history", {
    path: repoPath,
    filePath,
    limit,
    followRenames,
  });
}

/**
 * Refs operations
 */
export async function getRefsByCommit(
  path: string,
): Promise<CommandResult<RefsByCommit>> {
  return invokeCommand<RefsByCommit>("get_refs_by_commit", { path });
}

/**
 * Shortlog operations - contributor commit summaries
 */
export interface ShortlogOptions {
  range?: string;
  all?: boolean;
  numbered?: boolean;
  summary?: boolean;
  email?: boolean;
  group?: "author" | "committer";
}

export interface ShortlogEntry {
  name: string;
  email: string | null;
  count: number;
  commits: string[];
}

export interface ShortlogResult {
  entries: ShortlogEntry[];
  totalCommits: number;
  totalContributors: number;
}

/**
 * Get shortlog - contributor commit summaries
 * Similar to `git shortlog`
 */
export async function getShortlog(
  path: string,
  options?: ShortlogOptions,
): Promise<CommandResult<ShortlogResult>> {
  return invokeCommand<ShortlogResult>("shortlog", {
    path,
    range: options?.range,
    all: options?.all,
    numbered: options?.numbered,
    summary: options?.summary,
    email: options?.email,
    group: options?.group,
  });
}


/**
 * Search / Grep operations
 */
export interface SearchResult {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileResult {
  filePath: string;
  matches: SearchResult[];
  matchCount: number;
}

export interface DiffSearchResult {
  commitId: string;
  author: string;
  date: number;
  message: string;
  filePath: string;
  lineContent: string;
}

export async function searchInFiles(
  repoPath: string,
  query: string,
  caseSensitive?: boolean,
  regex?: boolean,
  filePattern?: string,
  maxResults?: number,
): Promise<CommandResult<SearchFileResult[]>> {
  return invokeCommand<SearchFileResult[]>("search_in_files", {
    path: repoPath,
    query,
    caseSensitive,
    regex,
    filePattern,
    maxResults,
  });
}

export async function searchInDiff(
  repoPath: string,
  query: string,
  staged?: boolean,
): Promise<CommandResult<SearchResult[]>> {
  return invokeCommand<SearchResult[]>("search_in_diff", {
    path: repoPath,
    query,
    staged,
  });
}

export async function searchInCommits(
  repoPath: string,
  query: string,
  maxCommits?: number,
): Promise<CommandResult<DiffSearchResult[]>> {
  return invokeCommand<DiffSearchResult[]>("search_in_commits", {
    path: repoPath,
    query,
    maxCommits,
  });
}

export async function searchInCommitMessages(
  repoPath: string,
  query: string,
  maxCommits?: number,
): Promise<CommandResult<DiffSearchResult[]>> {
  return invokeCommand<DiffSearchResult[]>("search_in_commit_messages", {
    path: repoPath,
    query,
    maxCommits,
  });
}

/**
 * A match location within a commit's changes
 */
export interface SearchMatch {
  filePath: string;
  lineNumber: number | null;
  lineContent: string | null;
}

/**
 * A commit returned from content/file search
 */
export interface SearchCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorDate: number;
  matches: SearchMatch[];
}

/**
 * Search for commits that changed specific content (git log -G or -S)
 *
 * This is useful for finding when a specific string or pattern was added,
 * removed, or modified.
 *
 * @param repoPath - Repository path
 * @param searchText - Text to search for in changes
 * @param regex - Treat searchText as a regex pattern (uses git log -G)
 * @param ignoreCase - Case insensitive search
 * @param maxCount - Limit number of results
 */
export async function searchCommitsByContent(
  repoPath: string,
  searchText: string,
  regex?: boolean,
  ignoreCase?: boolean,
  maxCount?: number,
): Promise<CommandResult<SearchCommit[]>> {
  return invokeCommand<SearchCommit[]>("search_commits_by_content", {
    path: repoPath,
    searchText,
    regex,
    ignoreCase,
    maxCount,
  });
}

/**
 * Search for commits that touched files matching a pattern
 *
 * This is useful for finding all commits that modified files matching
 * a glob pattern (e.g., "*.rs", "src/*.ts").
 *
 * @param repoPath - Repository path
 * @param filePattern - Glob pattern to match files (e.g., "*.rs")
 * @param maxCount - Limit number of results
 */
export async function searchCommitsByFile(
  repoPath: string,
  filePattern: string,
  maxCount?: number,
): Promise<CommandResult<SearchCommit[]>> {
  return invokeCommand<SearchCommit[]>("search_commits_by_file", {
    path: repoPath,
    filePattern,
    maxCount,
  });
}


/**
 * Advanced Commit Search
 */

/**
 * Filter criteria for searching commits
 */
export interface CommitFilter {
  author?: string;
  committer?: string;
  message?: string;
  afterDate?: string;
  beforeDate?: string;
  path?: string;
  branch?: string;
  minParents?: number;
  maxParents?: number;
  noMerges?: boolean;
  firstParent?: boolean;
}

/**
 * A commit returned from filtered search results
 */
export interface FilteredCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerDate: number;
  parentCount: number;
  isMerge: boolean;
}

/**
 * Filter commits based on criteria
 */
export async function filterCommits(
  path: string,
  filter: CommitFilter,
  maxCount?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("filter_commits", {
    path,
    filter,
    // Rust parameter is `max_results`; Tauri maps it to the `maxResults` key.
    maxResults: maxCount ?? 500,
  });
}

/**
 * Get commits that differ between two branches
 */
export async function getBranchDiffCommits(
  path: string,
  baseBranch: string,
  compareBranch: string,
  maxCount?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("get_branch_diff_commits", {
    path,
    baseBranch,
    compareBranch,
    // Rust parameter is `max_results`; Tauri maps it to the `maxResults` key.
    maxResults: maxCount ?? 500,
  });
}

/**
 * Get commit history for a specific file
 */
export async function getFileLog(
  path: string,
  filePath: string,
  follow?: boolean,
  maxResults?: number,
): Promise<CommandResult<FilteredCommit[]>> {
  return invokeCommand<FilteredCommit[]>("get_file_log", {
    path,
    filePath,
    follow: follow ?? true,
    maxResults: maxResults ?? 100,
  });
}


// ============================================================================
// Branch Comparison
// ============================================================================

/**
 * Options for branch comparison
 */
export interface BranchComparisonOptions {
  /** Include list of commits ahead/behind */
  includeCommits?: boolean;
  /** Include list of changed files */
  includeFiles?: boolean;
}

/**
 * A commit in the comparison result
 */
export interface CompareCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorDate: number;
}

/**
 * A changed file in the comparison result
 */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  oldPath: string | null;
}

/**
 * Result of comparing two branches/refs
 */
export interface BranchComparison {
  baseRef: string;
  compareRef: string;
  ahead: number;
  behind: number;
  mergeBase: string;
  commitsAhead: CompareCommit[] | null;
  commitsBehind: CompareCommit[] | null;
  filesChanged: ChangedFile[] | null;
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Compare two branches or refs
 * @param path Repository path
 * @param base Base ref (branch/tag/commit)
 * @param compare Comparison ref
 * @param options Comparison options
 * @returns Comparison result with ahead/behind counts, merge base, and optionally commits and files
 */
export async function compareBranches(
  path: string,
  base: string,
  compare: string,
  options?: BranchComparisonOptions,
): Promise<CommandResult<BranchComparison>> {
  return invokeCommand<BranchComparison>("compare_branches", {
    path,
    base,
    compare,
    includeCommits: options?.includeCommits ?? false,
    includeFiles: options?.includeFiles ?? false,
  });
}

// ============================================================================
// External Diff Tool
// ============================================================================

/**
 * Diff tool configuration
 */
export interface DiffToolConfig {
  /** Name of the configured diff tool */
  tool: string | null;
  /** Custom command for the diff tool */
  cmd: string | null;
  /** Whether to prompt before launching the diff tool */
  prompt: boolean;
}

/**
 * Information about an available diff tool
 */
export interface AvailableDiffTool {
  /** Tool identifier name */
  name: string;
  /** Command used to launch the tool */
  command: string;
  /** Whether the tool is available on the system */
  available: boolean;
}

/**
 * Result of launching a diff tool
 */
export interface DiffToolResult {
  /** Whether the diff tool exited successfully */
  success: boolean;
  /** Output or error message from the diff tool */
  message: string;
}

/**
 * Get the current diff tool configuration
 * @param path Repository path
 * @param global Whether to read from global config instead of local
 * @returns Diff tool configuration
 */
export async function getDiffToolConfig(
  path: string,
  global?: boolean,
): Promise<CommandResult<DiffToolConfig>> {
  return invokeCommand<DiffToolConfig>("get_diff_tool", {
    path,
    global,
  });
}

/**
 * Set the diff tool configuration
 * @param path Repository path
 * @param tool Tool name (e.g., "vscode", "meld", "kdiff3", "beyond")
 * @param cmd Custom command (optional, if not using standard tool)
 * @param global Whether to set in global config
 */
export async function setDiffTool(
  path: string,
  tool: string,
  cmd?: string,
  global?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_diff_tool", {
    path,
    tool,
    cmd,
    global,
  });
}

/**
 * List available diff tools with their availability status
 * @param path Repository path
 * @returns List of available diff tools
 */
export async function listDiffTools(
  path: string,
): Promise<CommandResult<AvailableDiffTool[]>> {
  return invokeCommand<AvailableDiffTool[]>("list_diff_tools", {
    path,
  });
}

/**
 * Launch the external diff tool for a specific file
 * @param path Repository path
 * @param filePath File to diff (relative to repo root)
 * @param staged If true, compare staged changes (index vs HEAD)
 * @param commit If provided, compare against this commit
 * @returns Result of launching the diff tool
 */
export async function launchDiffTool(
  path: string,
  filePath: string,
  staged?: boolean,
  commit?: string,
): Promise<CommandResult<DiffToolResult>> {
  return invokeCommand<DiffToolResult>("launch_diff_tool", {
    path,
    filePath,
    staged,
    commit,
  });
}

