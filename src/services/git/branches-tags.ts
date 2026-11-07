import { invokeCommand } from "../tauri-api.ts";
import { settingsStore } from "../../stores/settings.store.ts";
import type {
  Commit,
  Branch,
  BranchTrackingInfo,
  Tag,
  TagDetails,
  Stash,
  StashShowResult,
  SquashResult,
  DropCommitResult,
  ReorderResult,
  ReflogEntry,
  UndoAction,
  UndoHistory,
  CleanupCandidate,
  Stack,
  RestackPlan,
} from "../../types/git.types.ts";
import type {
  CreateBranchCommand,
  CreateOrphanBranchCommand,
  RenameBranchCommand,
  CheckoutCommand,
  CherryPickCommand,
  ContinueCherryPickCommand,
  AbortCherryPickCommand,
  SkipCherryPickCommand,
  CherryPickFromBranchCommand,
  RevertCommand,
  ContinueRevertCommand,
  AbortRevertCommand,
  SkipRevertCommand,
  ResetCommand,
  CreateStashCommand,
  ApplyStashCommand,
  DropStashCommand,
  PopStashCommand,
  StashShowCommand,
  CreateTagCommand,
  DeleteTagCommand,
  PushTagCommand,
  DeleteRemoteTagCommand,
  DeleteRemoteBranchCommand,
  GetTagDetailsCommand,
  EditTagMessageCommand,
  DescribeOptions,
  DescribeResult,
  CommandResult,
} from "../../types/api.types.ts";
import {
  blockedResult,
  checkNetworkPermission,
  getPushUrlToken,
  getRepoToken,
  resolveRemotePushUrl,
  surfaceBackendRefusal,
} from "./shared.ts";

/**
 * Branch operations
 */
export async function getBranches(
  path: string,
): Promise<CommandResult<Branch[]>> {
  return invokeCommand<Branch[]>("get_branches", { path });
}

export async function createBranch(
  path: string,
  args: CreateBranchCommand,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("create_branch", { path, ...args });
}

/**
 * Create an orphan branch (a branch with no parent commits).
 *
 * `checkout` must be true. An orphan branch has no commits, so it is not a ref
 * until its first commit is made — git cannot create one without switching to
 * it, and the backend refuses `checkout: false` rather than stranding HEAD on
 * an unborn branch.
 */
export async function createOrphanBranch(
  path: string,
  args: CreateOrphanBranchCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("create_orphan_branch", { path, ...args });
}

export async function deleteBranch(
  path: string,
  name: string,
  force?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_branch", { path, name, force });
}

export async function deleteRemoteBranch(
  args: DeleteRemoteBranchCommand,
): Promise<CommandResult<void>> {
  const pushUrl = args.remote ? await resolveRemotePushUrl(args.path, args.remote) : null;
  if (!await checkNetworkPermission('delete remote branch', args.path, args.remote, pushUrl)) {
    return blockedResult();
  }

  if (!args.token) {
    let token: string | undefined;
    if (args.remote && pushUrl) {
      token = await getPushUrlToken(args.path, args.remote, pushUrl);
    } else {
      token = await getRepoToken(args.path, args.remote);
    }
    if (token) {
      args = { ...args, token };
    }
  }

  return surfaceBackendRefusal(
    await invokeCommand<void>("delete_remote_branch", args),
  );
}

/**
 * Get branches that are candidates for cleanup (merged, stale, gone).
 * Merge detection is server-side: ancestry plus rebase-/squash-merge detection
 * (patch-id and tree comparison), reported per candidate as `mergeKind`.
 */
export async function getCleanupCandidates(
  path: string,
  staleDays?: number,
): Promise<CommandResult<CleanupCandidate[]>> {
  return invokeCommand<CleanupCandidate[]>("get_cleanup_candidates", {
    path,
    staleDays,
  });
}

export async function renameBranch(
  path: string,
  args: RenameBranchCommand,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("rename_branch", { path, ...args });
}

