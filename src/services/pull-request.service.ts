/**
 * Shared hosting-provider pull/merge request access for the sidebar.
 *
 * The four provider dialogs (`lv-github-dialog` and friends) each own a full
 * account picker, connection flow and create form. This module is deliberately
 * NOT another copy of that: it is the thin, read-only slice the sidebar needs —
 * "which provider is this repository on", "what token do we have for it", and
 * "list its open requests" — normalised into one shape so the sidebar renders
 * one list instead of four.
 *
 * Everything here routes through `git.service`, so the provider network calls
 * stay behind the same offline-mode / allowlist gate as every other provider
 * call (see `invokeProviderCommand`). The `detect_*_repo` commands are NOT
 * gated: they only read the repository's own remote configuration and make no
 * network call.
 */

import * as gitService from './git.service.ts';
import type {
  DetectedAdoRepo,
  DetectedBitbucketRepo,
  DetectedGitHubRepo,
  DetectedGitLabRepo,
} from './git.service.ts';
import type { CommandResult } from '../types/api.types.ts';
import * as credentialService from './credential.service.ts';
import {
  getAccountById,
  getActiveProfilePreferredAccount,
  unifiedProfileStore,
} from '../stores/unified-profile.store.ts';
import * as unifiedProfileService from './unified-profile.service.ts';

/** The hosting providers that can back the sidebar's request list. */
export type PullRequestProviderId = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops';

/** A detected provider plus the coordinates its API calls need. */
export interface PullRequestProviderTarget {
  provider: PullRequestProviderId;
  /** Display name, e.g. "GitLab". */
  providerName: string;
  /** "pull request" everywhere except GitLab, which calls them merge requests. */
  itemNoun: string;
  /** Plural of {@link itemNoun}. */
  itemNounPlural: string;
  /** Title-case plural used for headings, e.g. "Merge Requests". */
  itemNounTitle: string;
  /** Human label for the detected repository, e.g. "owner/repo". */
  repoLabel: string;
  github?: DetectedGitHubRepo;
  gitlab?: DetectedGitLabRepo;
  bitbucket?: DetectedBitbucketRepo;
  ado?: DetectedAdoRepo;
}

/** One open request, normalised across the four providers. */
export interface SidebarPullRequest {
  /** Stable identity for list keying: provider id + number. */
  key: string;
  /** The number the provider shows the user (`number` / `iid` / `id`). */
  number: number;
  title: string;
  /** Display name or login of whoever opened it; empty when unknown. */
  author: string;
  /** Web URL, opened in the browser on click. */
  url: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  /**
   * Short merge/review status, ONLY where the provider's existing list command
   * already returns one (GitHub's `mergeable`, GitLab's `mergeStatus`). Null
   * everywhere else rather than invented — the alternative would be a second
   * API round trip per row.
   */
  status: string | null;
}

/** Number of open requests fetched for the sidebar list. */
const SIDEBAR_PAGE_SIZE = 30;

/**
 * Provider detection cache, keyed by repository path.
 *
 * Detection reads the repo's remotes over IPC (four commands), and both the
 * sidebar list and the branch context menu need the answer. Caching it keeps
 * the context menu's "Create pull request…" entry from having to resolve
 * asynchronously under the user's cursor, and keeps an expanded list section
 * from re-detecting on every refresh.
 */
const detectionCache = new Map<string, PullRequestProviderTarget | null>();
/** In-flight detections, so concurrent callers share one round of IPC. */
const detectionInFlight = new Map<string, Promise<PullRequestProviderTarget | null>>();

/**
 * Forget cached detection. Called when a repository's remotes may have changed
 * (a `repository-refresh`), because adding or re-pointing `origin` changes the
 * answer and a stale "no provider" would silently disable the menu entry.
 */
export function invalidateProviderDetection(repoPath?: string): void {
  if (repoPath) {
    detectionCache.delete(repoPath);
    detectionInFlight.delete(repoPath);
  } else {
    detectionCache.clear();
    detectionInFlight.clear();
  }
}

