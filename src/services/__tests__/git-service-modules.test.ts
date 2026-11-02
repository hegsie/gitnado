/**
 * Tests verifying the domain split of `git.service.ts` into `src/services/git/*.ts`
 * and backwards-compatible re-exports from `src/services/git.service.ts`.
 */

import { expect } from "@open-wc/testing";
import * as gitService from "../git.service.ts";
import * as sharedModule from "../git/shared.ts";
import * as repositoryModule from "../git/repository.ts";
import * as branchesTagsModule from "../git/branches-tags.ts";
import * as diffBlameModule from "../git/diff-blame.ts";
import * as mergeRebaseModule from "../git/merge-rebase.ts";
import * as remotesModule from "../git/remotes.ts";
import * as securityCredentialsModule from "../git/security-credentials.ts";
import * as providersModule from "../git/providers.ts";
import * as aiWorkspaceModule from "../git/ai-workspace.ts";

describe("git service domain modules", () => {
  it("shared.ts exports network gate and shared helper functions", () => {
    const keyExports = [
      "checkNetworkAllowed",
      "checkNetworkPermission",
      "invokeProviderCommand",
      "isNetworkPolicyActive",
      "checkOutboundHostAllowed",
      "isNetworkGateRefusal",
      "isOperationCancelled",
      "resolveRemoteUrl",
      "resolveRemotePushUrl",
      "cloneUrlHost",
      "getCloneToken",
      "resolveRepoToken",
      "getRepoToken",
      "getRemoteToken",
      "getPushUrlToken",
    ] as const;

    for (const name of keyExports) {
      expect(sharedModule[name], `shared.${name}`).to.be.a("function");
    }
  });

  it("repository.ts exports repository, status, staging, commit, and file operations", () => {
    const keyExports = [
      "openRepository",
      "cloneRepository",
      "cancelClone",
      "initRepository",
      "getCloneFilterInfo",
      "deepenRepository",
      "unshallowRepository",
      "listTrackedFiles",
      "getCommitHistory",
      "getCommitTotal",
      "getCommit",
      "createCommit",
      "amendCommit",
      "getStatus",
      "getSortedFileStatus",
      "stageFiles",
      "unstageFiles",
      "discardChanges",
      "stageHunk",
      "unstageHunk",
      "stageLines",
      "writeFileContent",
      "readFileContent",
      "getCommitTemplate",
      "getGitignore",
      "getGitattributes",
      "getRepoStats",
      "getRepoStatistics",
      "checkoutFileFromCommit",
      "checkoutFileFromBranch",
      "getFileAtCommit",
      "detectFileEncoding",
      "convertFileEncoding",
      "validateCommitMessage",
    ] as const;

    for (const name of keyExports) {
      expect(repositoryModule[name], `repository.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(repositoryModule[name]);
    }
  });

  it("branches-tags.ts exports branches, tags, checkout, stash, cherry-pick, revert, reset, clean, bisect, archive, patch, notes, bundle, sparse-checkout, and gitflow", () => {
    const keyExports = [
      "getBranches",
      "createBranch",
      "createOrphanBranch",
      "deleteBranch",
      "renameBranch",
      "checkout",
      "checkoutWithAutoStash",
      "cherryPick",
      "cherryPickRange",
      "cherryPickFromBranch",
      "revert",
      "reset",
      "squashCommits",
      "fixupCommit",
      "dropCommit",
      "reorderCommits",
      "getStashes",
      "createStash",
      "applyStash",
      "dropStash",
      "popStash",
      "stashShow",
      "getTags",
      "createTag",
      "deleteTag",
      "pushTag",
      "deleteRemoteTag",
      "describeCommit",
      "getReflog",
      "resetToReflog",
      "getUndoHistory",
      "undoLastAction",
      "getCleanableFiles",
      "cleanFiles",
      "getBisectStatus",
      "bisectStart",
      "initGitFlow",
      "createPatch",
      "applyPatch",
      "createArchive",
      "getNotes",
      "getSparseCheckoutConfig",
      "getBranchRules",
      "bundleCreate",
    ] as const;

    for (const name of keyExports) {
      expect(branchesTagsModule[name], `branchesTags.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(branchesTagsModule[name]);
    }
  });

  it("diff-blame.ts exports diffs, image diffs, blame, file history, search, and branch comparison", () => {
    const keyExports = [
      "getDiff",
      "getDiffWithOptions",
      "getFileDiff",
      "getCommitFiles",
      "getCommitFileDiff",
      "getCommitsStats",
      "getFileBlame",
      "getImageVersions",
      "getFileHistory",
      "getRefsByCommit",
      "getShortlog",
      "searchInFiles",
      "searchInDiff",
      "searchInCommits",
      "searchInCommitMessages",
      "searchCommitsByContent",
      "searchCommitsByFile",
      "filterCommits",
      "getBranchDiffCommits",
      "getFileLog",
      "compareBranches",
      "getDiffToolConfig",
      "setDiffTool",
      "listDiffTools",
      "launchDiffTool",
    ] as const;

    for (const name of keyExports) {
      expect(diffBlameModule[name], `diffBlame.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(diffBlameModule[name]);
    }
  });

  it("merge-rebase.ts exports merge, rebase, interactive rebase, conflict resolution, and merge tools", () => {
    const keyExports = [
      "merge",
      "previewMerge",
      "abortMerge",
      "commitMerge",
      "rebase",
      "previewRebase",
      "continueRebase",
      "abortRebase",
      "getRebaseCommits",
      "isAncestorOfHead",
      "executeInteractiveRebase",
      "getRebaseState",
      "getRebaseTodo",
      "updateRebaseTodo",
      "skipRebaseCommit",
      "getConflicts",
      "getBlobContent",
      "resolveConflict",
      "resolveConflictTakeSide",
      "detectConflictMarkers",
      "getConflictDetails",
      "getMergeToolConfig",
      "setMergeToolConfig",
      "launchMergeTool",
      "getAvailableMergeTools",
      "autoDetectMergeTool",
    ] as const;

    for (const name of keyExports) {
      expect(mergeRebaseModule[name], `mergeRebase.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(mergeRebaseModule[name]);
    }
  });

  it("remotes.ts exports remotes, fetch, pull, push, submodules, worktrees, LFS, hooks, and maintenance", () => {
    const keyExports = [
      "fetchInBackground",
      "getRemotes",
      "addRemote",
      "removeRemote",
      "renameRemote",
      "setRemoteUrl",
      "fetch",
      "pull",
      "push",
      "pushToMultipleRemotes",
      "fetchAllRemotes",
      "getFetchStatus",
      "getSubmodules",
      "addSubmodule",
      "initSubmodules",
      "updateSubmodules",
      "syncSubmodules",
      "deinitSubmodule",
      "removeSubmodule",
      "getWorktrees",
      "addWorktree",
      "removeWorktree",
      "pruneWorktrees",
      "lockWorktree",
      "unlockWorktree",
      "getLfsStatus",
      "initLfs",
      "lfsTrack",
      "lfsUntrack",
      "getLfsFiles",
      "lfsPull",
      "lfsFetch",
      "lfsPrune",
      "startAutoFetch",
      "stopAutoFetch",
      "setupRemoteOperationListeners",
      "cleanupRemoteOperationListeners",
      "getHooks",
      "saveHook",
      "getRepositoryStats",
      "getPackInfo",
      "pruneRemoteTrackingBranches",
      "runGc",
      "runFsck",
      "runPrune",
      "runGarbageCollection",
      "verifyRepository",
    ] as const;

    for (const name of keyExports) {
      expect(remotesModule[name], `remotes.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(remotesModule[name]);
    }
  });

  it("security-credentials.ts exports GPG, SSH, config, credentials, keyring, profiles, and signature verification", () => {
    const keyExports = [
      "getGpgConfig",
      "getGpgKeys",
      "setSigningKey",
      "setCommitSigning",
      "setTagSigning",
      "getCommitSignature",
      "getCommitsSignatures",
      "getSigningStatus",
      "getSshConfig",
      "getSshKeys",
      "generateSshKey",
      "testSshConnection",
      "addKeyToAgent",
      "listAgentKeys",
      "getPublicKeyContent",
      "deleteSshKey",
      "getConfigValue",
      "setConfigValue",
      "unsetConfigValue",
      "getConfigList",
      "getUserIdentity",
      "setUserIdentity",
      "getAliases",
      "getLineEndingConfig",
      "getGitConfig",
      "setGitConfig",
      "getCredentialHelpers",
      "testCredentials",
      "storeGitCredentials",
      "deleteGitCredentials",
      "storeKeyringToken",
      "getKeyringToken",
      "deleteKeyringToken",
      "getProfiles",
      "saveProfile",
      "applyProfile",
      "verifyCommitSignature",
      "getCommitsSignatureInfo",
      "getSigningConfig",
    ] as const;

    for (const name of keyExports) {
      expect(securityCredentialsModule[name], `securityCredentials.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(securityCredentialsModule[name]);
    }
  });

  it("providers.ts exports GitHub, Azure DevOps, GitLab, Bitbucket, Jira, and credential sync caches", () => {
    const keyExports = [
      "resetAdoGitCredentialSyncCache",
      "syncAdoGitCredentials",
      "storeGitHubToken",
      "getGitHubToken",
      "deleteGitHubToken",
      "checkGitHubConnection",
      "detectGitHubRepo",
      "listPullRequests",
      "createPullRequest",
      "listIssues",
      "parseIssueReferences",
      "listReleases",
      "storeAdoToken",
      "getAdoToken",
      "checkAdoConnection",
      "detectAdoRepo",
      "listAdoPullRequests",
      "storeGitLabToken",
      "getGitLabToken",
      "checkGitLabConnection",
      "detectGitLabRepo",
      "listGitLabMergeRequests",
      "storeBitbucketCredentials",
      "getBitbucketCredentials",
      "checkBitbucketConnection",
      "detectBitbucketRepo",
      "listBitbucketPullRequests",
      "listGitHubRepositories",
      "listGitLabProjects",
      "listBitbucketRepositories",
      "listAdoRepositories",
      "getPrTemplates",
      "getIssueTemplates",
      "detectRepositoryIntegration",
      "getJiraConfig",
      "testJiraConnection",
      "getJiraIssues",
      "createBranchFromJira",
      "generateBranchFromIssue",
    ] as const;

    for (const name of keyExports) {
      expect(providersModule[name], `providers.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(providersModule[name]);
    }
  });

  it("ai-workspace.ts exports terminal/editor launch, avatars, bookmarks, custom actions, and clipboard operations", () => {
    const keyExports = [
      "openTerminal",
      "openFileManager",
      "openInEditor",
      "revealInFileManager",
      "openInDefaultApp",
      "openInConfiguredEditor",
      "getEditorConfig",
      "setEditorConfig",
      "getAvatarUrl",
      "getAvatarUrls",
      "getBookmarks",
      "addBookmark",
      "removeBookmark",
      "updateBookmark",
      "getRecentRepos",
      "recordRepoOpened",
      "getCustomActions",
      "saveCustomAction",
      "deleteCustomAction",
      "runCustomAction",
      "copyToClipboard",
      "getCommitInfoForCopy",
      "getFilePathForCopy",
      "copyCommitSha",
      "copyCommitMessage",
      "copyCommitPatch",
      "copyFilePath",
    ] as const;

    for (const name of keyExports) {
      expect(aiWorkspaceModule[name], `aiWorkspace.${name}`).to.be.a("function");
      expect(gitService[name], `gitService.${name}`).to.equal(aiWorkspaceModule[name]);
    }
  });

  it("git.service.ts barrel re-exports every runtime symbol from all domain modules (444 functions)", () => {
    const domainModules = [
      repositoryModule,
      branchesTagsModule,
      diffBlameModule,
      mergeRebaseModule,
      remotesModule,
      securityCredentialsModule,
      providersModule,
      aiWorkspaceModule,
    ];

    let totalDomainExports = 0;
    for (const mod of domainModules) {
      for (const [key, value] of Object.entries(mod)) {
        totalDomainExports++;
        expect((gitService as Record<string, unknown>)[key], `gitService.${key}`).to.equal(value);
      }
    }

    // Plus the 4 public runtime functions from shared.ts
    const publicSharedFunctions = [
      "isNetworkPolicyActive",
      "checkOutboundHostAllowed",
      "isNetworkGateRefusal",
      "isOperationCancelled",
    ] as const;
    for (const key of publicSharedFunctions) {
      expect(gitService[key], `gitService.${key}`).to.equal(sharedModule[key]);
    }

    expect(Object.keys(gitService).length).to.equal(totalDomainExports + publicSharedFunctions.length);
    expect(Object.keys(gitService).length).to.equal(444);
  });
});