export async function checkout(
  path: string,
  args: CheckoutCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("checkout", { path, ...args });
}

/**
 * Set the upstream branch for a local branch
 */
export async function setUpstreamBranch(
  path: string,
  branch: string,
  upstream: string,
): Promise<CommandResult<BranchTrackingInfo>> {
  return invokeCommand<BranchTrackingInfo>("set_upstream_branch", {
    path,
    branch,
    upstream,
  });
}

/**
 * Remove the upstream tracking for a local branch
 */
export async function unsetUpstreamBranch(
  path: string,
  branch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("unset_upstream_branch", { path, branch });
}

/**
 * Declare `branch` as stacked on `parent` (stored in the repository config).
 */
export async function setBranchParent(
  path: string,
  branch: string,
  parent: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("set_branch_parent", { path, branch, parent });
}

/**
 * Take `branch` out of its stack. Branches stacked on it keep their parent.
 */
export async function clearBranchParent(
  path: string,
  branch: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("clear_branch_parent", { path, branch });
}

/**
 * Every stack of dependent branches in the repository, bottom to top.
 */
export async function getStacks(
  path: string,
): Promise<CommandResult<Stack[]>> {
  return invokeCommand<Stack[]>("get_stacks", { path });
}

/**
 * Predict restacking the stack based on `base` (a ghost run that changes
 * nothing): per branch, whether it is up to date, replays cleanly, conflicts
 * or is already merged.
 */
export async function previewRestack(
  path: string,
  base: string,
): Promise<CommandResult<RestackPlan>> {
  return invokeCommand<RestackPlan>("preview_restack", { path, base });
}

/**
 * Replay every branch of the stack based on `base` onto its parent's tip.
 * All-or-nothing: a conflict anywhere changes nothing.
 */
export async function restackStack(
  path: string,
  base: string,
): Promise<CommandResult<RestackPlan>> {
  return invokeCommand<RestackPlan>("restack", { path, base });
}

/**
 * Get detailed tracking information for a branch
 */
export async function getBranchTrackingInfo(
  path: string,
  branch: string,
): Promise<CommandResult<BranchTrackingInfo>> {
  return invokeCommand<BranchTrackingInfo>("get_branch_tracking_info", {
    path,
    branch,
  });
}

/**
 * Result of checkout with auto-stash
 */
export interface CheckoutWithStashResult {
  success: boolean;
  stashed: boolean;
  stashApplied: boolean;
  stashConflict: boolean;
  /** The auto-stash's oid. Identifies the entry to drop without trusting a position. */
  stashOid: string | null;
  message: string;
}

/**
 * Checkout with automatic stash handling
 * 1. Stashes uncommitted changes before checkout
 * 2. Performs checkout
 * 3. Re-applies stash after checkout
 * 4. Reports if stash apply had conflicts
 */
export async function checkoutWithAutoStash(
  path: string,
  refName: string,
): Promise<CommandResult<CheckoutWithStashResult>> {
  // The "Auto-Stash on Checkout" setting was persisted and rendered but never
  // read by anything: every checkout stashed, switched and popped regardless,
  // and a conflicting pop dropped the user into the conflict dialog they had
  // explicitly opted out of. With the setting off, let git refuse a checkout
  // that would clobber uncommitted work, the way `git checkout` does.
  const autoStash = settingsStore.getState().autoStashOnCheckout;
  return invokeCommand<CheckoutWithStashResult>("checkout_with_autostash", {
    path,
    refName,
    autoStash,
  });
}


/**
 * Cherry-pick operations
 */
export async function cherryPick(
  args: CherryPickCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("cherry_pick", args);
}

export async function continueCherryPick(
  args: ContinueCherryPickCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("continue_cherry_pick", args);
}

export async function abortCherryPick(
  args: AbortCherryPickCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_cherry_pick", args);
}

/**
 * Skip the stopped pick and resume the rest of the sequence
 * (`git cherry-pick --skip`). Resolves with the last commit the resumed
 * sequence created, or `null` when there was nothing left to apply.
 */
