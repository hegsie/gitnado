import { invokeCommand } from "../tauri-api.ts";
import type {
  CommandResult,
} from "../../types/api.types.ts";
import {
  blockedResult,
  checkNetworkAllowed,
  invokeProviderCommand,
  isNetworkPolicyActive,
} from "./shared.ts";
import { storeGitCredentials } from "./security-credentials.ts";

/** Last `${org}::${token}` written to the keyring ADO git credential (dedup). */
let lastSyncedAdoGitCredKey: string | null = null;

/**
 * Reset the ADO git-credential sync dedup cache. Call this after deleting the
 * keyring credential (disconnect/delete) so a subsequent connect with the same
 * token value re-writes the (now-deleted) keyring entry instead of being skipped.
 */
export function resetAdoGitCredentialSyncCache(): void {
  lastSyncedAdoGitCredKey = null;
}

/**
 * Write the Azure DevOps git credentials to the OS keyring for both dev.azure.com
 * and {org}.visualstudio.com so external git CLI operations use a valid token.
 * Best-effort and deduped by (org, token); storeGitCredentials never throws.
 * Only call with a token verified to work for `org`.
 */
export async function syncAdoGitCredentials(org: string, token: string): Promise<void> {
  const key = `${org}::${token}`;
  if (key === lastSyncedAdoGitCredKey) return;
  const c1 = await storeGitCredentials("https://dev.azure.com", "pat", token);
  const c2 = await storeGitCredentials(`https://${org}.visualstudio.com`, "pat", token);
  if (c1.success && c2.success) {
    lastSyncedAdoGitCredKey = key;
  }
}


// ============================================================================
// GitHub Integration
// ============================================================================

export interface GitHubUser {
  login: string;
  id: number;
  avatarUrl: string;
  name: string | null;
  email: string | null;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  user: GitHubUser | null;
  scopes: string[];
}

export interface DetectedGitHubRepo {
  owner: string;
  repo: string;
  remoteName: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  mergeable: boolean | null;
  htmlUrl: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  htmlUrl: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  labels: Label[];
  assignees: GitHubUser[];
  reviewers: GitHubUser[];
}