/** Strip `refs/heads/` from an Azure DevOps ref name for display. */
function shortRef(refName: string): string {
  return refName.replace(/^refs\/heads\//, '');
}

/**
 * Which hosting provider backs this repository, or null when none is detected.
 *
 * Order matches `detectRepositoryIntegration` in git.service so the two never
 * disagree about a repo that somehow matches more than one provider.
 */
export async function detectPullRequestProvider(
  repoPath: string,
  options?: { force?: boolean },
): Promise<PullRequestProviderTarget | null> {
  if (!repoPath) return null;
  if (options?.force) {
    detectionCache.delete(repoPath);
    detectionInFlight.delete(repoPath);
  } else {
    if (detectionCache.has(repoPath)) return detectionCache.get(repoPath) ?? null;
    const pending = detectionInFlight.get(repoPath);
    if (pending) return pending;
  }

  const run = (async (): Promise<PullRequestProviderTarget | null> => {
    const [github, ado, gitlab, bitbucket] = await Promise.all([
      gitService.detectGitHubRepo(repoPath),
      gitService.detectAdoRepo(repoPath),
      gitService.detectGitLabRepo(repoPath),
      gitService.detectBitbucketRepo(repoPath),
    ]);

    let target: PullRequestProviderTarget | null = null;
    if (github.success && github.data) {
      target = {
        provider: 'github',
        providerName: 'GitHub',
        itemNoun: 'pull request',
        itemNounPlural: 'pull requests',
        itemNounTitle: 'Pull Requests',
        repoLabel: `${github.data.owner}/${github.data.repo}`,
        github: github.data,
      };
    } else if (ado.success && ado.data) {
      target = {
        provider: 'azure-devops',
        providerName: 'Azure DevOps',
        itemNoun: 'pull request',
        itemNounPlural: 'pull requests',
        itemNounTitle: 'Pull Requests',
        repoLabel: `${ado.data.project}/${ado.data.repository}`,
        ado: ado.data,
      };
    } else if (gitlab.success && gitlab.data) {
      target = {
        provider: 'gitlab',
        providerName: 'GitLab',
        itemNoun: 'merge request',
        itemNounPlural: 'merge requests',
        itemNounTitle: 'Merge Requests',
        repoLabel: gitlab.data.projectPath,
        gitlab: gitlab.data,
      };
    } else if (bitbucket.success && bitbucket.data) {
      target = {
        provider: 'bitbucket',
        providerName: 'Bitbucket',
        itemNoun: 'pull request',
        itemNounPlural: 'pull requests',
        itemNounTitle: 'Pull Requests',
        repoLabel: `${bitbucket.data.workspace}/${bitbucket.data.repoSlug}`,
        bitbucket: bitbucket.data,
      };
    }

    detectionCache.set(repoPath, target);
    return target;
  })();

  detectionInFlight.set(repoPath, run);
  try {
    return await run;
  } finally {
    detectionInFlight.delete(repoPath);
  }
}

/**
 * The token the sidebar should use for this provider, or null when the user
 * has not connected an account for it.
 *
 * Mirrors each dialog's own `getSelectedAccountToken()`: the profile's
 * preferred account first (falling back to the global default), refreshed when
 * an OAuth access token is near expiry. GitHub and Azure DevOps additionally
 * fall back to their legacy single-account credential, exactly as their dialogs
 * do, so a user who never migrated is not told they are disconnected.
 */
export async function getProviderToken(
  target: PullRequestProviderTarget,
): Promise<string | null> {
  // Every provider dialog loads the unified profiles before reading accounts.
  // The sidebar can ask earlier than that -- before the app's own
  // initialisation has finished, or while a profile migration is pending -- and
  // an unloaded store would report a connected user as "not connected".
  if (unifiedProfileStore.getState().accounts.length === 0) {
    await unifiedProfileService.loadUnifiedProfiles();
  }

  switch (target.provider) {
    case 'github': {
      // getGitHubToken() already resolves account-then-legacy for GitHub.
      const result = await gitService.getGitHubToken();
      return result.success ? (result.data ?? null) : null;
    }
    case 'gitlab': {
      const account = getActiveProfilePreferredAccount('gitlab');
      if (!account) return null;
      // Refresh against the instance the ACCOUNT was created on, never the
      // detected repo's instance — same guard as lv-gitlab-dialog.
      const stored = getAccountById(account.id);
      const instanceUrl =
        stored?.config.type === 'gitlab' ? stored.config.instanceUrl : undefined;
      return credentialService.getFreshAccountToken(
        'gitlab',
        account.id,
        'gitlab',
        instanceUrl || undefined,
      );
    }
    case 'bitbucket': {
      const account = getActiveProfilePreferredAccount('bitbucket');
      if (!account) return null;
      return credentialService.getFreshAccountToken('bitbucket', account.id, 'bitbucket');
    }
    case 'azure-devops': {
      const account = getActiveProfilePreferredAccount('azure-devops');
      const token = account
        ? await credentialService.getFreshAccountToken('azure-devops', account.id, 'azure')
        : null;
      return token ?? (await credentialService.AzureDevOpsCredentials.getToken());
    }
  }
}

/**
 * Open requests for a detected provider, normalised.
 *
 * Returns the raw `CommandResult` shape so callers can tell the security
 * gate's refusal (`BLOCKED`) apart from a real API failure — the gate stays
 * silent for provider calls, so the caller has to explain it in place.
 */
export async function listOpenPullRequests(
  target: PullRequestProviderTarget,
  token: string | null,
): Promise<CommandResult<SidebarPullRequest[]>> {
  switch (target.provider) {
    case 'github': {
      const repo = target.github!;
      const result = await gitService.listPullRequests(
        repo.owner,
        repo.repo,
        'open',
        SIDEBAR_PAGE_SIZE,
        1,
        token,
      );
      if (!result.success) return { success: false, error: result.error };
      return {
        success: true,
        data: (result.data ?? []).map((pr) => ({
          key: `github-${pr.number}`,
          number: pr.number,
          title: pr.title,
          author: pr.user?.name || pr.user?.login || '',
          url: pr.htmlUrl,
          sourceBranch: pr.headRef,
          targetBranch: pr.baseRef,
          draft: pr.draft,
          // `mergeable` is null until GitHub finishes computing it; only an
          // explicit false is a real conflict signal.
          status: pr.mergeable === false ? 'Conflicts' : null,
        })),
      };
    }
    case 'azure-devops': {
      const repo = target.ado!;
      const result = await gitService.listAdoPullRequests(
        repo.organization,
        repo.project,
        repo.repository,
        'active',
        SIDEBAR_PAGE_SIZE,
        token,
      );
      if (!result.success) return { success: false, error: result.error };
      return {
        success: true,
        data: (result.data ?? []).map((pr) => ({
          key: `ado-${pr.pullRequestId}`,
          number: pr.pullRequestId,
          title: pr.title,
          author: pr.createdBy?.displayName || '',
          url: pr.url,
          sourceBranch: shortRef(pr.sourceRefName),
          targetBranch: shortRef(pr.targetRefName),
          draft: pr.isDraft,
          status: null,
        })),
      };
    }
    case 'gitlab': {
      const repo = target.gitlab!;
      const result = await gitService.listGitLabMergeRequests(
        repo.instanceUrl,
        repo.projectPath,
        'opened',
        SIDEBAR_PAGE_SIZE,
        token,
      );
      if (!result.success) return { success: false, error: result.error };
      return {
        success: true,
        data: (result.data ?? []).map((mr) => ({
          key: `gitlab-${mr.iid}`,
          number: mr.iid,
          title: mr.title,
          author: mr.author?.name || mr.author?.username || '',
          url: mr.webUrl,
          sourceBranch: mr.sourceBranch,
          targetBranch: mr.targetBranch,
          draft: mr.draft,
          status: mr.mergeStatus === 'cannot_be_merged' ? 'Conflicts' : null,
        })),
      };
    }
    case 'bitbucket': {
      const repo = target.bitbucket!;
      const result = await gitService.listBitbucketPullRequests(
        repo.workspace,
        repo.repoSlug,
        'OPEN',
        SIDEBAR_PAGE_SIZE,
        token,
      );
      if (!result.success) return { success: false, error: result.error };
      return {
        success: true,
        data: (result.data ?? []).map((pr) => ({
          key: `bitbucket-${pr.id}`,
          number: pr.id,
          title: pr.title,
          author: pr.author?.displayName || pr.author?.username || '',
          url: pr.url,
          sourceBranch: pr.sourceBranch,
          targetBranch: pr.destinationBranch,
          draft: false,
          status: null,
        })),
      };
    }
  }
}