export async function skipCherryPick(
  args: SkipCherryPickCommand,
): Promise<CommandResult<Commit | null>> {
  return invokeCommand<Commit | null>("skip_cherry_pick", args);
}

/**
 * Revert operations
 */
export async function revert(
  args: RevertCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("revert", args);
}

export async function continueRevert(
  args: ContinueRevertCommand,
): Promise<CommandResult<Commit>> {
  return invokeCommand<Commit>("continue_revert", args);
}

export async function abortRevert(
  args: AbortRevertCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("abort_revert", args);
}

/** Skip the stopped revert (`git revert --skip`). */
export async function skipRevert(
  args: SkipRevertCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("skip_revert", args);
}

/**
 * Reset operations
 */
export async function reset(args: ResetCommand): Promise<CommandResult<void>> {
  return invokeCommand<void>("reset", args);
}

/**
 * Squash operations
 */

/**
 * Squash a range of commits into a single commit
 * @param path - Repository path
 * @param fromOid - Parent commit (exclusive - commits after this are squashed)
 * @param toOid - Newest commit to squash (inclusive)
 * @param message - New commit message for the squashed commit
 */
export async function squashCommits(
  path: string,
  fromOid: string,
  toOid: string,
  message: string,
): Promise<CommandResult<SquashResult>> {
  return invokeCommand<SquashResult>("squash_commits", {
    path,
    fromOid,
    toOid,
    message,
  });
}

/**
 * Fixup staged changes into a specific commit
 * @param path - Repository path
 * @param targetOid - The commit to amend changes into
 * @param amendMessage - Optional new message for the commit (if not provided, keeps original)
 */
export async function fixupCommit(
  path: string,
  targetOid: string,
  amendMessage?: string,
): Promise<CommandResult<SquashResult>> {
  return invokeCommand<SquashResult>("fixup_commit", {
    path,
    targetOid,
    amendMessage,
  });
}

/**
 * Drop (remove) a commit from history
 * @param path - Repository path
 * @param commitOid - The OID of the commit to drop
 */
export async function dropCommit(
  path: string,
  commitOid: string,
): Promise<CommandResult<DropCommitResult>> {
  return invokeCommand<DropCommitResult>("drop_commit", {
    path,
    commitOid,
  });
}

/**
 * Reorder commits by replaying them in a new order (drag-and-drop reordering)
 * @param path - Repository path
 * @param baseCommit - Parent of the oldest commit to reorder (exclusive base)
 * @param commitOrder - New order of commit OIDs from oldest to newest
 */
export async function reorderCommits(
  path: string,
  baseCommit: string,
  commitOrder: string[],
): Promise<CommandResult<ReorderResult>> {
  return invokeCommand<ReorderResult>("reorder_commits", {
    path,
    baseCommit,
    commitOrder,
  });
}

/**
 * Stash operations
 */
export async function getStashes(
  path: string,
): Promise<CommandResult<Stash[]>> {
  return invokeCommand<Stash[]>("get_stashes", { path });
}

export async function createStash(
  args: CreateStashCommand,
): Promise<CommandResult<Stash | null>> {
  // Returns null when the working tree is clean (nothing to stash) — a benign
  // no-op mirroring `git stash push` ("No local changes to save"), not an error.
  return invokeCommand<Stash | null>("create_stash", args);
}

export async function applyStash(
  args: ApplyStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_stash", args);
}

export async function dropStash(
  args: DropStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("drop_stash", args);
}

export async function popStash(
  args: PopStashCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("pop_stash", args);
}

export async function stashShow(
  args: StashShowCommand,
): Promise<CommandResult<StashShowResult>> {
  return invokeCommand<StashShowResult>("stash_show", args);
}

/**
 * Tag operations
 */
export async function getTags(path: string): Promise<CommandResult<Tag[]>> {
  return invokeCommand<Tag[]>("get_tags", { path });
}