export interface PullRequestReview {
  id: number;
  user: GitHubUser;
  body: string | null;
  state: string;
  submittedAt: string | null;
  htmlUrl: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowId: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runNumber: number;
  event: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

// Authentication (using OS keyring)
export async function storeGitHubToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { GitHubCredentials } = await import("../credential.service.ts");
    await GitHubCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getGitHubToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("../credential.service.ts");
    const account = selectDefaultGlobalAccount("github");
    if (account) {
      const token = await getFreshAccountToken("github", account.id, "github");
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { GitHubCredentials } = await import("../credential.service.ts");
    const token = await GitHubCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteGitHubToken(): Promise<CommandResult<void>> {
  try {
    const { GitHubCredentials } = await import("../credential.service.ts");
    await GitHubCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function checkGitHubConnection(): Promise<
  CommandResult<GitHubConnectionStatus>
> {
  // Get token from credential service and pass to backend
  const tokenResult = await getGitHubToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<GitHubConnectionStatus>("check_github_connection", {
    token,
  });
}

/**
 * Check GitHub connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkGitHubConnectionWithToken(
  token: string | null,
): Promise<CommandResult<GitHubConnectionStatus>> {
  return invokeProviderCommand<GitHubConnectionStatus>("check_github_connection", {
    token,
  });
}

// Repository Detection
export async function detectGitHubRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedGitHubRepo | null>> {
  return invokeCommand<DetectedGitHubRepo | null>("detect_github_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// Pull Requests
export async function listPullRequests(
  owner: string,
  repo: string,
  state?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<PullRequestSummary[]>> {
  return invokeProviderCommand<PullRequestSummary[]>("list_pull_requests", {
    owner,
    repo,
    state,
    perPage,
    page,
    token,
  });
}

export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<PullRequestDetails>> {
  return invokeProviderCommand<PullRequestDetails>("get_pull_request", {
    owner,
    repo,
    number,
    token,
  });
}

export async function createPullRequest(
  owner: string,
  repo: string,
  input: CreatePullRequestInput,
  token?: string | null,
): Promise<CommandResult<PullRequestSummary>> {
  return invokeProviderCommand<PullRequestSummary>("create_pull_request", {
    owner,
    repo,
    input,
    token,
  });
}

export interface PrReviewComment {
  id: string;
  author: string;
  avatarUrl?: string | null;
  body: string;
  createdAt: string;
  filePath?: string | null;
  line?: number | null;
}

export async function getPullRequestReviews(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<PullRequestReview[]>> {
  return invokeProviderCommand<PullRequestReview[]>("get_pull_request_reviews", {
    owner,
    repo,
    number,
    token,
  });
}

export async function getGitHubPrComments(
  owner: string,
  repo: string,
  pullNumber: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment[]>> {
  return invokeProviderCommand<PrReviewComment[]>("get_github_pr_comments", {
    owner,
    repo,
    pullNumber,
    token,
  });
}

export async function addGitHubPrComment(
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  path?: string,
  line?: number,
  commitId?: string,
  token?: string | null,
): Promise<CommandResult<PrReviewComment>> {
  return invokeProviderCommand<PrReviewComment>("add_github_pr_comment", {
    owner,
    repo,
    pullNumber,
    body,
    path,
    line,
    commitId,
    token,
  });
}

// GitHub Actions
export async function getWorkflowRuns(
  owner: string,
  repo: string,
  branch?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<WorkflowRun[]>> {
  return invokeProviderCommand<WorkflowRun[]>("get_workflow_runs", {
    owner,
    repo,
    branch,
    perPage,
    page,
    token,
  });
}

export async function getCheckRuns(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string | null,
): Promise<CommandResult<CheckRun[]>> {
  return invokeProviderCommand<CheckRun[]>("get_check_runs", {
    owner,
    repo,
    commitSha,
    token,
  });
}

export async function getCommitStatus(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string | null,
): Promise<CommandResult<string>> {
  return invokeProviderCommand<string>("get_commit_status", {
    owner,
    repo,
    commitSha,
    token,
  });
}

// GitHub Issues

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  user: GitHubUser;
  labels: Label[];
  assignees: GitHubUser[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  htmlUrl: string;
  body: string | null;
}

/**
 * One page of issues plus the cursor for the next request.
 *
 * The `/issues` endpoint returns pull requests alongside issues and the backend
 * filters them out, so the length of `issues` says nothing about whether more
 * exist — `nextPage` carries that answer instead. `null` means the list ends
 * here.
 */
export interface IssuePage {
  issues: IssueSummary[];
  nextPage: number | null;
}

export interface IssueComment {
  id: number;
  user: GitHubUser;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export async function listIssues(
  owner: string,
  repo: string,
  state?: string,
  labels?: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<IssuePage>> {
  return invokeProviderCommand<IssuePage>("list_issues", {
    owner,
    repo,
    state,
    labels,
    perPage,
    page,
    token,
  });
}

export async function getIssue(
  owner: string,
  repo: string,
  number: number,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("get_issue", {
    owner,
    repo,
    number,
    token,
  });
}

export async function createIssue(
  owner: string,
  repo: string,
  input: CreateIssueInput,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("create_issue", {
    owner,
    repo,
    input,
    token,
  });
}

export async function updateIssueState(
  owner: string,
  repo: string,
  number: number,
  state: string,
  token?: string | null,
): Promise<CommandResult<IssueSummary>> {
  return invokeProviderCommand<IssueSummary>("update_issue_state", {
    owner,
    repo,
    number,
    state,
    token,
  });
}

export async function getIssueComments(
  owner: string,
  repo: string,
  number: number,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<IssueComment[]>> {
  return invokeProviderCommand<IssueComment[]>("get_issue_comments", {
    owner,
    repo,
    number,
    perPage,
    token,
  });
}

export async function addIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  token?: string | null,
): Promise<CommandResult<IssueComment>> {
  return invokeProviderCommand<IssueComment>("add_issue_comment", {
    owner,
    repo,
    number,
    body,
    token,
  });
}

export async function getRepoLabels(
  owner: string,
  repo: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<Label[]>> {
  return invokeProviderCommand<Label[]>("get_repo_labels", {
    owner,
    repo,
    perPage,
    token,
  });
}

// Issue Reference Utilities

export interface IssueReference {
  number: number;
  keyword: string | null; // 'fixes', 'closes', 'resolves', etc. or null for plain #123
  fullMatch: string;
}

/**
 * Parse issue references from commit message text.
 * Detects patterns like: #123, fixes #123, closes #123, resolves #123
 */
export function parseIssueReferences(text: string): IssueReference[] {
  const references: IssueReference[] = [];
  const seen = new Set<number>();

  // Keywords that GitHub recognizes for auto-closing issues
  const keywords = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];
  const keywordPattern = keywords.join("|");

  // Match keyword + issue reference (e.g., "fixes #123" or "fix #123")
  const keywordRegex = new RegExp(`\\b(${keywordPattern})\\s+#(\\d+)\\b`, "gi");
  let match;

  while ((match = keywordRegex.exec(text)) !== null) {
    const num = parseInt(match[2], 10);
    if (!seen.has(num)) {
      seen.add(num);
      references.push({
        number: num,
        keyword: match[1].toLowerCase(),
        fullMatch: match[0],
      });
    }
  }

  // Match standalone issue references (e.g., "#123" not preceded by a keyword)
  const standaloneRegex = /#(\d+)\b/g;
  while ((match = standaloneRegex.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (!seen.has(num)) {
      seen.add(num);
      references.push({
        number: num,
        keyword: null,
        fullMatch: match[0],
      });
    }
  }

  return references;
}

/**
 * Check if a keyword indicates the issue should be closed
 */
export function isClosingKeyword(keyword: string | null): boolean {
  if (!keyword) return false;
  const closingKeywords = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];
  return closingKeywords.includes(keyword.toLowerCase());
}

// GitHub Releases

export interface ReleaseSummary {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  htmlUrl: string;
  author: GitHubUser;
  assetsCount: number;
}

export interface CreateReleaseInput {
  tagName: string;
  targetCommitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  generateReleaseNotes?: boolean;
}

export async function listReleases(
  owner: string,
  repo: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary[]>> {
  return invokeProviderCommand<ReleaseSummary[]>("list_releases", {
    owner,
    repo,
    perPage,
    page,
    token,
  });
}

export async function getReleaseByTag(
  owner: string,
  repo: string,
  tag: string,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("get_release_by_tag", {
    owner,
    repo,
    tag,
    token,
  });
}

export async function getLatestRelease(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("get_latest_release", {
    owner,
    repo,
    token,
  });
}

export async function createRelease(
  owner: string,
  repo: string,
  input: CreateReleaseInput,
  token?: string | null,
): Promise<CommandResult<ReleaseSummary>> {
  return invokeProviderCommand<ReleaseSummary>("create_release", {
    owner,
    repo,
    input,
    token,
  });
}

export async function deleteRelease(
  owner: string,
  repo: string,
  releaseId: number,
  token?: string | null,
): Promise<CommandResult<void>> {
  return invokeProviderCommand<void>("delete_release", {
    owner,
    repo,
    releaseId,
    token,
  });
}

// =======================
// Azure DevOps Integration
// =======================

export interface AdoUser {
  id: string;
  displayName: string;
  uniqueName: string;
  imageUrl: string | null;
}

export interface AdoConnectionStatus {
  connected: boolean;
  user: AdoUser | null;
  organization: string | null;
}

export interface DetectedAdoRepo {
  organization: string;
  project: string;
  repository: string;
  remoteName: string;
}

export interface AdoOrganization {
  id: string;
  name: string;
  url: string;
}

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description: string | null;
  status: string;
  createdBy: AdoUser;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft: boolean;
  url: string;
  repositoryId: string;
}

export interface CreateAdoPullRequestInput {
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
}

export interface AdoWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo: AdoUser | null;
  createdDate: string;
  url: string;
}

export interface AdoPipelineRun {
  id: number;
  name: string;
  state: string;
  result: string | null;
  createdDate: string;
  finishedDate: string | null;
  sourceBranch: string;
  url: string;
}

// Azure DevOps Token Management (using OS keyring)

export async function storeAdoToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { AzureDevOpsCredentials } = await import("../credential.service.ts");
    await AzureDevOpsCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getAdoToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("../credential.service.ts");
    const account = selectDefaultGlobalAccount("azure-devops");
    if (account) {
      // Refresh an expiring Entra OAuth token so callers get a valid one.
      const token = await getFreshAccountToken("azure-devops", account.id, "azure");
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { AzureDevOpsCredentials } = await import("../credential.service.ts");
    const token = await AzureDevOpsCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteAdoToken(): Promise<CommandResult<void>> {
  try {
    const { AzureDevOpsCredentials } = await import("../credential.service.ts");
    await AzureDevOpsCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// Azure DevOps Connection

export async function checkAdoConnection(
  organization: string,
): Promise<CommandResult<AdoConnectionStatus>> {
  // Get token from credential service and pass to backend
  const tokenResult = await getAdoToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<AdoConnectionStatus>("check_ado_connection", {
    organization,
    token,
  });
}

/**
 * Check Azure DevOps connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkAdoConnectionWithToken(
  organization: string,
  token: string | null,
): Promise<CommandResult<AdoConnectionStatus>> {
  return invokeProviderCommand<AdoConnectionStatus>("check_ado_connection", {
    organization,
    token,
  });
}

/**
 * List the Azure DevOps organizations the authenticated user belongs to.
 * Used to auto-resolve the organization after an Entra sign-in when it can't be
 * detected from the repo remote.
 */
export async function listAdoOrganizations(
  token?: string | null,
): Promise<CommandResult<AdoOrganization[]>> {
  return invokeProviderCommand<AdoOrganization[]>("list_ado_organizations", { token });
}

export async function detectAdoRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedAdoRepo | null>> {
  return invokeCommand<DetectedAdoRepo | null>("detect_ado_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// Azure DevOps Pull Requests

export async function listAdoPullRequests(
  organization: string,
  project: string,
  repository: string,
  status?: string,
  top?: number,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest[]>> {
  return invokeProviderCommand<AdoPullRequest[]>("list_ado_pull_requests", {
    organization,
    project,
    repository,
    status,
    top,
    token,
  });
}

export async function getAdoPullRequest(
  organization: string,
  project: string,
  repository: string,
  pullRequestId: number,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest>> {
  return invokeProviderCommand<AdoPullRequest>("get_ado_pull_request", {
    organization,
    project,
    repository,
    pullRequestId,
    token,
  });
}

export async function createAdoPullRequest(
  organization: string,
  project: string,
  repository: string,
  input: CreateAdoPullRequestInput,
  token?: string | null,
): Promise<CommandResult<AdoPullRequest>> {
  return invokeProviderCommand<AdoPullRequest>("create_ado_pull_request", {
    organization,
    project,
    repository,
    input,
    token,
  });
}

export async function getAdoPrComments(
  organization: string,
  project: string,
  repository: string,
  pullRequestId: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment[]>> {
  return invokeProviderCommand<PrReviewComment[]>("get_ado_pr_comments", {
    organization,
    project,
    repository,
    pullRequestId,
    token,
  });
}

export async function addAdoPrComment(
  organization: string,
  project: string,
  repository: string,
  pullRequestId: number,
  content: string,
  filePath?: string,
  line?: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment>> {
  return invokeProviderCommand<PrReviewComment>("add_ado_pr_comment", {
    organization,
    project,
    repository,
    pullRequestId,
    content,
    filePath,
    line,
    token,
  });
}

// Azure DevOps Work Items

export async function getAdoWorkItems(
  organization: string,
  project: string,
  ids: number[],
  token?: string | null,
): Promise<CommandResult<AdoWorkItem[]>> {
  return invokeProviderCommand<AdoWorkItem[]>("get_ado_work_items", {
    organization,
    project,
    ids,
    token,
  });
}

export async function queryAdoWorkItems(
  organization: string,
  project: string,
  state?: string,
  limit?: number,
  token?: string | null,
): Promise<CommandResult<AdoWorkItem[]>> {
  return invokeProviderCommand<AdoWorkItem[]>("query_ado_work_items", {
    organization,
    project,
    state,
    limit,
    token,
  });
}

export interface CreateAdoWorkItemInput {
  workItemType?: string;
  title: string;
  description?: string;
  /** Identity (unique name / UPN) to assign the new work item to. */
  assignedTo?: string;
}

export async function createAzureDevOpsWorkItem(
  organization: string,
  project: string,
  input: CreateAdoWorkItemInput,
  token?: string | null,
): Promise<CommandResult<AdoWorkItem>> {
  return invokeProviderCommand<AdoWorkItem>("create_azure_devops_work_item", {
    organization,
    project,
    input,
    token,
  });
}

// Azure DevOps Pipelines

export async function listAdoPipelineRuns(
  organization: string,
  project: string,
  repository: string,
  top?: number,
  token?: string | null,
): Promise<CommandResult<AdoPipelineRun[]>> {
  return invokeProviderCommand<AdoPipelineRun[]>("list_ado_pipeline_runs", {
    organization,
    project,
    repository,
    top,
    token,
  });
}

// =======================
// GitLab Integration
// =======================

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatarUrl: string | null;
  webUrl: string;
}

export interface GitLabConnectionStatus {
  connected: boolean;
  user: GitLabUser | null;
  instanceUrl: string;
}

export interface DetectedGitLabRepo {
  instanceUrl: string;
  projectPath: string;
  remoteName: string;
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  author: GitLabUser;
  createdAt: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  webUrl: string;
  mergeStatus: string;
}

export interface CreateMergeRequestInput {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  author: GitLabUser;
  assignees: GitLabUser[];
  labels: string[];
  createdAt: string;
  webUrl: string;
}

export interface CreateGitLabIssueInput {
  title: string;
  description?: string;
  labels?: string[];
}

export interface GitLabPipeline {
  id: number;
  iid: number;
  status: string;
  source: string;
  ref: string;
  sha: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
}

// GitLab Token Management (using OS keyring)
export async function storeGitLabToken(
  token: string,
): Promise<CommandResult<void>> {
  try {
    const { GitLabCredentials } = await import("../credential.service.ts");
    await GitLabCredentials.setToken(token);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getGitLabToken(): Promise<CommandResult<string | null>> {
  try {
    // Try account-based keyring credentials first (new system)
    const { selectDefaultGlobalAccount } = await import("../../stores/unified-profile.store.ts");
    const { getFreshAccountToken } = await import("../credential.service.ts");
    const account = selectDefaultGlobalAccount("gitlab");
    if (account) {
      const token = await getFreshAccountToken(
        "gitlab",
        account.id,
        "gitlab",
        account.config.type === "gitlab" ? account.config.instanceUrl : undefined,
      );
      if (token) return { success: true, data: token };
    }
    // Fall back to legacy single-account credentials
    const { GitLabCredentials } = await import("../credential.service.ts");
    const token = await GitLabCredentials.getToken();
    return { success: true, data: token };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteGitLabToken(): Promise<CommandResult<void>> {
  try {
    const { GitLabCredentials } = await import("../credential.service.ts");
    await GitLabCredentials.deleteToken();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// GitLab Connection

export async function checkGitLabConnection(
  instanceUrl: string,
): Promise<CommandResult<GitLabConnectionStatus>> {
  // Get token from credential service and pass to backend
  const tokenResult = await getGitLabToken();
  const token = tokenResult.success ? tokenResult.data : null;
  return invokeProviderCommand<GitLabConnectionStatus>("check_gitlab_connection", {
    instanceUrl,
    token,
  });
}

/**
 * Check GitLab connection with a specific token
 * Used for multi-account support where token is retrieved from account-specific storage
 */
export async function checkGitLabConnectionWithToken(
  instanceUrl: string,
  token: string | null,
): Promise<CommandResult<GitLabConnectionStatus>> {
  return invokeProviderCommand<GitLabConnectionStatus>("check_gitlab_connection", {
    instanceUrl,
    token,
  });
}

export async function detectGitLabRepo(
  path: string,
  remoteName?: string,
): Promise<CommandResult<DetectedGitLabRepo | null>> {
  return invokeCommand<DetectedGitLabRepo | null>("detect_gitlab_repo", {
    path,
    ...(remoteName ? { remoteName } : {}),
  });
}

// GitLab Merge Requests

export async function listGitLabMergeRequests(
  instanceUrl: string,
  projectPath: string,
  state?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest[]>> {
  return invokeProviderCommand<GitLabMergeRequest[]>("list_gitlab_merge_requests", {
    instanceUrl,
    projectPath,
    state,
    perPage,
    token,
  });
}

export async function getGitLabMergeRequest(
  instanceUrl: string,
  projectPath: string,
  mrIid: number,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest>> {
  return invokeProviderCommand<GitLabMergeRequest>("get_gitlab_merge_request", {
    instanceUrl,
    projectPath,
    mrIid,
    token,
  });
}

export async function createGitLabMergeRequest(
  instanceUrl: string,
  projectPath: string,
  input: CreateMergeRequestInput,
  token?: string | null,
): Promise<CommandResult<GitLabMergeRequest>> {
  return invokeProviderCommand<GitLabMergeRequest>("create_gitlab_merge_request", {
    instanceUrl,
    projectPath,
    input,
    token,
  });
}

export async function getGitLabMrComments(
  instanceUrl: string,
  projectPath: string,
  mrIid: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment[]>> {
  return invokeProviderCommand<PrReviewComment[]>("get_gitlab_mr_comments", {
    instanceUrl,
    projectPath,
    mrIid,
    token,
  });
}

export async function addGitLabMrComment(
  instanceUrl: string,
  projectPath: string,
  mrIid: number,
  body: string,
  token?: string | null,
): Promise<CommandResult<PrReviewComment>> {
  return invokeProviderCommand<PrReviewComment>("add_gitlab_mr_comment", {
    instanceUrl,
    projectPath,
    mrIid,
    body,
    token,
  });
}

// GitLab Issues

export async function listGitLabIssues(
  instanceUrl: string,
  projectPath: string,
  state?: string,
  labels?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabIssue[]>> {
  return invokeProviderCommand<GitLabIssue[]>("list_gitlab_issues", {
    instanceUrl,
    projectPath,
    state,
    labels,
    perPage,
    token,
  });
}

export async function createGitLabIssue(
  instanceUrl: string,
  projectPath: string,
  input: CreateGitLabIssueInput,
  token?: string | null,
): Promise<CommandResult<GitLabIssue>> {
  return invokeProviderCommand<GitLabIssue>("create_gitlab_issue", {
    instanceUrl,
    projectPath,
    input,
    token,
  });
}

// GitLab Pipelines

export async function listGitLabPipelines(
  instanceUrl: string,
  projectPath: string,
  status?: string,
  perPage?: number,
  token?: string | null,
): Promise<CommandResult<GitLabPipeline[]>> {
  return invokeProviderCommand<GitLabPipeline[]>("list_gitlab_pipelines", {
    instanceUrl,
    projectPath,
    status,
    perPage,
    token,
  });
}

export async function getGitLabLabels(
  instanceUrl: string,
  projectPath: string,
  token?: string | null,
): Promise<CommandResult<string[]>> {
  return invokeProviderCommand<string[]>("get_gitlab_labels", {
    instanceUrl,
    projectPath,
    token,
  });
}

// =======================
// Bitbucket Integration
// =======================

export interface BitbucketUser {
  uuid: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface BitbucketConnectionStatus {
  connected: boolean;
  user: BitbucketUser | null;
}

export interface DetectedBitbucketRepo {
  workspace: string;
  repoSlug: string;
  remoteName: string;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: BitbucketUser;
  createdOn: string;
  sourceBranch: string;
  destinationBranch: string;
  url: string;
}

export interface CreateBitbucketPullRequestInput {
  title: string;
  description?: string;
  sourceBranch: string;
  destinationBranch: string;
  closeSourceBranch?: boolean;
}

export interface BitbucketIssue {
  id: number;
  title: string;
  content: string | null;
  state: string;
  priority: string;
  kind: string;
  reporter: BitbucketUser | null;
  assignee: BitbucketUser | null;
  createdOn: string;
  url: string;
}

export interface BitbucketPipeline {
  uuid: string;
  buildNumber: number;
  stateName: string;
  resultName: string | null;
  targetBranch: string;
  createdOn: string;
  completedOn: string | null;
  url: string;
}

// Bitbucket Credential Management (using OS keyring)

export async function storeBitbucketCredentials(
  username: string,
  appPassword: string,
): Promise<CommandResult<void>> {
  try {
    const { BitbucketCredentials } = await import("../credential.service.ts");
    await BitbucketCredentials.setCredentials(username, appPassword);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function getBitbucketCredentials(): Promise<
  CommandResult<[string, string] | null>
> {
  try {
    const { BitbucketCredentials } = await import("../credential.service.ts");
    const creds = await BitbucketCredentials.getCredentials();
    if (creds) {
      return { success: true, data: [creds.username, creds.password] };
    }
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

export async function deleteBitbucketCredentials(): Promise<
  CommandResult<void>
> {
  try {
    const { BitbucketCredentials } = await import("../credential.service.ts");
    await BitbucketCredentials.deleteCredentials();
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: { code: "CREDENTIAL_ERROR", message: String(error) },
    };
  }
}

// Bitbucket Connection

export async function checkBitbucketConnection(): Promise<
  CommandResult<BitbucketConnectionStatus>
> {
  // Get credentials from credential service and pass to backend
  const credsResult = await getBitbucketCredentials();
  let username: string | null = null;
  let appPassword: string | null = null;
  if (credsResult.success && credsResult.data) {
    [username, appPassword] = credsResult.data;
  }
  return invokeProviderCommand<BitbucketConnectionStatus>(
    "check_bitbucket_connection",
    { username, appPassword },
  );
}

/**
 * Check Bitbucket connection with a specific OAuth token
 */
export async function checkBitbucketConnectionWithToken(
  token: string,
): Promise<CommandResult<BitbucketConnectionStatus>> {
  return invokeProviderCommand<BitbucketConnectionStatus>(
    "check_bitbucket_connection_with_token",
    { token },
  );
}

export async function detectBitbucketRepo(
  path: string,
): Promise<CommandResult<DetectedBitbucketRepo | null>> {
  return invokeCommand<DetectedBitbucketRepo | null>("detect_bitbucket_repo", {
    path,
  });
}

// Bitbucket Pull Requests

export async function listBitbucketPullRequests(
  workspace: string,
  repoSlug: string,
  state?: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest[]>> {
  return invokeProviderCommand<BitbucketPullRequest[]>("list_bitbucket_pull_requests", {
    workspace,
    repoSlug,
    state,
    pagelen,
    token,
  });
}

export async function getBitbucketPullRequest(
  workspace: string,
  repoSlug: string,
  prId: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest>> {
  return invokeProviderCommand<BitbucketPullRequest>("get_bitbucket_pull_request", {
    workspace,
    repoSlug,
    prId,
    token,
  });
}

export async function createBitbucketPullRequest(
  workspace: string,
  repoSlug: string,
  input: CreateBitbucketPullRequestInput,
  token?: string | null,
): Promise<CommandResult<BitbucketPullRequest>> {
  return invokeProviderCommand<BitbucketPullRequest>("create_bitbucket_pull_request", {
    workspace,
    repoSlug,
    input,
    token,
  });
}

export async function getBitbucketPrComments(
  workspace: string,
  repoSlug: string,
  prId: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment[]>> {
  return invokeProviderCommand<PrReviewComment[]>("get_bitbucket_pr_comments", {
    workspace,
    repoSlug,
    prId,
    token,
  });
}

export async function addBitbucketPrComment(
  workspace: string,
  repoSlug: string,
  prId: number,
  content: string,
  filePath?: string,
  line?: number,
  token?: string | null,
): Promise<CommandResult<PrReviewComment>> {
  return invokeProviderCommand<PrReviewComment>("add_bitbucket_pr_comment", {
    workspace,
    repoSlug,
    prId,
    content,
    filePath,
    line,
    token,
  });
}

// Bitbucket Issues

export async function listBitbucketIssues(
  workspace: string,
  repoSlug: string,
  state?: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketIssue[]>> {
  return invokeProviderCommand<BitbucketIssue[]>("list_bitbucket_issues", {
    workspace,
    repoSlug,
    state,
    pagelen,
    token,
  });
}

export interface CreateBitbucketIssueInput {
  title: string;
  content?: string;
  kind?: string;
  priority?: string;
}

export async function createBitbucketIssue(
  workspace: string,
  repoSlug: string,
  input: CreateBitbucketIssueInput,
  token?: string | null,
): Promise<CommandResult<BitbucketIssue>> {
  return invokeProviderCommand<BitbucketIssue>("create_bitbucket_issue", {
    workspace,
    repoSlug,
    input,
    token,
  });
}

// Bitbucket Pipelines

export async function listBitbucketPipelines(
  workspace: string,
  repoSlug: string,
  pagelen?: number,
  token?: string | null,
): Promise<CommandResult<BitbucketPipeline[]>> {
  return invokeProviderCommand<BitbucketPipeline[]>("list_bitbucket_pipelines", {
    workspace,
    repoSlug,
    pagelen,
    token,
  });
}

// ============================================================================
// Account Repository Listings
// ============================================================================

/**
 * One repository owned by (or shared with) a connected account.
 *
 * Every provider's listing command normalises into this shape, so the clone
 * dialog's picker renders one list whatever the account is.
 */
export interface ProviderRepository {
  /** Provider-assigned id, stringified. Used as the list key only. */
  id: string;
  name: string;
  /** Owner / namespace / workspace / project the repository lives under. */
  owner: string;
  /** "owner/name" as the provider spells it. */
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  /** HTTPS clone URL — what selecting the repository fills in. */
  cloneUrl: string;
  webUrl: string | null;
  defaultBranch: string | null;
  /** ISO timestamp of the last push, when the provider reports one. */
  lastPushedAt: string | null;
}

/** One page of an account's repository listing. */
export interface ProviderRepositoryPage {
  repositories: ProviderRepository[];
  /** Page to request next, or null when the listing is exhausted. */
  nextPage: number | null;
}

/** List the repositories a GitHub account can clone (one page per call). */
export async function listGitHubRepositories(
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ProviderRepositoryPage>> {
  return invokeProviderCommand<ProviderRepositoryPage>("list_github_repositories", {
    perPage,
    page,
    token,
  });
}

/** List the projects a GitLab account is a member of (one page per call). */
export async function listGitLabProjects(
  instanceUrl: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ProviderRepositoryPage>> {
  return invokeProviderCommand<ProviderRepositoryPage>("list_gitlab_projects", {
    instanceUrl,
    perPage,
    page,
    token,
  });
}

/**
 * List the repositories a Bitbucket account can clone (one page per call).
 * A workspace narrows the listing; omitting it lists every workspace the
 * account belongs to.
 */
export async function listBitbucketRepositories(
  workspace?: string | null,
  pagelen?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ProviderRepositoryPage>> {
  return invokeProviderCommand<ProviderRepositoryPage>("list_bitbucket_repositories", {
    workspace,
    pagelen,
    page,
    token,
  });
}

/** List the Git repositories in an Azure DevOps organization. */
export async function listAdoRepositories(
  organization: string,
  perPage?: number,
  page?: number,
  token?: string | null,
): Promise<CommandResult<ProviderRepositoryPage>> {
  return invokeProviderCommand<ProviderRepositoryPage>("list_ado_repositories", {
    organization,
    perPage,
    page,
    token,
  });
}

// ============================================================================
// Provider User Existence Checks
// ============================================================================

export type ProviderUserExistenceState = 'active' | 'inactive' | 'not_found' | 'unknown';

export interface ProviderUserStatus {
  status: ProviderUserExistenceState;
  matchedName: string | null;
}

export async function checkGitHubUserExists(
  authorName?: string | null,
  authorEmail?: string | null,
  token?: string | null,
): Promise<CommandResult<ProviderUserStatus>> {
  return invokeProviderCommand<ProviderUserStatus>("check_github_user_exists", {
    authorName,
    authorEmail,
    token,
  });
}

export async function checkAdoUserExists(
  organization: string,
  authorName?: string | null,
  authorEmail?: string | null,
  token?: string | null,
): Promise<CommandResult<ProviderUserStatus>> {
  return invokeProviderCommand<ProviderUserStatus>("check_ado_user_exists", {
    organization,
    authorName,
    authorEmail,
    token,
  });
}

export async function checkGitLabUserExists(
  instanceUrl: string,
  authorName?: string | null,
  authorEmail?: string | null,
  token?: string | null,
): Promise<CommandResult<ProviderUserStatus>> {
  return invokeProviderCommand<ProviderUserStatus>("check_gitlab_user_exists", {
    instanceUrl,
    authorName,
    authorEmail,
    token,
  });
}

export async function checkBitbucketUserExists(
  workspace: string,
  authorName?: string | null,
  authorEmail?: string | null,
  token?: string | null,
): Promise<CommandResult<ProviderUserStatus>> {
  return invokeProviderCommand<ProviderUserStatus>("check_bitbucket_user_exists", {
    workspace,
    authorName,
    authorEmail,
    token,
  });
}


// ============================================================================
// PR/MR Templates
// ============================================================================

/** A detected pull request / merge request template */
export interface PrTemplate {
  /** Display name derived from the file name */
  name: string;
  /** Relative path to the template from the repo root */
  path: string;
  /** Whether this is the default template */
  isDefault: boolean;
}

/**
 * Detect PR/MR templates in a repository.
 * Searches well-known GitHub and GitLab template locations.
 */
export async function getPrTemplates(
  repoPath: string,
): Promise<CommandResult<PrTemplate[]>> {
  return invokeCommand<PrTemplate[]>("get_pr_templates", {
    path: repoPath,
  });
}

/**
 * Read the content of a specific PR/MR template.
 */
export async function getPrTemplateContent(
  repoPath: string,
  templatePath: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_pr_template_content", {
    path: repoPath,
    templatePath,
  });
}

// ============================================================================
// Issue Templates
// ============================================================================

/** A detected issue template */
export interface IssueTemplate {
  /** Display name derived from the file name */
  name: string;
  /** Relative path to the template from the repo root */
  path: string;
  /** Whether this is the default template */
  isDefault: boolean;
  /** Optional description extracted from YAML front matter */
  description: string | null;
}

/**
 * Detect issue templates in a repository.
 * Searches well-known GitHub and GitLab template locations.
 */
export async function getIssueTemplates(
  repoPath: string,
): Promise<CommandResult<IssueTemplate[]>> {
  return invokeCommand<IssueTemplate[]>("get_issue_templates", {
    path: repoPath,
  });
}

/**
 * Read the content of a specific issue template.
 */
export async function getIssueTemplateContent(
  repoPath: string,
  templatePath: string,
): Promise<CommandResult<string>> {
  return invokeCommand<string>("get_issue_template_content", {
    path: repoPath,
    templatePath,
  });
}


/**
 * Repository hosting provider types
 */
export type RepositoryProvider =
  | "github"
  | "ado"
  | "gitlab"
  | "bitbucket"
  | null;

/**
 * Integration suggestion result
 */
export interface IntegrationSuggestion {
  provider: RepositoryProvider;
  providerName: string;
  isConfigured: boolean;
  features: string[];
}

/**
 * Detect repository hosting provider and check if integration is configured
 */
export async function detectRepositoryIntegration(
  repoPath: string,
): Promise<IntegrationSuggestion | null> {
  // Import the store to check for configured accounts
  const { unifiedProfileStore } =
    await import("../../stores/unified-profile.store.ts");
  const accounts = unifiedProfileStore.getState().accounts;

  // Helper to check if an account of a given type exists
  const hasAccountOfType = (
    type: "github" | "gitlab" | "azure-devops" | "bitbucket",
  ): boolean => {
    return accounts.some((account) => account.integrationType === type);
  };

  // Try to detect each provider in parallel
  const [githubResult, adoResult, gitlabResult, bitbucketResult] =
    await Promise.all([
      detectGitHubRepo(repoPath),
      detectAdoRepo(repoPath),
      detectGitLabRepo(repoPath),
      detectBitbucketRepo(repoPath),
    ]);

  // Check GitHub
  if (githubResult.success && githubResult.data) {
    return {
      provider: "github",
      providerName: "GitHub",
      isConfigured: hasAccountOfType("github"),
      features: [
        "Pull request overlays",
        "Create PRs from branches",
        "Link issues",
      ],
    };
  }

  // Check Azure DevOps
  if (adoResult.success && adoResult.data) {
    return {
      provider: "ado",
      providerName: "Azure DevOps",
      isConfigured: hasAccountOfType("azure-devops"),
      features: ["Pull request overlays", "Work item linking"],
    };
  }

  // Check GitLab
  if (gitlabResult.success && gitlabResult.data) {
    return {
      provider: "gitlab",
      providerName: "GitLab",
      isConfigured: hasAccountOfType("gitlab"),
      features: ["Merge request overlays", "Issue linking"],
    };
  }

  // Check Bitbucket
  if (bitbucketResult.success && bitbucketResult.data) {
    return {
      provider: "bitbucket",
      providerName: "Bitbucket",
      isConfigured: hasAccountOfType("bitbucket"),
      features: ["Pull request overlays"],
    };
  }

  return null;
}


// ============================================================================
// JIRA Integration
// ============================================================================

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey?: string | null;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  assignee: string | null;
  priority: string | null;
  url: string;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface GenerateBranchFromIssueOptions {
  issueKey: string;
  summary: string;
  prefix?: string;
}

export async function getJiraConfig(
  path: string,
): Promise<CommandResult<JiraConfig | null>> {
  return invokeCommand<JiraConfig | null>("get_jira_config", { path });
}

export async function saveJiraConfig(
  path: string,
  config: JiraConfig,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("save_jira_config", { path, config });
}

export async function deleteJiraConfig(
  path: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_jira_config", { path });
}

async function checkJiraNetworkAllowed(
  path?: string,
  config?: JiraConfig,
): Promise<boolean> {
  if (!isNetworkPolicyActive()) return true;
  let baseUrl = config?.baseUrl ?? null;
  if (!baseUrl && path) {
    const res = await invokeCommand<JiraConfig | null>("get_jira_config", { path });
    if (res.success && res.data) {
      baseUrl = res.data.baseUrl;
    }
  }
  return (await checkNetworkAllowed(null, baseUrl ?? undefined, true)) === null;
}

export async function testJiraConnection(
  pathOrConfig: string | JiraConfig,
  config?: JiraConfig,
): Promise<CommandResult<boolean>> {
  if (typeof pathOrConfig === "string") {
    if (!await checkJiraNetworkAllowed(pathOrConfig, config)) {
      return blockedResult();
    }
    return invokeCommand<boolean>("test_jira_connection", {
      path: pathOrConfig,
      ...(config ? { config } : {}),
    });
  }
  if (!await checkJiraNetworkAllowed(undefined, pathOrConfig)) {
    return blockedResult();
  }
  return invokeCommand<boolean>("test_jira_connection", {
    config: pathOrConfig,
  });
}

export async function getJiraIssues(
  path: string,
  jql?: string,
  maxResults?: number,
): Promise<CommandResult<JiraIssue[]>> {
  if (!await checkJiraNetworkAllowed(path)) {
    return blockedResult();
  }
  return invokeCommand<JiraIssue[]>("get_jira_issues", {
    path,
    ...(jql !== undefined ? { jql } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
  });
}

export async function getJiraIssue(
  path: string,
  issueKey: string,
): Promise<CommandResult<JiraIssue>> {
  if (!await checkJiraNetworkAllowed(path)) {
    return blockedResult();
  }
  return invokeCommand<JiraIssue>("get_jira_issue", { path, issueKey });
}

export async function getJiraTransitions(
  path: string,
  issueKey: string,
): Promise<CommandResult<JiraTransition[]>> {
  if (!await checkJiraNetworkAllowed(path)) {
    return blockedResult();
  }
  return invokeCommand<JiraTransition[]>("get_jira_transitions", {
    path,
    issueKey,
  });
}

export async function transitionJiraIssue(
  path: string,
  issueKey: string,
  transitionId: string,
): Promise<CommandResult<void>> {
  if (!await checkJiraNetworkAllowed(path)) {
    return blockedResult();
  }
  return invokeCommand<void>("transition_jira_issue", {
    path,
    issueKey,
    transitionId,
  });
}

export async function createBranchFromJira(
  path: string,
  issueKey: string,
  branchType?: string,
): Promise<CommandResult<string>> {
  if (!await checkJiraNetworkAllowed(path)) {
    return blockedResult();
  }
  return invokeCommand<string>("create_branch_from_jira", {
    path,
    issueKey,
    ...(branchType !== undefined ? { branchType } : {}),
  });
}

export function generateBranchFromIssue(
  options: GenerateBranchFromIssueOptions | string,
  summaryArg?: string,
  prefixArg?: string,
): string {
  const issueKey = typeof options === "string" ? options : options.issueKey;
  const summary = typeof options === "string" ? (summaryArg ?? "") : options.summary;
  const prefix = typeof options === "string" ? (prefixArg ?? "feature") : (options.prefix ?? "feature");

  const sanitized = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

  const maxLen = 50;
  let truncated = sanitized;
  if (truncated.length > maxLen) {
    const cutPos = truncated.lastIndexOf("-", maxLen);
    truncated =
      cutPos > 10
        ? truncated.substring(0, cutPos)
        : truncated.substring(0, maxLen);
  }
  truncated = truncated.replace(/-+$/, "");

  const base = truncated ? `${issueKey}-${truncated}` : issueKey;
  return prefix ? `${prefix}/${base}` : base;
}

