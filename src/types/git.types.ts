/**
 * Git-related type definitions
 */

export interface Repository {
  path: string;
  name: string;
  isValid: boolean;
  isBare: boolean;
  headRef: string | null;
  /**
   * Commit HEAD points at when detached; null when HEAD is on a branch or
   * unborn. `headRef` is the literal 'HEAD' while detached, so it names no
   * commit.
   */
  detachedHeadOid: string | null;
  state: RepositoryState;
  isShallow: boolean;
  isPartialClone: boolean;
  cloneFilter: string | null;
}

export type RepositoryState =
  | 'clean'
  | 'merge'
  | 'revert'
  | 'cherrypick'
  | 'bisect'
  | 'rebase'
  | 'rebase-interactive'
  | 'rebase-merge'
  | 'apply-mailbox'
  | 'apply-mailbox-or-rebase';

export interface CloneFilterInfo {
  isPartialClone: boolean;
  filter: string | null;
  promisorRemote: string | null;
}

export interface Commit {
  oid: string;
  shortId: string;
  message: string;
  summary: string;
  body: string | null;
  author: Signature;
  committer: Signature;
  parentIds: string[];
  timestamp: number;
  /**
   * The path the subject file had AT this commit. Only set by path-scoped
   * walks (getFileHistory) — with rename following on, the commits before a
   * rename hold the file under its OLD name, so acting on one has to use this
   * rather than the file's current path. Absent everywhere else.
   */
  path?: string;
}

/** One entry of a file's history: a commit plus the path the file had there. */
export interface FileHistoryEntry {
  commit: Commit;
  /**
   * Path the file had in that commit. Differs from the file's current path for
   * commits older than a rename — diffing or blaming those under the current
   * path fails, because the file did not exist under that name yet.
   */
  pathAtCommit: string;
}

export interface Signature {
  name: string;
  email: string;
  timestamp: number;
}