export async function createTag(
  args: CreateTagCommand,
): Promise<CommandResult<Tag>> {
  return invokeCommand<Tag>("create_tag", args);
}

export async function deleteTag(
  args: DeleteTagCommand,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_tag", args);
}

export async function pushTag(
  args: PushTagCommand,
): Promise<CommandResult<void>> {
  const pushUrl = args.remote ? await resolveRemotePushUrl(args.path, args.remote) : null;
  if (!await checkNetworkPermission('push tag', args.path, args.remote, pushUrl)) {
    return blockedResult();
  }

  // push_tag takes a token and feeds it to the same credentials helper `push`
  // uses, but nothing ever supplied one — so on a token-authenticated HTTPS
  // remote the toolbar Push worked and "Push tag" failed with "No valid
  // credentials found".
  if (!args.token) {
    let token: string | undefined;
    if (args.remote && pushUrl) {
      token = await getPushUrlToken(args.path, args.remote, pushUrl);
    } else {
      // No push URL to scope against — `get_remotes` failed, or the remote is
      // not in the list. Dropping the credential here would fail the push with
      // "No valid credentials found"; fall back to the remote-scoped lookup,
      // which never needed the URL to reach a token.
      token = await getRepoToken(args.path, args.remote);
    }
    if (token) {
      args.token = token;
    }
  }

  return surfaceBackendRefusal(await invokeCommand<void>("push_tag", args));
}

export async function getPushRemote(
  path: string,
  remote?: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_push_remote", {
    path,
    ...(remote ? { remote } : {}),
  });
}

/**
 * Delete a tag on a remote (`git push <remote> :refs/tags/<name>`).
 *
 * The local `deleteTag` above removes the local ref only, and the tag fetch
 * refspec copies a pushed tag straight back — so without this a "deleted" tag
 * reappeared on the next fetch.
 */
export async function deleteRemoteTag(
  args: DeleteRemoteTagCommand,
): Promise<CommandResult<void>> {
  const pushUrl = args.remote ? await resolveRemotePushUrl(args.path, args.remote) : null;
  if (!await checkNetworkPermission('delete remote tag', args.path, args.remote, pushUrl)) {
    return blockedResult();
  }

  // Same credential plumbing push_tag needs: without a token this fails with
  // "No valid credentials found" on a token-authenticated HTTPS remote.
  if (!args.token) {
    let token: string | undefined;
    if (args.remote && pushUrl) {
      token = await getPushUrlToken(args.path, args.remote, pushUrl);
    } else {
      // No push URL to scope against — `get_remotes` failed, or the remote is
      // not in the list. Dropping the credential here would fail the push with
      // "No valid credentials found"; fall back to the remote-scoped lookup,
      // which never needed the URL to reach a token.
      token = await getRepoToken(args.path, args.remote);
    }
    if (token) {
      args.token = token;
    }
  }

  return surfaceBackendRefusal(await invokeCommand<void>("delete_remote_tag", args));
}

export async function getTagDetails(
  args: GetTagDetailsCommand,
): Promise<CommandResult<TagDetails>> {
  return invokeCommand<TagDetails>("get_tag_details", args);
}

export async function editTagMessage(
  args: EditTagMessageCommand,
): Promise<CommandResult<TagDetails>> {
  return invokeCommand<TagDetails>("edit_tag_message", args);
}

/**
 * Describe operations
 */

/**
 * Describe a commit using tags
 *
 * Returns the most recent tag reachable from a commit, with additional
 * information about commits since the tag and the commit hash.
 *
 * @param path - Repository path
 * @param options - Describe options
 * @returns Describe result with tag info, commits ahead, and commit hash
 */
export async function describeCommit(
  path: string,
  options?: DescribeOptions,
): Promise<CommandResult<DescribeResult>> {
  return invokeCommand<DescribeResult>("describe", {
    path,
    commitish: options?.commitish,
    tags: options?.tags,
    all: options?.all,
    long: options?.long,
    abbrev: options?.abbrev,
    matchPattern: options?.matchPattern,
    excludePattern: options?.excludePattern,
    firstParent: options?.firstParent,
    dirty: options?.dirty,
  });
}


