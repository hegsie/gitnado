/**
 * API and IPC type definitions
 */

/**
 * Tauri command response wrapper
 */
export interface CommandResult<T> {
  success: boolean;
  data?: T;
  error?: CommandError;
}

export interface CommandError {
  code: string;
  message: string;
  details?: string;
}

/**
 * Repository commands
 */
export interface OpenRepositoryCommand {
  path: string;
}

export interface CloneRepositoryCommand {
  url: string;
  path: string;
  /*
   * The backend also accepts `bare`, and it is deliberately NOT declared here.
   * A bare clone has no working tree, and nothing in this app branches on
   * `Repository.isBare`: staging, the diff, file status and the commit panel
   * would all be operating on a repository that cannot have any of them. Until
   * the UI can present a bare repository honestly, offering the option would
   * only produce a broken window.
   */
  /** Clone and check out this branch instead of the remote's default. */
  branch?: string;
  token?: string;
  depth?: number;
  filter?: string;
  singleBranch?: boolean;
  timeoutSecs?: number;
}

export interface InitRepositoryCommand {
  path: string;
  bare?: boolean;
  /** Name for the repository's first branch. Omit to use git's own default. */
  initialBranch?: string;
}

/**
 * Branch commands
 */
export interface CreateBranchCommand {
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export interface DeleteBranchCommand {
  name: string;
  force?: boolean;
}

export interface RenameBranchCommand {
  oldName: string;
  newName: string;
  updateTracking?: boolean;
}

export interface CheckoutCommand {
  refName: string;
  force?: boolean;
}

export interface SetUpstreamBranchCommand {
  branch: string;
  upstream: string;
}

export interface UnsetUpstreamBranchCommand {
  branch: string;
}

export interface GetBranchTrackingInfoCommand {
  branch: string;
}

/**
 * Commit commands
 */
export interface CreateCommitCommand {
  message: string;
  amend?: boolean;
  /** Sign the commit with GPG. If not provided, uses repository's commit.gpgsign setting. */
  signCommit?: boolean;
  /** Allow creating a commit with no staged changes. */
  allowEmpty?: boolean;
  /** Author date in ISO 8601 format (e.g., "2024-01-15T10:30:00Z") or unix timestamp. */
  authorDate?: string;
  /** Committer date in ISO 8601 format (e.g., "2024-01-15T10:30:00Z") or unix timestamp. */
  committerDate?: string;
}

export interface CreateOrphanBranchCommand {
  name: string;
  checkout: boolean;
}

export interface GetCommitCommand {
  oid: string;
}

export interface GetCommitHistoryCommand {
  path: string;
  startOid?: string;
  limit?: number;
  skip?: number;
  /** Load commits from all branches, not just HEAD */
  allBranches?: boolean;
}

export interface AmendCommitCommand {
  /** New commit message. If not provided, keeps the original message. */
  message?: string;
  /** Reset the author to current user. */
  resetAuthor?: boolean;
  /** Sign the amended commit with GPG. If not provided, uses repository's commit.gpgsign setting. */
  signAmend?: boolean;
}

/**
 * Signing status for a repository
 */
export interface SigningStatus {
  /** Whether commit signing is enabled (commit.gpgsign = true) */
  gpgSignEnabled: boolean;
  /** The configured signing key (user.signingkey) */
  signingKey: string | null;
  /** The configured GPG program (gpg.program) */
  gpgProgram: string | null;
  /** Whether signing is possible (GPG available and key configured) */
  canSign: boolean;
}

export interface RewordCommitCommand {
  /** The OID of the commit to reword. */
  oid: string;
  /** The new commit message. */
  message: string;
}

export interface EditCommitDateCommand {
  /** The OID of the commit to edit. */
  oid: string;
  /** New author date in ISO 8601 format (e.g., "2024-01-15T10:30:00Z") or unix timestamp. */
  authorDate?: string;
  /** New committer date in ISO 8601 format (e.g., "2024-01-15T10:30:00Z") or unix timestamp. */
  committerDate?: string;
}

export interface AmendResult {
  newOid: string;
  oldOid: string;
  success: boolean;
}

/**
 * Staging commands
 */
export interface StageFilesCommand {
  paths: string[];
}

export interface UnstageFilesCommand {
  paths: string[];
}

export interface DiscardChangesCommand {
  paths: string[];
}

/**
 * Remote commands
 */
export interface FetchCommand {
  path: string;
  remote?: string;
  prune?: boolean;
  token?: string;
  timeoutSecs?: number;
  /** Suppress the success event a user-initiated fetch emits. Set by the
   *  window-focus background fetch, which must not toast. */
  quiet?: boolean;
  /** The progress row's id, from `progressService.startOperation`. Registers
   *  the fetch with the backend cancellation registry so the row's Cancel
   *  button can stop it, and addresses the `operation-progress` events it
   *  emits back to that row. Omitted by unattended callers, which have no row
   *  and must not be cancellable. */
  operationId?: string;
}

export interface PullCommand {
  path: string;
  remote?: string;
  branch?: string;
  rebase?: boolean;
  token?: string;
  timeoutSecs?: number;
  /** See `FetchCommand.operationId`. A pull can only be cancelled during its
   *  fetch phase — once the merge or rebase starts it runs to completion. */
  operationId?: string;
}

export interface PushCommand {
  path: string;
  remote?: string;
  branch?: string;
  force?: boolean;
  forceWithLease?: boolean;
  pushTags?: boolean;
  setUpstream?: boolean;
  token?: string;
  timeoutSecs?: number;
  /** See `FetchCommand.operationId`. */
  operationId?: string;
}

export interface PushToMultipleRemotesCommand {
  path: string;
  remotes: string[];
  branch?: string;
  force: boolean;
  forceWithLease: boolean;
  pushTags: boolean;
  token?: string;
}

/**
 * Result of pushing to multiple remotes
 */
export interface MultiPushResult {
  results: RemotePushResult[];
  totalSuccess: number;
  totalFailed: number;
}

/**
 * Result of pushing to a single remote (used in multi-push)
 */
export interface RemotePushResult {
  remote: string;
  success: boolean;
  message?: string;
}

export interface FetchAllRemotesCommand {
  path: string;
  prune: boolean;
  tags: boolean;
  token?: string;
}

export interface GetFetchStatusCommand {
  path: string;
}

/**
 * Result of fetching all remotes
 */
export interface FetchAllResult {
  remotes: RemoteFetchResult[];
  success: boolean;
  totalFetched: number;
  totalFailed: number;
}

/**
 * Result of fetching a single remote
 */
export interface RemoteFetchResult {
  remote: string;
  success: boolean;
  message?: string;
  refsUpdated: number;
}

/**
 * Status of a remote for fetch operations
 */
export interface RemoteFetchStatus {
  remote: string;
  url: string;
  lastFetch?: number;
  branches: string[];
}

/**
 * Merge commands
 */
export interface MergeCommand {
  path: string;
  sourceRef: string;
  noFf?: boolean;
  squash?: boolean;
  message?: string;
}

export interface AbortMergeCommand {
  path: string;
}

/**
 * Rebase commands
 */
export interface RebaseCommand {
  path: string;
  onto: string;
}

export interface ContinueRebaseCommand {
  path: string;
}

export interface AbortRebaseCommand {
  path: string;
}

export interface GetRebaseStateCommand {
  path: string;
}

export interface GetRebaseTodoCommand {
  path: string;
}

export interface UpdateRebaseTodoCommand {
  path: string;
  entries: import('./git.types.ts').RebaseTodoEntry[];
}

export interface SkipRebaseCommitCommand {
  path: string;
}

/**
 * Cherry-pick commands
 */
export interface CherryPickCommand {
  path: string;
  commitOid: string;
  /** If true, stages changes without committing (like `git cherry-pick -n`) */
  noCommit?: boolean;
  /**
   * For a merge commit, which parent (1-based) to cherry-pick relative to
   * (`git cherry-pick -m`). The backend requires this when the target has more
   * than one parent; ignored for non-merge commits.
   */
  mainline?: number;
}

export interface ContinueCherryPickCommand {
  path: string;
}

export interface AbortCherryPickCommand {
  path: string;
}

export interface SkipCherryPickCommand {
  path: string;
}

export interface CherryPickFromBranchCommand {
  path: string;
  branch: string;
  count?: number;
}

/**
 * Revert commands
 */
export interface RevertCommand {
  path: string;
  commitOid: string;
  /**
   * For a merge commit, which parent (1-based) to revert relative to
   * (`git revert -m`). The backend requires this when the target has more than
   * one parent; ignored for non-merge commits.
   */
  mainline?: number;
}

export interface ContinueRevertCommand {
  path: string;
}

export interface AbortRevertCommand {
  path: string;
}

export interface SkipRevertCommand {
  path: string;
}

/**
 * Reset commands
 */
export interface ResetCommand {
  path: string;
  targetRef: string;
  mode: "soft" | "mixed" | "hard";
}

/**
 * Squash commands
 */
export interface SquashCommitsCommand {
  path: string;
  fromOid: string;
  toOid: string;
  message: string;
}

export interface FixupCommitCommand {
  path: string;
  targetOid: string;
  amendMessage?: string;
}

/**
 * Stash commands
 */
export interface CreateStashCommand {
  path: string;
  message?: string;
  includeUntracked?: boolean;
}

export interface ApplyStashCommand {
  path: string;
  index: number;
  dropAfter?: boolean;
}

export interface DropStashCommand {
  path: string;
  index: number;
}

export interface PopStashCommand {
  path: string;
  index: number;
}

export interface StashShowCommand {
  path: string;
  index: number;
  stat?: boolean;
  patch?: boolean;
}

/**
 * Tag commands
 */
export interface CreateTagCommand {
  path: string;
  name: string;
  target?: string;
  message?: string;
}

export interface DeleteTagCommand {
  path: string;
  name: string;
}

/** Outcome of an interactive rebase run. `git rebase -i` exits 0 both when the
 * plan completes and when it stops at an `edit`/`break` line, so the backend
 * reports which happened. */
export interface InteractiveRebaseOutcome {
  /** True when the rebase stopped at a breakpoint and the repo is still
   * mid-rebase awaiting `git rebase --continue`. */
  paused: boolean;
}

export interface PushTagCommand {
  path: string;
  name: string;
  remote?: string;
  force?: boolean;
  token?: string;
}

export interface DeleteRemoteTagCommand {
  path: string;
  name: string;
  remote?: string;
  token?: string;
}

export interface GetTagDetailsCommand {
  path: string;
  name: string;
}

export interface EditTagMessageCommand {
  path: string;
  name: string;
  message: string;
}

/**
 * Describe commands
 */
export interface DescribeOptions {
  /** Commit to describe (defaults to HEAD) */
  commitish?: string;
  /** Include lightweight tags (--tags flag) */
  tags?: boolean;
  /** Use any ref (--all flag) */
  all?: boolean;
  /** Always output long format (--long flag) */
  long?: boolean;
  /** Set abbrev length (--abbrev=N) */
  abbrev?: number;
  /** Pattern to match tags (--match) */
  matchPattern?: string;
  /** Pattern to exclude tags (--exclude) */
  excludePattern?: string;
  /** Follow only first parent (--first-parent) */
  firstParent?: boolean;
  /** Describe working tree, append -dirty if dirty (--dirty) */
  dirty?: boolean;
}

export interface DescribeResult {
  /** The full describe string (e.g., "v1.0.0-5-gabcdef1") */
  description: string;
  /** The tag name if found */
  tag: string | null;
  /** Number of commits ahead of the tag (if any) */
  commitsAhead: number | null;
  /** The abbreviated commit hash (if not exactly on a tag) */
  commitHash: string | null;
  /** Whether the working tree is dirty */
  isDirty: boolean;
}

/**
 * Diff commands
 */
export interface GetDiffCommand {
  path?: string;
  staged?: boolean;
  commit?: string;
  compareWith?: string;
}

/**
 * Whitespace handling mode for diffs.
 * - "all":    Ignore all whitespace changes (-w)
 * - "change": Ignore changes in amount of whitespace (-b)
 * - "eol":    Ignore whitespace at end of line (--ignore-space-at-eol)
 * - "none":   Don't ignore any whitespace (default)
 */
export type DiffWhitespaceMode = "all" | "change" | "eol" | "none";

/**
 * Advanced diff options command - supports whitespace handling, context lines,
 * and diff algorithm selection.
 */
export interface GetDiffWithOptionsCommand {
  path: string;
  filePath?: string;
  staged?: boolean;
  commit?: string;
  compareWith?: string;
  /** Number of context lines to show around changes (default: 3) */
  contextLines?: number;
  /** Whitespace handling mode */
  ignoreWhitespace?: DiffWhitespaceMode;
  /** Use patience diff algorithm */
  patience?: boolean;
  /** Use histogram diff algorithm (approximated via minimal) */
  histogram?: boolean;
}

/**
 * Event payloads
 */
export interface RepositoryChangedEvent {
  path: string;
  changeType: "status" | "index" | "refs" | "config";
}

export interface OperationProgressEvent {
  operation: string;
  current: number;
  total: number;
  message?: string;
}

export interface OperationCompleteEvent {
  operation: string;
  success: boolean;
  message?: string;
}

/**
 * Settings
 */
export interface AppSettings {
  theme: "light" | "dark" | "system";
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: boolean;
  showLineNumbers: boolean;
  autoFetch: boolean;
  autoFetchInterval: number;
  confirmBeforeDelete: boolean;
  gpgSign: boolean;
  defaultRemote: string;
}

export interface GitSettings {
  userName: string;
  userEmail: string;
  defaultBranch: string;
  autoStash: boolean;
  pruneOnFetch: boolean;
  rebaseOnPull: boolean;
}

/**
 * Avatar commands
 */
export interface GetAvatarUrlCommand {
  email: string;
  size?: number;
}

export interface GetAvatarUrlsCommand {
  emails: string[];
  size?: number;
}

/**
 * Checkout file commands
 */
export interface CheckoutFileFromCommitCommand {
  filePath: string;
  commit: string;
}

export interface CheckoutFileFromBranchCommand {
  filePath: string;
  branch: string;
}

export interface GetFileAtCommitCommand {
  filePath: string;
  commit: string;
}

/**
 * Maintenance commands
 */
export interface RunGcCommand {
  path: string;
  /** Run more thorough but slower garbage collection */
  aggressive?: boolean;
  /** Prune objects older than this date (e.g., "2.weeks.ago", "now") */
  prune?: string;
  /** Only run gc if needed (based on heuristics) */
  auto?: boolean;
}

export interface RunFsckCommand {
  path: string;
  /** Run a more thorough check */
  full?: boolean;
}

export interface RunPruneCommand {
  path: string;
  /** Show what would be pruned without actually pruning */
  dryRun?: boolean;
}

export interface MaintenanceResult {
  success: boolean;
  message: string;
}