export interface Branch {
  name: string;
  shorthand: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  targetOid: string;
  aheadBehind?: AheadBehind;
  /** Unix timestamp of the last commit on this branch */
  lastCommitTimestamp?: number;
  /** Whether this branch is considered stale (no commits in 90+ days) */
  isStale: boolean;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** Detailed branch tracking information */
export interface BranchTrackingInfo {
  /** The local branch name */
  localBranch: string;
  /** The full upstream reference (e.g., "refs/remotes/origin/main") */
  upstream: string | null;
  /** Number of commits ahead of upstream */
  ahead: number;
  /** Number of commits behind upstream */
  behind: number;
  /** The remote name (e.g., "origin") */
  remote: string | null;
  /** The remote branch name (e.g., "main") */
  remoteBranch: string | null;
  /** Whether the upstream branch was deleted */
  isGone: boolean;
}

export interface Remote {
  name: string;
  url: string;
  pushUrl: string | null;
}

export interface Tag {
  name: string;
  targetOid: string;
  message: string | null;
  tagger: Signature | null;
  isAnnotated: boolean;
}

export interface TagDetails {
  name: string;
  oid: string;
  targetOid: string;
  isAnnotated: boolean;
  message: string | null;
  taggerName: string | null;
  taggerEmail: string | null;
  taggerDate: number | null;
  isSigned: boolean;
}

export type RefType = 'localBranch' | 'remoteBranch' | 'tag' | 'detachedHead';

export interface RefInfo {
  name: string;
  shorthand: string;
  refType: RefType;
  isHead: boolean;
  /** For tags: whether the tag is annotated (has message/tagger) */
  isAnnotated?: boolean;
  /** For tags: the tag message (if annotated) */
  tagMessage?: string;
}

/** Map of commit OID to refs pointing to it */
export type RefsByCommit = Record<string, RefInfo[]>;

export interface Stash {
  index: number;
  message: string;
  oid: string;
}

export interface StashFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface StashShowResult {
  index: number;
  /** The stash commit this result describes — see the Rust field's note. */
  oid: string;
  message: string;
  files: StashFile[];
  totalAdditions: number;
  totalDeletions: number;
  patch: string | null;
}

export interface RebaseCommit {
  oid: string;
  shortId: string;
  summary: string;
  /** Everything after the subject line; '' when the commit has none. */
  body: string;
  action: string;
}

/**
 * The commits `git rebase -i` would list for a range, plus how many merge
 * commits the range contained.
 *
 * Merges are omitted from the todo, but the count must reach the UI: replaying
 * a plan over a range containing merges flattens the topology and rewrites the
 * merged-in side commits.
 */
export interface RebasePlan {
  commits: RebaseCommit[];
  /** Merge commits in the range, excluded from `commits`. */
  mergeCount: number;
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

/**
 * Represents the current state of an interactive rebase
 */
export interface RebaseState {
  inProgress: boolean;
  headName: string | null;
  onto: string | null;
  currentCommit: string | null;
  doneCount: number;
  totalCount: number;
  hasConflicts: boolean;
}

/**
 * Represents an entry in the rebase todo list
 */
export interface RebaseTodoEntry {
  action: string;
  commitOid: string;
  commitShort: string;
  message: string;
}

/**
 * Represents the full rebase todo state
 */
export interface RebaseTodo {
  entries: RebaseTodoEntry[];
  done: RebaseTodoEntry[];
}

/**
 * Result of a squash operation
 */
export interface SquashResult {
  newOid: string;
  squashedCount: number;
  success: boolean;
}

/**
 * Result of a drop commit operation
 */
export interface DropCommitResult {
  success: boolean;
  newTip: string;
  hasConflicts: boolean;
  droppedMessage: string;
}

/**
 * Result of a commit reorder operation
 */
export interface ReorderResult {
  success: boolean;
  newTip: string;
  reorderedCount: number;
  hasConflicts: boolean;
}

export interface StatusEntry {
  path: string;
  status: FileStatus;
  isStaged: boolean;
  isConflicted: boolean;
}

export type FileStatus =
  | 'new'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'ignored'
  | 'untracked'
  | 'typechange'
  | 'conflicted';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  hunks: DiffHunk[];
  isBinary: boolean;
  isImage: boolean;
  imageType: string | null;
  additions: number;
  deletions: number;
  truncated?: boolean;
  totalLines?: number;
}

export interface ImageVersions {
  path: string;
  oldData: string | null;
  newData: string | null;
  oldSize: [number, number] | null;
  newSize: [number, number] | null;
  imageType: string | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  content: string;
  origin: DiffLineOrigin;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export type DiffLineOrigin =
  | 'context'
  | 'addition'
  | 'deletion'
  | 'context-eofnl'
  | 'add-eofnl'
  | 'del-eofnl'
  | 'file-header'
  | 'hunk-header'
  | 'binary';

/**
 * Partial staging types
 */
export interface FileHunks {
  filePath: string;
  hunks: IndexedDiffHunk[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface IndexedDiffHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: HunkDiffLine[];
  isStaged: boolean;
}

export interface HunkDiffLine {
  lineType: string;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface CommitFileEntry {
  path: string;
  /** For a renamed/copied file, the previous path; `null` otherwise. */
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface CommitStats {
  oid: string;
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface ReflogEntry {
  oid: string;
  shortId: string;
  index: number;
  action: string;
  message: string;
  timestamp: number;
  author: string;
}

export interface UndoAction {
  actionType: string;
  description: string;
  timestamp: number;
  beforeRef: string;
  afterRef: string;
  details: string | null;
}

export interface UndoHistory {
  actions: UndoAction[];
  currentIndex: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface BlameLine {
  lineNumber: number;
  content: string;
  commitOid: string;
  commitShortId: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  summary: string;
  isBoundary: boolean;
}

export interface BlameResult {
  path: string;
  lines: BlameLine[];
  totalLines: number;
}

export interface ConflictFile {
  path: string;
  ancestor: ConflictEntry | null;
  ours: ConflictEntry | null;
  theirs: ConflictEntry | null;
  /** True when any side of the conflict is binary — must not be edited as text */
  isBinary: boolean;
  /**
   * True when any side is a submodule (gitlink) pointer. Its entry OIDs
   * are COMMITS, not blobs — no side content can be read, and resolving
   * stages the chosen commit pointer directly.
   */
  isSubmodule?: boolean;
  /**
   * Marker size the conflict hunks in this file were written with (git's
   * default is 7; the conflict-marker-size gitattribute raises it). The
   * backend verifies the attribute against the file's actual emission, so
   * the parser must use this exact size — never guess from content.
   */
  markerSize?: number;
  /**
   * Conflict style the hunks were written with. Only when this is 'diff3'
   * may a `|||||||` run be treated as a base-section marker — in the
   * default 'merge' style it is ours CONTENT, and discarding it would
   * silently lose lines.
   */
  conflictStyle?: 'merge' | 'diff3';
  /**
   * AUTHORITATIVE marker positions (0-based working-file line indices)
   * from the backend's collision-free replay. When present the parser
   * uses them directly — content quoting marker lines (even byte-identical
   * to the real ones) can never confuse position-based parsing. Empty for
   * hand-edited files (no replay match), where validated shape heuristics
   * take over.
   */
  conflictHunks?: ConflictHunk[];
}

/** One conflict hunk's marker line positions in the working file. */
export interface ConflictHunk {
  start: number;
  separator: number;
  end: number;
  base?: number | null;
}

export interface ConflictEntry {
  oid: string;
  path: string;
  mode: number;
}

/**
 * File with conflict markers detected in its content
 */
export interface ConflictMarkerFile {
  /** File path relative to repository root */
  path: string;
  /** Number of conflict regions in the file */
  conflictCount: number;
  /** Details of each conflict marker region */
  markers: ConflictMarker[];
}

/**
 * A single conflict marker region in a file
 */
export interface ConflictMarker {
  /** Line number where the conflict starts (<<<<<<< marker) */
  startLine: number;
  /** Line number of the separator (=======) */
  separatorLine: number;
  /** Line number where the conflict ends (>>>>>>> marker) */
  endLine: number;
  /** Content from our side (between <<<<<<< and =======) */
  oursContent: string;
  /** Content from their side (between ======= and >>>>>>>) */
  theirsContent: string;
  /** Content from base version if diff3 style (between ||||||| and =======) */
  baseContent: string | null;
}

/**
 * Detailed information about conflicts in a file including ref names
 */
export interface ConflictDetails {
  /** File path relative to repository root */
  filePath: string;
  /** Name of our ref (current branch or HEAD) */
  ourRef: string;
  /** Name of their ref (incoming branch) */
  theirRef: string;
  /** Name of base ref if available */
  baseRef: string | null;
  /** Conflict markers found in the file */
  markers: ConflictMarker[];
}

export interface Submodule {
  name: string;
  path: string;
  url: string;
  headId: string | null;
  status: SubmoduleStatus;
}

export type SubmoduleStatus =
  | 'clean'
  | 'dirty'
  | 'uninitialized'
  | 'modified'
  | 'untracked';

/**
 * Avatar info returned from the backend
 */
export interface AvatarInfo {
  email: string;
  gravatarUrl: string;
  initials: string;
  color: string;
}

/**
 * Result of viewing or checking out a file at a specific commit
 */
export interface FileAtCommitResult {
  filePath: string;
  commitOid: string;
  content: string;
  isBinary: boolean;
  size: number;
}

/**
 * File encoding detection information
 */
export interface FileEncodingInfo {
  /** Relative path of the file */
  filePath: string;
  /** Detected encoding name (e.g., "UTF-8", "UTF-16LE", "Shift_JIS") */
  encoding: string;
  /** Detection confidence from 0.0 to 1.0 */
  confidence: number;
  /** Whether the file has a byte order mark */
  hasBom: boolean;
  /** Line ending style: "LF", "CRLF", "CR", "Mixed", or "N/A" */
  lineEnding: string;
  /** Whether the file appears to be binary */
  isBinary: boolean;
}

/**
 * Result of a file encoding conversion
 */
export interface ConvertEncodingResult {
  success: boolean;
  sourceEncoding: string;
  targetEncoding: string;
  bytesWritten: number;
}

/**
 * Sorted file status result with summary counts
 */
export interface SortedFileStatus {
  files: SortedStatusEntry[];
  totalCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
}

/**
 * A status entry enriched with sorting-related metadata
 */
export interface SortedStatusEntry {
  path: string;
  filename: string;
  directory: string;
  extension: string | null;
  status: string;
  isStaged: boolean;
  isConflicted: boolean;
}

/**
 * Sort options for file tree sorting
 */
export type FileStatusSortBy = 'name' | 'status' | 'path' | 'extension';

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc';

/**
 * A branch that is a candidate for cleanup, returned by the backend.
 * Uses graph_descendant_of for accurate merge detection.
 */
export interface CleanupCandidate {
  name: string;
  shorthand: string;
  category: 'merged' | 'stale' | 'gone';
  lastCommitTimestamp: number | null;
  isProtected: boolean;
  upstream: string | null;
  aheadBehind: AheadBehind | null;
}

/**
 * One branch in a stack of dependent branches (see `get_stacks`).
 */
export interface StackBranch {
  name: string;
  /** The branch this one is stacked on. */
  parent: string;
  /** 1 for a branch directly on the stack's base, 2 above that, … */
  depth: number;
  /** Commits on this branch its parent does not have. */
  ahead: number;
  /** Commits on the parent this branch lacks: > 0 means it needs a restack. */
  behind: number;
  isHead: boolean;
  /** The parent branch no longer exists. */
  parentMissing: boolean;
}

/** A base branch and the branches stacked on it, bottom to top. */
export interface Stack {
  base: string;
  branches: StackBranch[];
}

/**
 * A workspace grouping related repositories
 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string;
  repositories: WorkspaceRepository[];
  createdAt: string;
  lastOpened: string | null;
}

/**
 * A repository within a workspace
 */
export interface WorkspaceRepository {
  path: string;
  name: string;
}

/**
 * Status information for a repository within a workspace
 */
export interface WorkspaceRepoStatus {
  path: string;
  name: string;
  exists: boolean;
  isValidRepo: boolean;
  changedFilesCount: number;
  currentBranch: string | null;
  isDetached: boolean;
  ahead: number;
  behind: number;
}

/**
 * A search result from workspace-level search across repos
 */
export interface WorkspaceSearchResult {
  repoName: string;
  repoPath: string;
  filePath: string;
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  failures: string[];
}