/**
 * Reflog operations
 */
export async function getReflog(
  repoPath: string,
  limit?: number,
): Promise<CommandResult<ReflogEntry[]>> {
  return invokeCommand<ReflogEntry[]>("get_reflog", { path: repoPath, limit });
}

/**
 * Reset HEAD to a reflog entry.
 *
 * `expectedOid` guards against the reflog shifting between listing and reset
 * (a commit or checkout from another window renumbers every entry). Pass the
 * oid the user was shown; the backend refuses if the position no longer holds
 * it. Omitting it skips the check.
 */
export async function resetToReflog(
  repoPath: string,
  reflogIndex: number,
  mode: "soft" | "mixed" | "hard" = "mixed",
  expectedOid?: string,
): Promise<CommandResult<ReflogEntry>> {
  return invokeCommand<ReflogEntry>("reset_to_reflog", {
    path: repoPath,
    reflogIndex,
    mode,
    expectedOid,
  });
}

/**
 * Undo/redo operations
 */
export async function getUndoHistory(
  repoPath: string,
  maxCount?: number,
): Promise<CommandResult<UndoHistory>> {
  return invokeCommand<UndoHistory>("get_undo_history", {
    path: repoPath,
    maxCount,
  });
}

export async function undoLastAction(
  repoPath: string,
): Promise<CommandResult<UndoAction>> {
  return invokeCommand<UndoAction>("undo_last_action", { path: repoPath });
}

export async function redoLastAction(
  repoPath: string,
): Promise<CommandResult<UndoAction>> {
  return invokeCommand<UndoAction>("redo_last_action", { path: repoPath });
}

export async function recordAction(
  repoPath: string,
  action: UndoAction,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("record_action", { path: repoPath, action });
}

/**
 * Clean operations
 */
export interface CleanEntry {
  path: string;
  isDirectory: boolean;
  isIgnored: boolean;
  /**
   * True when this entry is an untracked nested git repository. Deleting it
   * destroys the embedded repo's history, so `git clean` only removes it with a
   * second `-f`; the UI must confirm and pass `forceNested` to clean it.
   */
  isNestedRepo: boolean;
  size: number | null;
}

export async function getCleanableFiles(
  repoPath: string,
  includeIgnored?: boolean,
  includeDirectories?: boolean,
): Promise<CommandResult<CleanEntry[]>> {
  return invokeCommand<CleanEntry[]>("get_cleanable_files", {
    path: repoPath,
    includeIgnored,
    includeDirectories,
  });
}

export async function cleanFiles(
  repoPath: string,
  paths: string[],
  forceNested = false,
): Promise<CommandResult<number>> {
  // forceNested is required to remove untracked nested git repositories,
  // mirroring `git clean -ff`. Without it the backend refuses to delete them.
  return invokeCommand<number>("clean_files", {
    path: repoPath,
    paths,
    forceNested,
  });
}

export async function cleanAll(
  repoPath: string,
  includeIgnored?: boolean,
  includeDirectories?: boolean,
): Promise<CommandResult<number>> {
  return invokeCommand<number>("clean_all", {
    path: repoPath,
    includeIgnored,
    includeDirectories,
  });
}

/**
 * Bisect operations
 */
export interface BisectLogEntry {
  commitOid: string;
  action: string;
  message: string | null;
}

export interface BisectStatus {
  active: boolean;
  currentCommit: string | null;
  badCommit: string | null;
  goodCommit: string | null;
  remaining: number | null;
  totalSteps: number | null;
  currentStep: number | null;
  log: BisectLogEntry[];
  /** Set once git has recorded the first bad commit; the session stays active until reset. */
  culprit: CulpritCommit | null;
}

export interface CulpritCommit {
  oid: string;
  summary: string;
  author: string;
  email: string;
}

export interface BisectStepResult {
  status: BisectStatus;
  culprit: CulpritCommit | null;
  message: string;
}

export async function getBisectStatus(
  repoPath: string,
): Promise<CommandResult<BisectStatus>> {
  return invokeCommand<BisectStatus>("get_bisect_status", { path: repoPath });
}

export async function bisectStart(
  repoPath: string,
  badCommit?: string,
  goodCommit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_start", {
    path: repoPath,
    badCommit,
    goodCommit,
  });
}

export async function bisectBad(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_bad", {
    path: repoPath,
    commit,
  });
}

export async function bisectGood(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_good", {
    path: repoPath,
    commit,
  });
}

export async function bisectSkip(
  repoPath: string,
  commit?: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_skip", {
    path: repoPath,
    commit,
  });
}

export async function bisectReset(
  repoPath: string,
): Promise<CommandResult<BisectStepResult>> {
  return invokeCommand<BisectStepResult>("bisect_reset", { path: repoPath });
}


/**
 * Git Flow operations
 */
export interface GitFlowConfig {
  initialized: boolean;
  masterBranch: string;
  developBranch: string;
  featurePrefix: string;
  releasePrefix: string;
  hotfixPrefix: string;
  supportPrefix: string;
  versionTagPrefix: string;
}

export async function getGitFlowConfig(
  repoPath: string,
): Promise<CommandResult<GitFlowConfig>> {
  return invokeCommand<GitFlowConfig>("get_gitflow_config", { path: repoPath });
}

export async function initGitFlow(
  repoPath: string,
  config?: Partial<GitFlowConfig>,
): Promise<CommandResult<GitFlowConfig>> {
  return invokeCommand<GitFlowConfig>("init_gitflow", {
    path: repoPath,
    masterBranch: config?.masterBranch,
    developBranch: config?.developBranch,
    featurePrefix: config?.featurePrefix,
    releasePrefix: config?.releasePrefix,
    hotfixPrefix: config?.hotfixPrefix,
    supportPrefix: config?.supportPrefix,
    versionTagPrefix: config?.versionTagPrefix,
  });
}

export async function gitFlowStartFeature(
  repoPath: string,
  name: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_feature", { path: repoPath, name });
}

/** Outcome of a git-flow finish; branchKeptReason is set when a branch rule blocked the delete. */
export interface GitFlowFinishResult {
  branchDeleted: boolean;
  branchKeptReason: string | null;
}

export async function gitFlowFinishFeature(
  repoPath: string,
  name: string,
  deleteBranch?: boolean,
  squash?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_feature", {
    path: repoPath,
    name,
    deleteBranch,
    squash,
  });
}

/**
 * Record that a squash finish's commit has landed on develop.
 *
 * A squash finish whose merge conflicted is committed by the conflict-resolution
 * flow, not by `gitflow_finish_feature`, so the backend has no record of it. The
 * marker written here makes a later retry (after e.g. a blocked branch delete)
 * do the pending cleanup only instead of re-merging into a second squash commit.
 */
export async function gitFlowRecordSquashFinish(
  repoPath: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("gitflow_record_squash_finish", { path: repoPath, name });
}

export async function gitFlowStartRelease(
  repoPath: string,
  version: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_release", { path: repoPath, version });
}

export async function gitFlowFinishRelease(
  repoPath: string,
  version: string,
  tagMessage?: string,
  deleteBranch?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_release", {
    path: repoPath,
    version,
    tagMessage,
    deleteBranch,
  });
}

export async function gitFlowStartHotfix(
  repoPath: string,
  version: string,
): Promise<CommandResult<Branch>> {
  return invokeCommand<Branch>("gitflow_start_hotfix", { path: repoPath, version });
}

export async function gitFlowFinishHotfix(
  repoPath: string,
  version: string,
  tagMessage?: string,
  deleteBranch?: boolean,
): Promise<CommandResult<GitFlowFinishResult>> {
  return invokeCommand<GitFlowFinishResult>("gitflow_finish_hotfix", {
    path: repoPath,
    version,
    tagMessage,
    deleteBranch,
  });
}

/**
 * Patch operations
 */
export async function createPatch(
  repoPath: string,
  commitOids: string[],
  outputPath: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("create_patch", {
    path: repoPath,
    commitOids,
    outputPath,
  });
}

export async function applyPatch(
  repoPath: string,
  patchPath: string,
  checkOnly?: boolean,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_patch", {
    path: repoPath,
    patchPath,
    checkOnly,
  });
}

export async function applyPatchToIndex(
  repoPath: string,
  patchPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("apply_patch_to_index", {
    path: repoPath,
    patchPath,
  });
}

/**
 * Archive operations
 */
export async function createArchive(
  repoPath: string,
  outputPath: string,
  treeRef?: string,
  format?: string,
  prefix?: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("create_archive", {
    path: repoPath,
    outputPath,
    treeRef,
    format,
    prefix,
  });
}

export async function getArchiveFiles(
  repoPath: string,
  treeRef?: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("get_archive_files", {
    path: repoPath,
    treeRef,
  });
}

/**
 * Git Notes operations
 */
export interface GitNote {
  commitOid: string;
  message: string;
  notesRef: string;
}

export async function getNote(
  repoPath: string,
  commitOid: string,
  notesRef?: string,
): Promise<CommandResult<GitNote | null>> {
  return invokeCommand<GitNote | null>("get_note", {
    path: repoPath,
    commitOid,
    notesRef,
  });
}

export async function getNotes(
  repoPath: string,
  notesRef?: string,
): Promise<CommandResult<GitNote[]>> {
  return invokeCommand<GitNote[]>("get_notes", {
    path: repoPath,
    notesRef,
  });
}

export async function setNote(
  repoPath: string,
  commitOid: string,
  message: string,
  notesRef?: string,
  force?: boolean,
): Promise<CommandResult<GitNote>> {
  return invokeCommand<GitNote>("set_note", {
    path: repoPath,
    commitOid,
    message,
    notesRef,
    force,
  });
}

export async function removeNote(
  repoPath: string,
  commitOid: string,
  notesRef?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("remove_note", {
    path: repoPath,
    commitOid,
    notesRef,
  });
}

export async function getNotesRefs(
  repoPath: string,
): Promise<CommandResult<string[]>> {
  return invokeCommand<string[]>("get_notes_refs", {
    path: repoPath,
  });
}


/**
 * Sparse checkout
 */
export interface SparseCheckoutConfig {
  enabled: boolean;
  coneMode: boolean;
  patterns: string[];
}

export async function getSparseCheckoutConfig(
  repoPath: string,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("get_sparse_checkout_config", {
    path: repoPath,
  });
}

export async function enableSparseCheckout(
  repoPath: string,
  coneMode: boolean,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("enable_sparse_checkout", {
    path: repoPath,
    coneMode,
  });
}

export async function disableSparseCheckout(
  repoPath: string,
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("disable_sparse_checkout", {
    path: repoPath,
  });
}

export async function setSparseCheckoutPatterns(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("set_sparse_checkout_patterns", {
    path: repoPath,
    patterns,
  });
}

export async function addSparseCheckoutPatterns(
  repoPath: string,
  patterns: string[],
): Promise<CommandResult<SparseCheckoutConfig>> {
  return invokeCommand<SparseCheckoutConfig>("add_sparse_checkout_patterns", {
    path: repoPath,
    patterns,
  });
}


/**
 * Branch Protection Rules
 */

/**
 * A local branch protection rule
 */
export interface BranchRule {
  /** Branch name or glob pattern (e.g., "main", "release/*") */
  pattern: string;
  /** Prevent the branch from being deleted */
  preventDeletion: boolean;
  /** Prevent force-pushing to the branch */
  preventForcePush: boolean;
  /** Require changes to go through a pull request */
  requirePullRequest: boolean;
  /** Prevent direct commits/pushes to the branch */
  preventDirectPush: boolean;
}

/**
 * Get all branch protection rules for a repository
 *
 * @param path - Repository path
 * @returns List of branch protection rules
 */
export async function getBranchRules(
  path: string,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("get_branch_rules", { path });
}

/**
 * Set (add or update) a branch protection rule
 *
 * @param path - Repository path
 * @param rule - The branch rule to set
 * @returns Updated list of all branch rules
 */
export async function setBranchRule(
  path: string,
  rule: BranchRule,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("set_branch_rule", { path, rule });
}

/**
 * Delete a branch protection rule by pattern
 *
 * @param path - Repository path
 * @param pattern - The branch pattern to remove the rule for
 * @returns Updated list of all branch rules
 */
export async function deleteBranchRule(
  path: string,
  pattern: string,
): Promise<CommandResult<BranchRule[]>> {
  return invokeCommand<BranchRule[]>("delete_branch_rule", { path, pattern });
}


/**
 * Cherry-pick a range of commits
 */
export async function cherryPickRange(
  path: string,
  commitOids: string[],
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("cherry_pick_range", { path, commitOids });
}

/**
 * Cherry-pick commits from the tip of a branch by name
 *
 * Resolves the given branch name to its tip commit and cherry-picks
 * the most recent `count` commits (default 1) onto the current branch.
 */
export async function cherryPickFromBranch(
  args: CherryPickFromBranchCommand,
): Promise<CommandResult<Commit[]>> {
  return invokeCommand<Commit[]>("cherry_pick_from_branch", args);
}


// ============================================================================
// Git Bundle Operations
// ============================================================================

/**
 * Reference in a bundle
 */
export interface BundleRef {
  name: string;
  oid: string;
}

/**
 * Result of creating a bundle
 */
export interface BundleCreateResult {
  bundlePath: string;
  refsCount: number;
  objectsCount: number;
}

/**
 * Result of verifying a bundle
 */
export interface BundleVerifyResult {
  isValid: boolean;
  refs: BundleRef[];
  requires: string[];
  message: string | null;
}

/**
 * Create a bundle file from repository refs
 * @param repoPath Repository path
 * @param bundlePath Output bundle file path
 * @param refs Refs to include (branches, tags, HEAD, ranges)
 * @param all Include all refs (--all flag)
 */
export async function bundleCreate(
  repoPath: string,
  bundlePath: string,
  refs: string[],
  all: boolean,
): Promise<CommandResult<BundleCreateResult>> {
  return invokeCommand<BundleCreateResult>("bundle_create", {
    path: repoPath,
    bundlePath,
    refs,
    all,
  });
}

/**
 * Verify a bundle file against a repository
 * @param repoPath Repository path (for verification against)
 * @param bundlePath Bundle file to verify
 */
export async function bundleVerify(
  repoPath: string,
  bundlePath: string,
): Promise<CommandResult<BundleVerifyResult>> {
  return invokeCommand<BundleVerifyResult>("bundle_verify", {
    path: repoPath,
    bundlePath,
  });
}

/**
 * List the refs (heads) contained in a bundle file
 * @param bundlePath Bundle file path
 */
export async function bundleListHeads(
  bundlePath: string,
): Promise<CommandResult<BundleRef[]>> {
  return invokeCommand<BundleRef[]>("bundle_list_heads", {
    bundlePath,
  });
}

/**
 * Extract (unbundle) a bundle file into a repository
 * @param repoPath Repository path
 * @param bundlePath Bundle file to extract
 * @returns The refs that were fetched from the bundle
 */
export async function bundleUnbundle(
  repoPath: string,
  bundlePath: string,
): Promise<CommandResult<BundleRef[]>> {
  return invokeCommand<BundleRef[]>("bundle_unbundle", {
    path: repoPath,
    bundlePath,
  });
}

