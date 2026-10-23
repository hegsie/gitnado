/**
 * GitHub Dialog Integration Tests
 *
 * Tests the lv-github-dialog Lit component for rendering, connection,
 * tab navigation, data display, and error handling with mocked Tauri backend.
 */

// Mock Tauri API before importing any modules that use it
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args: unknown }> = [];
const keyringStore = new Map<string, string>();

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } })
  .__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore, selectDefaultGlobalAccount } from '../../../stores/unified-profile.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import * as oauthService from '../../../services/oauth.service.ts';
import { createEmptyIntegrationAccount } from '../../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';
import '../lv-github-dialog.ts';
import type { LvGitHubDialog } from '../lv-github-dialog.ts';

// --- Test Data ---

const mockGitHubUser = {
  login: 'octocat',
  id: 12345,
  avatarUrl: 'https://example.com/avatar.png',
  name: 'The Octocat',
  email: 'octocat@github.com',
};

const mockConnectedStatus = {
  connected: true,
  user: mockGitHubUser,
  scopes: ['repo', 'read:user'],
};

const mockDisconnectedStatus = {
  connected: false,
  user: null,
  scopes: [],
};

const mockDetectedRepo = {
  owner: 'test-owner',
  repo: 'test-repo',
  remoteName: 'origin',
};

const mockPullRequests = [
  {
    number: 42,
    title: 'Add new feature',
    state: 'open',
    user: mockGitHubUser,
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-16T10:00:00Z',
    mergedAt: null,
    headRef: 'feature/new-thing',
    headSha: 'abc1234',
    baseRef: 'main',
    draft: false,
    mergeable: true,
    htmlUrl: 'https://github.com/test-owner/test-repo/pull/42',
    additions: 150,
    deletions: 30,
    changedFiles: 5,
  },
  {
    number: 41,
    title: 'Fix bug in login',
    state: 'closed',
    user: mockGitHubUser,
    createdAt: '2025-01-10T10:00:00Z',
    updatedAt: '2025-01-12T10:00:00Z',
    mergedAt: '2025-01-12T10:00:00Z',
    headRef: 'fix/login-bug',
    headSha: 'def5678',
    baseRef: 'main',
    draft: false,
    mergeable: null,
    htmlUrl: 'https://github.com/test-owner/test-repo/pull/41',
    additions: 10,
    deletions: 5,
    changedFiles: 2,
  },
];

const mockIssues = [
  {
    number: 100,
    title: 'Bug: Login fails on mobile',
    state: 'open',
    user: mockGitHubUser,
    labels: [
      { id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' },
      { id: 2, name: 'priority: high', color: 'e11d48', description: null },
    ],
    assignees: [],
    comments: 3,
    createdAt: '2025-01-10T10:00:00Z',
    updatedAt: '2025-01-11T10:00:00Z',
    closedAt: null,
    htmlUrl: 'https://github.com/test-owner/test-repo/issues/100',
  },
];

const mockWorkflowRuns = [
  {
    id: 1001,
    name: 'CI',
    headBranch: 'main',
    headSha: 'abc1234',
    status: 'completed',
    conclusion: 'success',
    workflowId: 10,
    htmlUrl: 'https://github.com/test-owner/test-repo/actions/runs/1001',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:05:00Z',
    runNumber: 55,
    event: 'push',
  },
];

const mockReleases = [
  {
    id: 2001,
    tagName: 'v1.0.0',
    name: 'Version 1.0.0',
    body: 'First stable release',
    draft: false,
    prerelease: false,
    createdAt: '2025-01-01T10:00:00Z',
    publishedAt: '2025-01-01T12:00:00Z',
    htmlUrl: 'https://github.com/test-owner/test-repo/releases/tag/v1.0.0',
    author: mockGitHubUser,
    assetsCount: 2,
  },
];

const mockLabels = [
  { id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  { id: 2, name: 'enhancement', color: 'a2eeef', description: 'New feature' },
];

const mockPrComments = [
  {
    id: '101',
    author: 'octocat',
    avatarUrl: 'https://example.com/avatar.png',
    body: 'General review note',
    createdAt: '2025-01-15T11:00:00Z',
    filePath: null,
    line: null,
  },
  {
    id: '102',
    author: 'reviewer2',
    avatarUrl: null,
    body: 'Please handle null here',
    createdAt: '2025-01-15T11:05:00Z',
    filePath: 'src/auth.ts',
    line: 27,
  },
];

function createTestAccount(
  overrides: Partial<IntegrationAccount> & { id: string }
): IntegrationAccount {
  const base = createEmptyIntegrationAccount(overrides.integrationType ?? 'github');
  return {
    ...base,
    name: 'Test Account',
    isDefault: true,
    cachedUser: null,
    ...overrides,
  } as IntegrationAccount;
}

async function waitForLoad(el: LvGitHubDialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 300));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 100));
  await el.updateComplete;
}

// --- Mock Setup ---

const mockAccount = createTestAccount({
  id: 'gh-acc-1',
  name: 'Work GitHub',
  integrationType: 'github',
  isDefault: true,
  cachedUser: {
    username: 'octocat',
    displayName: 'The Octocat',
    avatarUrl: 'https://example.com/avatar.png',
    email: 'octocat@github.com',
  },
});

let connectionResponse: unknown = mockDisconnectedStatus;
let detectedRepoResponse: unknown = mockDetectedRepo;
let appConfigResponse: unknown = { connected: true, user: null, scopes: ['app-installation'] };

// --- Page-aware list responses (pagination tests) ---
// When set, the list mocks answer from the requested `page` argument instead of
// returning the same fixture for every call.
let prPages: Record<number, unknown[]> | null = null;
let prPageThatFails: number | null = null;
// A pull-request page parked on a promise, so a test can hold one page load in
// flight while another restarts the list.
let prPageGates: Record<number, Promise<void>> = {};
let runPageThatFails: number | null = null;
let issuePages: Record<number, { issues: unknown[]; nextPage: number | null }> | null = null;
let releasePages: Record<number, unknown[]> | null = null;
let runPages: Record<number, unknown[]> | null = null;

function requestedPage(params: Record<string, unknown> | undefined): number {
  return Number((params as { page?: number } | undefined)?.page ?? 1);
}

/** `count` synthetic pull requests numbered downwards from `startNumber`. */
function makePullRequests(count: number, startNumber: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    ...mockPullRequests[0],
    number: startNumber - i,
    title: `Generated PR ${startNumber - i}`,
    htmlUrl: `https://github.com/test-owner/test-repo/pull/${startNumber - i}`,
  }));
}

function makeReleases(count: number, startIndex: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    ...mockReleases[0],
    id: startIndex + i,
    tagName: `v${startIndex + i}.0.0`,
    name: `Version ${startIndex + i}`,
  }));
}

function makeWorkflowRuns(count: number, startIndex: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    ...mockWorkflowRuns[0],
    id: startIndex + i,
    runNumber: startIndex + i,
  }));
}

function setupMockInvoke(): void {
  keyringStore.clear();
  keyringStore.set('github_token_gh-acc-1', 'ghp_testtoken123456');

  mockInvoke = async (command: string, args?: unknown) => {
    const params = args as Record<string, unknown> | undefined;

    // Credential service (OS keyring)
    if (command === 'get_keyring_token') {
      const key = (params as Record<string, string>)?.key;
      return keyringStore.get(key) ?? null;
    }
    if (command === 'store_keyring_token') {
      const { key, value } = params as Record<string, string>;
      keyringStore.set(key, value);
      return null;
    }
    if (command === 'delete_keyring_token') {
      const key = (params as Record<string, string>)?.key;
      keyringStore.delete(key);
      return null;
    }

    // Unified profile commands
    if (command === 'get_unified_profiles_config') {
      return {
        version: 3,
        profiles: [],
        accounts: [mockAccount],
        repositoryAssignments: {},
      };
    }
    if (command === 'load_unified_profile_for_repository') return null;
    if (command === 'save_global_account') return params;
    if (command === 'update_global_account_cached_user') return null;

    // GitHub App (M1)
    if (command === 'configure_github_app') return appConfigResponse;
    if (command === 'get_github_app_config') return null;
    if (command === 'remove_github_app_config') return null;

    // GitHub-specific commands
    if (command === 'check_github_connection') return connectionResponse;
    if (command === 'check_github_connection_with_token') return connectionResponse;
    if (command === 'detect_github_repo') return detectedRepoResponse;
    if (command === 'list_pull_requests') {
      const page = requestedPage(params);
      const gate = prPageGates[page];
      if (gate) await gate;
      if (prPageThatFails !== null && page === prPageThatFails) {
        throw new Error('Rate limit exceeded');
      }
      return prPages ? (prPages[page] ?? []) : mockPullRequests;
    }
    if (command === 'list_issues' || command === 'list_github_issues') {
      const page = requestedPage(params);
      return issuePages
        ? (issuePages[page] ?? { issues: [], nextPage: null })
        : { issues: mockIssues, nextPage: null };
    }
    if (command === 'get_workflow_runs') {
      const page = requestedPage(params);
      if (runPageThatFails !== null && page === runPageThatFails) {
        throw new Error('Rate limit exceeded');
      }
      return runPages ? (runPages[page] ?? []) : mockWorkflowRuns;
    }
    if (command === 'list_releases') {
      const page = requestedPage(params);
      return releasePages ? (releasePages[page] ?? []) : mockReleases;
    }
    if (command === 'get_github_labels' || command === 'get_repo_labels') return mockLabels;
    if (command === 'create_pull_request') return mockPullRequests[0];
    if (command === 'create_issue' || command === 'create_github_issue') return mockIssues[0];
    if (command === 'create_release' || command === 'create_github_release') return mockReleases[0];
    if (command === 'get_github_pr_comments') return mockPrComments;
    if (command === 'add_github_pr_comment') {
      return {
        id: '103',
        author: 'octocat',
        avatarUrl: 'https://example.com/avatar.png',
        body: (params as Record<string, string>)?.body ?? '',
        createdAt: '2025-01-15T12:00:00Z',
        filePath: (params as Record<string, string | null>)?.path ?? null,
        line: (params as Record<string, number | null>)?.line ?? null,
      };
    }

    // OAuth
    if (command === 'get_oauth_client_id') return null;

    return null;
  };
}

describe('lv-github-dialog', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    connectionResponse = mockDisconnectedStatus;
    detectedRepoResponse = mockDetectedRepo;
    appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };
    prPages = null;
    prPageThatFails = null;
    prPageGates = {};
    runPageThatFails = null;
    issuePages = null;
    releasePages = null;
    runPages = null;
    unifiedProfileStore.getState().reset();
    setupMockInvoke();
  });

  describe('GitHub App connection (M1)', () => {
    it('reflects the backend-reported status and persists the account when connected', async () => {
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      dialog.appId = '12345';
      dialog.appPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      dialog.appInstallationId = '67890';

      await dialog.handleConnectGitHubApp();

      expect(dialog.connectionStatus?.connected).to.be.true;
      // The account was persisted (real connection, not a hardcoded UI flag).
      expect(invokeHistory.some((c) => c.command === 'configure_github_app')).to.be.true;
      expect(invokeHistory.some((c) => c.command === 'save_global_account')).to.be.true;
    });

    it('does NOT persist a fake account when the backend reports not connected', async () => {
      appConfigResponse = { connected: false, user: null, scopes: [] };
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      dialog.appId = '12345';
      dialog.appPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      dialog.appInstallationId = '67890';

      await dialog.handleConnectGitHubApp();

      // Must surface an error and NOT flip the UI to connected or save an account.
      expect(dialog.error).to.be.a('string').and.not.empty;
      expect(dialog.connectionStatus?.connected ?? false).to.be.false;
      expect(invokeHistory.some((c) => c.command === 'save_global_account')).to.be.false;
    });
  });

  describe('Rendering & Modal', () => {
    it('renders lv-modal when open=true', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const modal = el.shadowRoot!.querySelector('lv-modal');
      expect(modal).to.not.be.null;
    });

    it('shows all 5 tab buttons', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      expect(tabs.length).to.equal(5);

      const tabTexts = Array.from(tabs).map((t) => t.textContent?.trim());
      expect(tabTexts).to.include('Connection');
      expect(tabTexts).to.include('Pull Requests');
      expect(tabTexts).to.include('Issues');
      expect(tabTexts).to.include('Releases');
      expect(tabTexts).to.include('Actions');
    });

    it('shows detected repo info after load', async () => {
      connectionResponse = mockDisconnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const repoName = el.shadowRoot!.querySelector('.repo-name');
      if (repoName) {
        expect(repoName.textContent).to.include('test-owner');
        expect(repoName.textContent).to.include('test-repo');
      }
    });

    // Regression: these provider dialogs are repo-independent (they stay open
    // when the last repository tab closes), at which point repositoryPath goes
    // to ''. The detected repo must be cleared, or the dialog keeps showing --
    // and acting on -- the repository whose tab was just closed.
    it('clears the detected repo when repositoryPath becomes empty', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);
      expect(
        el.shadowRoot!.querySelectorAll('.repo-name').length,
        'repo header with a repository open'
      ).to.equal(1);

      // Last repository tab closed: the host rebinds repositoryPath to ''.
      el.repositoryPath = '';
      await waitForLoad(el);

      expect(
        el.shadowRoot!.querySelectorAll('.repo-name').length,
        'stale repo header after the last repository tab closed'
      ).to.equal(0);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const repoTab = Array.from(tabs).find(
        (t) => t.textContent?.trim() === 'Pull Requests'
      ) as HTMLButtonElement;
      repoTab.click();
      await waitForLoad(el);

      const emptyText = el.shadowRoot!.querySelector('.empty-state')?.textContent?.trim() ?? '';
      expect(emptyText, 'repo-backed tab after the last repository tab closed').to.contain(
        'No GitHub repository detected'
      );
    });

    // Regression: the dialog outlives the repository, so a detect_github_repo
    // issued for the repository whose tab has since closed can resolve
    // afterwards. Its result must be dropped, or the repo header -- and the
    // repo-backed loaders behind it -- come back for a repository that is gone.
    it('ignores a repository detection that resolves after the repository closed', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Hold the detection open so it can be made to land late.
      const baseInvoke = mockInvoke;
      const pendingDetects: Array<() => void> = [];
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'detect_github_repo') {
          await new Promise<void>((resolve) => pendingDetects.push(resolve));
        }
        return baseInvoke(command, args);
      };

      el.repositoryPath = '/mock/repo';
      await waitForLoad(el);
      expect(pendingDetects.length, 'detection in flight').to.equal(1);
      expect(
        el.shadowRoot!.querySelectorAll('.repo-name').length,
        'repo header while the detection is still in flight'
      ).to.equal(0);

      // Last repository tab closed while the detection was still in flight.
      el.repositoryPath = '';
      await waitForLoad(el);

      pendingDetects.forEach((resolve) => resolve());
      await waitForLoad(el);

      expect(
        el.shadowRoot!.querySelectorAll('.repo-name').length,
        'repo header restored by a detection for the closed repository'
      ).to.equal(0);
    });

    // Regression: a create-* draft is scoped to the repository it was composed
    // against, but the create handlers guard only on the detected repo. Leaving
    // the draft on screen when the dialog is repointed would submit it into the
    // new repository.
    it('drops the pull request draft when the repository changes', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const listTab = Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (t) => t.textContent?.trim() === 'Pull Requests'
      ) as HTMLButtonElement;
      listTab.click();
      await waitForLoad(el);

      const newButton = Array.from(el.shadowRoot!.querySelectorAll('button.btn')).find(
        (b) => b.textContent?.trim() === '+ New PR'
      ) as HTMLButtonElement;
      expect(newButton === undefined, 'missing + New PR button').to.be.false;
      newButton.click();
      await waitForLoad(el);

      const titleInput = el.shadowRoot!.querySelector(
        'input[placeholder="Pull request title"]'
      ) as HTMLInputElement | null;
      expect(titleInput === null, 'missing draft title input').to.be.false;
      titleInput!.value = 'Draft for the first repository';
      titleInput!.dispatchEvent(new Event('input'));
      await waitForLoad(el);

      // The user switches to a different repository with the draft on screen.
      el.repositoryPath = '/mock/other-repo';
      await waitForLoad(el);

      expect(
        el.shadowRoot!.querySelectorAll('input[placeholder="Pull request title"]').length,
        'submittable draft form after the repository changed'
      ).to.equal(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).createPrTitle, 'retained draft title').to.equal('');
    });

    it('shows account selector when accounts exist', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const selector = el.shadowRoot!.querySelector('lv-account-selector');
      expect(selector).to.not.be.null;
    });

    // Wave 5b: the Back arrow is driven by the EXPLICIT backButton flag (set by
    // the host only when opened with a return target), not by global state.
    it('shows the Back arrow only when opened with a return target (backButton=true)', async () => {
      const withBack = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} ?backButton=${true}></lv-github-dialog>
      `);
      await waitForLoad(withBack);
      const backBtn = withBack.shadowRoot!
        .querySelector('lv-modal')!
        .shadowRoot!.querySelector('[aria-label="Back"]');
      expect(backBtn).to.not.be.null;
    });

    it('shows NO Back arrow when opened standalone (backButton=false)', async () => {
      const standalone = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(standalone);
      const modal = standalone.shadowRoot!.querySelector('lv-modal')!;
      expect(modal.shadowRoot!.querySelector('[aria-label="Back"]')).to.be.null;
      // Standalone shows the close × instead.
      expect(modal.shadowRoot!.querySelector('[aria-label="Close"]')).to.not.be.null;
    });

    // Wave 5b: "Adding to <name>" breadcrumb shows only during the attach flow.
    it('shows the "Adding to <name>" breadcrumb when attachToProfileName is set', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .attachToProfileName=${'Work'}></lv-github-dialog>
      `);
      await waitForLoad(el);
      const crumb = el.shadowRoot!.querySelector('[data-testid="attach-breadcrumb"]');
      expect(crumb).to.not.be.null;
      expect(crumb!.textContent).to.include('Work');
    });

    it('shows no breadcrumb when opened standalone', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);
      expect(el.shadowRoot!.querySelector('[data-testid="attach-breadcrumb"]')).to.be.null;
    });

    // Regression: the account-selector dispatches a bubbling/composed
    // `manage-accounts` event. The dialog must CONSUME it and re-emit its own,
    // so the host receives EXACTLY ONE event — not the selector's plus the
    // re-dispatch. The double-fire corrupted the manager's reversible-Back state.
    it('forwards manage-accounts to the host exactly once', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const events: CustomEvent[] = [];
      el.addEventListener('manage-accounts', (e) => events.push(e as CustomEvent));

      const selector = el.shadowRoot!.querySelector('lv-account-selector')!;
      selector.dispatchEvent(
        new CustomEvent('manage-accounts', {
          detail: { integrationType: 'github' },
          bubbles: true,
          composed: true,
        })
      );

      expect(events).to.have.lengthOf(1);
      expect(events[0].detail.integrationType).to.equal('github');
    });
  });

  describe('Connection Tab', () => {
    it('shows auth form when not connected', async () => {
      connectionResponse = mockDisconnectedStatus;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // When disconnected, the token-form or auth-method-toggle should be present
      const tokenForm = el.shadowRoot!.querySelector('.token-form');
      const authToggle = el.shadowRoot!.querySelector('.auth-method-toggle');
      const oauthSection = el.shadowRoot!.querySelector('.oauth-section');
      expect(tokenForm !== null || authToggle !== null || oauthSection !== null).to.be.true;
    });

    // Cross-component contract: verifying a connection here must update the SHARED
    // store status that other views (e.g. the profile manager dots) read.
    it('writes verified connected status to the shared store', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);
      await new Promise((r) => setTimeout(r, 30));

      expect(unifiedProfileStore.getState().accountConnectionStatus['gh-acc-1']?.status).to.equal(
        'connected'
      );
    });

    it('writes disconnected status to the shared store when verification fails', async () => {
      connectionResponse = mockDisconnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);
      await new Promise((r) => setTimeout(r, 30));

      expect(unifiedProfileStore.getState().accountConnectionStatus['gh-acc-1']?.status).to.equal(
        'disconnected'
      );
    });

    it('shows user info when connected', async () => {
      connectionResponse = mockConnectedStatus;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const connectionStatus = el.shadowRoot!.querySelector('.connection-status');
      expect(connectionStatus).to.not.be.null;

      const userName = el.shadowRoot!.querySelector('.user-name');
      expect(userName).to.not.be.null;
      expect(userName!.textContent).to.include('The Octocat');

      const userLogin = el.shadowRoot!.querySelector('.user-login');
      expect(userLogin).to.not.be.null;
      expect(userLogin!.textContent).to.include('octocat');
    });

    it('shows scopes when connected', async () => {
      connectionResponse = mockConnectedStatus;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const scopeBadges = el.shadowRoot!.querySelectorAll('.scope-badge');
      expect(scopeBadges.length).to.equal(2);
      const scopeTexts = Array.from(scopeBadges).map((s) => s.textContent?.trim());
      expect(scopeTexts).to.include('repo');
      expect(scopeTexts).to.include('read:user');
    });

    it('shows disconnect button when connected', async () => {
      connectionResponse = mockConnectedStatus;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const disconnectBtn = el.shadowRoot!.querySelector('.btn-danger');
      expect(disconnectBtn).to.not.be.null;
      expect(disconnectBtn!.textContent?.trim()).to.include('Disconnect');
    });
  });

  describe('Pull Requests Tab', () => {
    it('shows empty state when not connected', async () => {
      connectionResponse = mockDisconnectedStatus;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Pull Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await waitForLoad(el);

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
      expect(emptyState!.textContent).to.include('Connect to GitHub');
    });

    it('renders PR items with number, title, state, and branches', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Pull Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await waitForLoad(el);

      const prItems = el.shadowRoot!.querySelectorAll('.pr-item');
      expect(prItems.length).to.equal(2);

      const firstPr = prItems[0];
      expect(firstPr.querySelector('.pr-number')?.textContent).to.include('42');
      expect(firstPr.querySelector('.pr-title')?.textContent).to.include('Add new feature');
      expect(firstPr.querySelector('.pr-branch')?.textContent).to.include('feature/new-thing');
      expect(firstPr.querySelector('.pr-branch')?.textContent).to.include('main');
    });

    it('shows filter dropdown and New PR button', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Pull Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await waitForLoad(el);

      const filterSelect = el.shadowRoot!.querySelector('.filter-select');
      expect(filterSelect).to.not.be.null;

      const newPrBtn = Array.from(el.shadowRoot!.querySelectorAll('.btn')).find(
        (b) => b.textContent?.trim().includes('New PR')
      );
      expect(newPrBtn).to.not.be.undefined;
    });
  });

  describe('Issues Tab', () => {
    it('renders issue items with number, title, and labels', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Issues tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const issuesTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Issues') as HTMLButtonElement;
      issuesTab.click();
      await waitForLoad(el);

      const issueItems = el.shadowRoot!.querySelectorAll('.issue-item');
      expect(issueItems.length).to.equal(1);

      const firstIssue = issueItems[0];
      expect(firstIssue.querySelector('.issue-number')?.textContent).to.include('100');
      expect(firstIssue.querySelector('.issue-title')?.textContent).to.include('Bug: Login fails on mobile');

      const labels = firstIssue.querySelectorAll('.issue-label');
      expect(labels.length).to.equal(2);
      expect(labels[0].textContent?.trim()).to.equal('bug');
    });
  });

  describe('Releases Tab', () => {
    it('renders release items with tag name and badges', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Releases tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const releasesTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Releases') as HTMLButtonElement;
      releasesTab.click();
      await waitForLoad(el);

      const releaseItems = el.shadowRoot!.querySelectorAll('.release-item');
      expect(releaseItems.length).to.equal(1);

      const firstRelease = releaseItems[0];
      expect(firstRelease.querySelector('.release-tag')?.textContent).to.include('v1.0.0');
      expect(firstRelease.querySelector('.release-title')?.textContent).to.include('Version 1.0.0');

      // First non-draft, non-prerelease should get "Latest" badge
      const latestBadge = firstRelease.querySelector('.release-badge.latest');
      expect(latestBadge).to.not.be.null;
    });
  });

  describe('Actions Tab', () => {
    it('renders workflow runs with status indicators', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Switch to Actions tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const actionsTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Actions') as HTMLButtonElement;
      actionsTab.click();
      await waitForLoad(el);

      const workflowItems = el.shadowRoot!.querySelectorAll('.workflow-item');
      expect(workflowItems.length).to.equal(1);

      const firstRun = workflowItems[0];
      expect(firstRun.querySelector('.workflow-name')?.textContent).to.include('CI');
      expect(firstRun.querySelector('.workflow-branch')?.textContent).to.include('main');

      // Status indicator should exist
      const statusDot = firstRun.querySelector('.workflow-status');
      expect(statusDot).to.not.be.null;
    });
  });

  describe('Tab Navigation', () => {
    it('clicking tab button changes displayed content', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Initially on Connection tab - verify connection content visible
      const connectionStatus = el.shadowRoot!.querySelector('.connection-status');
      expect(connectionStatus).to.not.be.null;

      // Click Pull Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await waitForLoad(el);

      // Connection status should be gone, PR content visible
      const connectionAfter = el.shadowRoot!.querySelector('.connection-status');
      expect(connectionAfter).to.be.null;

      const prList = el.shadowRoot!.querySelector('.pr-list, .filter-row, .empty-state');
      expect(prList).to.not.be.null;
    });

    it('active tab has correct styling', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const connectionTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Connection');
      expect(connectionTab?.classList.contains('active')).to.be.true;

      // Click Pull Requests tab
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await el.updateComplete;

      expect(prTab.classList.contains('active')).to.be.true;
      expect(connectionTab?.classList.contains('active')).to.be.false;
    });
  });

  describe('Error Handling', () => {
    it('displays error message when error state is set', async () => {
      // Make connection check throw an error
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'check_github_connection_with_token' || command === 'check_github_connection') {
          throw new Error('Network timeout');
        }
        return origMock(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const errorMsg = el.shadowRoot!.querySelector('.error-message');
      expect(errorMsg).to.not.be.null;
      expect(errorMsg!.textContent).to.include('Network timeout');
    });

    it('surfaces a backend error when repo detection fails (not silent)', async () => {
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'detect_github_repo') throw new Error('repo detect boom');
        return origMock(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const errorMsg = el.shadowRoot!.querySelector('.error-message');
      expect(errorMsg).to.not.be.null;
      expect(errorMsg!.textContent).to.include('repo detect boom');
    });
  });

  describe('Delete Integration (M10)', () => {
    async function openConnectedDialog(): Promise<LvGitHubDialog> {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gh-acc-1';
      await el.updateComplete;
      return el;
    }

    it('M10: deletes the account record BEFORE the keyring token (record is source of truth)', async () => {
      const el = await openConnectedDialog();
      invokeHistory.length = 0;
      uiStore.getState().toasts.length = 0;

      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command.startsWith('plugin:dialog|')) return 'Ok';
        return origMock(command, args);
      };

      await (el as unknown as { handleDeleteIntegration: () => Promise<void> }).handleDeleteIntegration();
      await el.updateComplete;

      const deleteAccountIdx = invokeHistory.findIndex((h) => h.command === 'delete_global_account');
      const deleteTokenIdx = invokeHistory.findIndex((h) => h.command === 'delete_keyring_token');
      expect(deleteAccountIdx, 'account record deletion happened').to.be.greaterThan(-1);
      expect(deleteTokenIdx, 'token deletion happened').to.be.greaterThan(-1);
      expect(deleteAccountIdx).to.be.lessThan(deleteTokenIdx);
    });

    it('M10: surfaces an error (inline + toast) when account deletion fails', async () => {
      const el = await openConnectedDialog();
      uiStore.getState().toasts.length = 0;

      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command.startsWith('plugin:dialog|')) return 'Ok';
        if (command === 'delete_global_account') throw new Error('delete record boom');
        return origMock(command, args);
      };

      await (el as unknown as { handleDeleteIntegration: () => Promise<void> }).handleDeleteIntegration();
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.include('delete record boom');
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /delete record boom/.test(t.message))).to.be.true;
    });
  });

  describe('OAuth completes after dialog closed', () => {
    it('persists the account and surfaces a toast instead of failing silently', async () => {
      connectionResponse = mockConnectedStatus;
      // Dialog is mounted but closed — the window OAuth listener is still active.
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${false}></lv-github-dialog>
      `);
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      invokeHistory.length = 0;

      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: { provider: 'github', tokens: { accessToken: 'ghp_oauth_token' } },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      // The auth was still persisted (the user completed it — don't lose it),
      // either by creating a new account or storing the token on an existing one.
      const persisted = invokeHistory.filter(
        (h) => h.command === 'save_global_account' || h.command === 'store_keyring_token'
      );
      expect(persisted.length).to.be.greaterThan(0);

      // And a success toast was shown since the inline status is invisible when closed.
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /Connected GitHub/.test(t.message))).to.be.true;
    });
  });

  describe('OAuth failure is surfaced (not a silent dead-end)', () => {
    it('shows an error and a toast when the OAuth flow errors', async () => {
      // A failing authorize-url makes startOAuth emit OAuth state 'error'. The
      // spinner only renders for pending/exchanging, so without surfacing the
      // error the form would silently reset to the sign-in button (dead-end).
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_unified_profiles_config') {
          return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
        }
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return null;
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await oauthService.startOAuth('github', 'test-client-id');
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error, 'error surfaced').to.be.a(
        'string'
      ).and.not.empty;
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error'), 'error toast shown').to.be.true;
    });

    it('releases the pinned OAuth target when the flow fails to start', async () => {
      // `handleStartOAuth` pins the account the flow was started for so a late
      // completion is attributed to it rather than to whatever is selected when
      // the callback lands. A flow that never starts can never complete, so the
      // pin must be released — otherwise the next completion (a re-try started
      // elsewhere, or a stale callback) would be written to the wrong account.
      connectionResponse = mockConnectedStatus;
      const otherAccount = createTestAccount({
        id: 'gh-acc-2',
        name: 'Personal GitHub',
        integrationType: 'github',
      });
      unifiedProfileStore.getState().setAccounts([mockAccount, otherAccount]);
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [],
            accounts: [mockAccount, otherAccount],
            repositoryAssignments: {},
          };
        }
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return previous(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as {
        oauthTargetAccountId: string | null | undefined;
        oauthTargetWasAddingAccount: boolean | undefined;
        selectedAccountId: string | null;
        isAddingAccount: boolean;
        handleStartOAuth(): Promise<void>;
        handleOAuthComplete(event: CustomEvent): Promise<void>;
      };
      internals.selectedAccountId = 'gh-acc-1';
      internals.isAddingAccount = false;

      // Sign-in fails to start: `startOAuth` resolves and reports the failure
      // through the OAuth state subscriber rather than rejecting.
      await internals.handleStartOAuth();
      await el.updateComplete;

      expect(internals.oauthTargetAccountId, 'pin released after failed start').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;

      // The user now picks a different account; a completion arriving afterwards
      // must land on that account, not on the abandoned flow's target.
      internals.selectedAccountId = 'gh-acc-2';
      invokeHistory.length = 0;
      await internals.handleOAuthComplete(new CustomEvent('oauth-complete', {
        detail: {
          provider: 'github',
          tokens: { accessToken: 'late-token', refreshToken: 'refresh', expiresIn: 3600 },
        },
      }));

      expect(keyringStore.get('github_token_gh-acc-2')).to.equal('late-token');
      const writtenKeys = invokeHistory
        .filter((h) => h.command === 'store_keyring_token')
        .map((h) => (h.args as Record<string, string>).key);
      expect(writtenKeys, 'token written for the current selection').to.include(
        'github_token_gh-acc-2'
      );
      expect(
        writtenKeys.some((k) => k.startsWith('github_token_gh-acc-1')),
        'abandoned target not written'
      ).to.be.false;
    });

    it('releases the pinned OAuth target when the user cancels a pending sign-in', async () => {
      // Cancelling ends the flow, so it can never complete. A pin left behind
      // would route the NEXT completion onto the abandoned flow's account
      // instead of the one the user is looking at.
      connectionResponse = mockConnectedStatus;
      const otherAccount = createTestAccount({
        id: 'gh-acc-2',
        name: 'Personal GitHub',
        integrationType: 'github',
      });
      unifiedProfileStore.getState().setAccounts([mockAccount, otherAccount]);
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [],
            accounts: [mockAccount, otherAccount],
            repositoryAssignments: {},
          };
        }
        return previous(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as {
        oauthTargetAccountId: string | null | undefined;
        oauthTargetWasAddingAccount: boolean | undefined;
        oauthState: { status: string };
        selectedAccountId: string | null;
        isAddingAccount: boolean;
        handleCancelOAuth(): void;
        handleOAuthComplete(event: CustomEvent): Promise<void>;
      };
      internals.selectedAccountId = 'gh-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'gh-acc-1';
      internals.oauthTargetWasAddingAccount = false;

      internals.handleCancelOAuth();
      await el.updateComplete;

      expect(internals.oauthTargetAccountId, 'pin released on cancel').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;
      expect(internals.oauthState.status, 'form returned to idle').to.equal('idle');

      // The user now picks a different account; a completion arriving afterwards
      // must land on that account, not on the cancelled flow's target.
      internals.selectedAccountId = 'gh-acc-2';
      invokeHistory.length = 0;
      await internals.handleOAuthComplete(new CustomEvent('oauth-complete', {
        detail: {
          provider: 'github',
          tokens: { accessToken: 'post-cancel-token', refreshToken: 'refresh', expiresIn: 3600 },
        },
      }));

      expect(keyringStore.get('github_token_gh-acc-2')).to.equal('post-cancel-token');
      const keysAfterCancel = invokeHistory
        .filter((h) => h.command === 'store_keyring_token')
        .map((h) => (h.args as Record<string, string>).key);
      expect(
        keysAfterCancel.some((k) => k.startsWith('github_token_gh-acc-1')),
        'cancelled target not written'
      ).to.be.false;
    });

    it('cancels only the GitHub sign-in, leaving another provider pending', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'oauth_get_authorize_url') {
          const provider = (args as Record<string, string>)?.provider;
          // No loopbackPort: the flow stays pending instead of polling for a
          // callback that never arrives here.
          return { authorizeUrl: `https://example.com/${provider}`, state: `${provider}-state` };
        }
        return previous(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      oauthService.cancelOAuth();
      await oauthService.startOAuth('bitbucket', 'bb-client');
      await oauthService.startOAuth('github', 'gh-client');

      (el as unknown as { handleCancelOAuth(): void }).handleCancelOAuth();

      expect(
        oauthService.getPendingProvider(),
        'a sign-in pending in another provider dialog is left alone'
      ).to.equal('bitbucket');
      oauthService.cancelOAuth();
    });
  });

  describe('Add account guard', () => {
    it('does not re-select an existing account when a background store emit fires mid-add', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // User clicks "Add account": selection is intentionally cleared so the
      // next token save creates a NEW account.
      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;
      expect((el as unknown as { selectedAccountId: string | null }).selectedAccountId).to.equal(null);

      // A background validation emit fires (e.g. periodic token validation).
      unifiedProfileStore.getState().setAccountConnectionStatus('gh-acc-1', 'connected');
      await el.updateComplete;

      // Selection must stay null — re-selecting here would route the new token
      // onto the existing account on the next save.
      expect((el as unknown as { selectedAccountId: string | null }).selectedAccountId).to.equal(null);
    });
  });

  describe('PAT rotation refreshes cachedUser', () => {
    it('calls update_global_account_cached_user after storing the token on an existing account', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gh-acc-1';
      (el as unknown as { tokenInput: string }).tokenInput = 'ghp_rotated_pat';
      await el.updateComplete;

      invokeHistory.length = 0;
      await (el as unknown as { handleSaveToken: () => Promise<void> }).handleSaveToken();
      await el.updateComplete;

      const storeIdx = invokeHistory.findIndex((h) => h.command === 'store_keyring_token');
      const cachedUserIdx = invokeHistory.findIndex(
        (h) => h.command === 'update_global_account_cached_user'
      );
      expect(storeIdx, 'token stored').to.be.greaterThan(-1);
      expect(cachedUserIdx, 'cachedUser refreshed').to.be.greaterThan(-1);
      const args = invokeHistory[cachedUserIdx].args as Record<string, unknown>;
      expect(args.accountId).to.equal('gh-acc-1');
      expect(args.user).to.not.be.null;
    });
  });

  describe('OAuth re-auth refreshes cachedUser', () => {
    it('calls update_global_account_cached_user when OAuth completes for an existing account', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // Existing account is selected — OAuth re-auth must refresh its avatar/
      // username immediately (the GitHub OAuth path used to skip this).
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gh-acc-1';
      await el.updateComplete;

      invokeHistory.length = 0;
      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'github',
            tokens: {
              accessToken: 'ghp_oauth_reauth',
              refreshToken: 'github-refresh-token',
              expiresIn: 3600,
            },
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const storeIdx = invokeHistory.findIndex((h) => h.command === 'store_keyring_token');
      const cachedUserIdx = invokeHistory.findIndex(
        (h) => h.command === 'update_global_account_cached_user'
      );
      expect(storeIdx, 'token stored').to.be.greaterThan(-1);
      const oauthStore = invokeHistory.find(
        (h) =>
          h.command === 'store_keyring_token' &&
          (h.args as Record<string, unknown>).key === 'github_token_gh-acc-1_oauth'
      );
      expect(oauthStore, 'OAuth refresh metadata stored').to.not.be.undefined;
      const oauthBundle = JSON.parse(
        (oauthStore!.args as Record<string, unknown>).value as string
      ) as Record<string, unknown>;
      expect(oauthBundle.accessToken).to.equal('ghp_oauth_reauth');
      expect(oauthBundle.refreshToken).to.equal('github-refresh-token');
      expect(oauthBundle.expiresAt).to.be.a('number');
      expect(cachedUserIdx, 'cachedUser refreshed on OAuth re-auth').to.be.greaterThan(-1);
      const args = invokeHistory[cachedUserIdx].args as Record<string, unknown>;
      expect(args.accountId).to.equal('gh-acc-1');
      expect(args.user).to.not.be.null;
    });

    it('does not reselect the OAuth target over a newer add-account flow', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as {
        oauthTargetAccountId: string | null | undefined;
        selectedAccountId: string | null;
        isAddingAccount: boolean;
        handleOAuthComplete(event: CustomEvent): Promise<void>;
      };
      internals.oauthTargetAccountId = 'gh-acc-1';
      internals.selectedAccountId = 'gh-acc-1';
      internals.isAddingAccount = false;

      let releaseVerification!: () => void;
      let markVerificationStarted!: () => void;
      const verificationGate = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      const verificationStarted = new Promise<void>((resolve) => {
        markVerificationStarted = resolve;
      });
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'check_github_connection') {
          markVerificationStarted();
          await verificationGate;
        }
        return previous(command, args);
      };

      const completion = internals.handleOAuthComplete(new CustomEvent('oauth-complete', {
        detail: {
          provider: 'github',
          tokens: { accessToken: 'reauth-token', refreshToken: 'refresh', expiresIn: 3600 },
        },
      }));
      await verificationStarted;
      internals.selectedAccountId = null;
      internals.isAddingAccount = true;
      // loadInitialData's connection check already marked gh-acc-1 connected —
      // clear it so the final assertion proves handleOAuthComplete set it for
      // the OAuth target, not for the newer (mid-flight) selection.
      unifiedProfileStore.getState().setAccountConnectionStatus('gh-acc-1', 'disconnected');
      releaseVerification();
      await completion;

      expect(keyringStore.get('github_token_gh-acc-1')).to.equal('reauth-token');
      expect(internals.selectedAccountId, 'newer add-account selection is preserved').to.be.null;
      expect(internals.isAddingAccount).to.be.true;
      expect(
        unifiedProfileStore.getState().accountConnectionStatus['gh-acc-1']?.status
      ).to.equal('connected');
    });

    it('does not recreate credentials for an account deleted during OAuth', async () => {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      let releaseVerification!: () => void;
      let markVerificationStarted!: () => void;
      const verificationGate = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      const verificationStarted = new Promise<void>((resolve) => {
        markVerificationStarted = resolve;
      });
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'check_github_connection') {
          markVerificationStarted();
          await verificationGate;
        }
        return previous(command, args);
      };
      invokeHistory.length = 0;

      const internals = el as unknown as {
        oauthTargetAccountId: string | null | undefined;
        selectedAccountId: string | null;
        handleOAuthComplete(event: CustomEvent): Promise<void>;
        error: string | null;
      };
      internals.oauthTargetAccountId = 'gh-acc-1';
      internals.selectedAccountId = 'gh-acc-1';

      const completion = internals.handleOAuthComplete(new CustomEvent('oauth-complete', {
        detail: {
          provider: 'github',
          tokens: { accessToken: 'orphan-token', refreshToken: 'refresh', expiresIn: 3600 },
        },
      }));
      await verificationStarted;
      unifiedProfileStore.getState().setAccounts([]);
      keyringStore.delete('github_token_gh-acc-1');
      releaseVerification();
      await completion;

      expect(
        keyringStore.has('github_token_gh-acc-1'),
        'no orphaned credential remains'
      ).to.be.false;
      expect(internals.error).to.match(/account was removed/i);
    });

    it('does not replace a newer selection when add-account OAuth completes', async () => {
      connectionResponse = mockConnectedStatus;
      const otherAccount = createTestAccount({
        id: 'gh-acc-2',
        name: 'Personal GitHub',
        integrationType: 'github',
      });
      unifiedProfileStore.getState().setAccounts([mockAccount, otherAccount]);
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [],
            accounts: [mockAccount, otherAccount],
            repositoryAssignments: {},
          };
        }
        return previous(command, args);
      };
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      let releaseVerification!: () => void;
      let markVerificationStarted!: () => void;
      const verificationGate = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      const verificationStarted = new Promise<void>((resolve) => {
        markVerificationStarted = resolve;
      });
      const profileMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'check_github_connection') {
          markVerificationStarted();
          await verificationGate;
        }
        return profileMock(command, args);
      };

      const internals = el as unknown as {
        oauthTargetAccountId: string | null | undefined;
        oauthTargetWasAddingAccount: boolean | undefined;
        selectedAccountId: string | null;
        isAddingAccount: boolean;
        handleOAuthComplete(event: CustomEvent): Promise<void>;
      };
      internals.oauthTargetAccountId = null;
      internals.oauthTargetWasAddingAccount = true;
      internals.selectedAccountId = null;
      internals.isAddingAccount = true;

      const completion = internals.handleOAuthComplete(new CustomEvent('oauth-complete', {
        detail: {
          provider: 'github',
          tokens: { accessToken: 'new-account-token', refreshToken: 'refresh', expiresIn: 3600 },
        },
      }));
      await verificationStarted;
      internals.selectedAccountId = 'gh-acc-2';
      internals.isAddingAccount = false;
      releaseVerification();
      await completion;

      expect(internals.selectedAccountId).to.equal('gh-acc-2');
      expect(internals.isAddingAccount).to.be.false;
    });
  });

  describe('Create feedback toasts (regression)', () => {
    async function openConnectedRepo(): Promise<LvGitHubDialog> {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);
      return el;
    }

    it('shows a success toast after creating a pull request', async () => {
      const el = await openConnectedRepo();
      const d = el as unknown as Record<string, unknown>;
      d.createPrTitle = 'My PR';
      d.createPrHead = 'feature/x';
      d.createPrBase = 'main';
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await (el as unknown as { handleCreatePR: () => Promise<void> }).handleCreatePR();
      await el.updateComplete;

      expect(
        uiStore.getState().toasts.some(
          (t) => t.type === 'success' && /Pull request created successfully/.test(t.message)
        )
      ).to.be.true;
    });

    it('shows a success toast after creating an issue', async () => {
      const el = await openConnectedRepo();
      (el as unknown as { createIssueTitle: string }).createIssueTitle = 'My issue';
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await (el as unknown as { handleCreateIssue: () => Promise<void> }).handleCreateIssue();
      await el.updateComplete;

      expect(
        uiStore.getState().toasts.some(
          (t) => t.type === 'success' && /Issue created successfully/.test(t.message)
        )
      ).to.be.true;
    });

    it('shows a success toast after creating a release', async () => {
      const el = await openConnectedRepo();
      (el as unknown as { createReleaseTag: string }).createReleaseTag = 'v2.0.0';
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await (el as unknown as { handleCreateRelease: () => Promise<void> }).handleCreateRelease();
      await el.updateComplete;

      expect(
        uiStore.getState().toasts.some(
          (t) => t.type === 'success' && /Release created successfully/.test(t.message)
        )
      ).to.be.true;
    });
  });

  describe('GitHub App resets the add-account flag (regression)', () => {
    it('handleConnectGitHubApp clears isAddingAccount on success', async () => {
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const d = el as unknown as Record<string, unknown>;
      d.isAddingAccount = true;
      d.appId = '12345';
      d.appPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      d.appInstallationId = '67890';

      await (el as unknown as { handleConnectGitHubApp: () => Promise<void> }).handleConnectGitHubApp();
      await el.updateComplete;

      expect((el as unknown as { isAddingAccount: boolean }).isAddingAccount).to.equal(false);
    });
  });

  describe('GitHub App account identity', () => {
    // Accounts the backend reports for this describe. The dialog reloads the
    // config on open, so the backend mock — not just the store — has to carry
    // them.
    let existingAccounts: IntegrationAccount[] = [];

    // The real Rust `save_global_account` command returns the saved account;
    // the shared harness echoes the raw args instead, which the service cannot
    // fold into the store. Narrow the mock here so the store assertions below
    // observe what the app would really see.
    beforeEach(() => {
      existingAccounts = [];
      const base = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'save_global_account') {
          return (args as { account: IntegrationAccount }).account;
        }
        if (command === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [],
            accounts: existingAccounts,
            repositoryAssignments: {},
          };
        }
        return base(command, args);
      };
    });

    const seedAccounts = (accounts: IntegrationAccount[]): void => {
      existingAccounts = accounts;
      unifiedProfileStore.getState().setAccounts(accounts);
    };

    const savedAccounts = (): IntegrationAccount[] =>
      invokeHistory
        .filter((h) => h.command === 'save_global_account')
        .map((h) => (h.args as { account: IntegrationAccount }).account);

    const fillAppForm = (dialog: Record<string, unknown>): void => {
      dialog.appId = '12345';
      dialog.appPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      dialog.appInstallationId = '67890';
    };

    it('connecting a GitHub App creates its own account instead of overwriting the selected one', async () => {
      seedAccounts([mockAccount]);
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      // The dialog auto-selects the existing PAT account when it opens — that
      // is exactly the state in which the App connect used to clobber it.
      expect(dialog.selectedAccountId, 'existing account is auto-selected').to.equal('gh-acc-1');

      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      const saved = savedAccounts();
      expect(saved).to.have.lengthOf(1);
      expect(saved[0].id).to.equal('github-app-12345');
      expect(saved.some((a) => a.id === 'gh-acc-1'), 'never writes onto the PAT account').to.be
        .false;

      const pat = unifiedProfileStore.getState().accounts.find((a) => a.id === 'gh-acc-1');
      expect(pat, 'the PAT account still exists').to.exist;
      expect(pat!.name).to.equal('Work GitHub');
      expect(pat!.cachedUser?.username).to.equal('octocat');
      expect(pat!.isDefault, 'the PAT account keeps its Default flag').to.be.true;
      expect(selectDefaultGlobalAccount('github')?.id).to.equal('gh-acc-1');

      expect(dialog.selectedAccountId).to.equal('github-app-12345');
    });

    it('reconnecting an existing GitHub App account keeps its name, colour, patterns and Default flag', async () => {
      const appAccount = createTestAccount({
        id: 'github-app-12345',
        name: 'Acme App',
        integrationType: 'github',
        color: '#3b82f6',
        urlPatterns: ['github.com/acme/*'],
        isDefault: true,
      });
      seedAccounts([appAccount]);
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      expect(dialog.selectedAccountId).to.equal('github-app-12345');

      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      const saved = savedAccounts();
      expect(saved).to.have.lengthOf(1);
      expect(saved[0].id).to.equal('github-app-12345');
      expect(saved[0].name, 'user-set name survives a reconnect').to.equal('Acme App');
      expect(saved[0].color).to.equal('#3b82f6');
      expect(saved[0].urlPatterns).to.deep.equal(['github.com/acme/*']);
      expect(saved[0].isDefault, 'the App account keeps its Default flag').to.be.true;

      const stored = unifiedProfileStore
        .getState()
        .accounts.find((a) => a.id === 'github-app-12345');
      expect(stored!.name).to.equal('Acme App');
      expect(stored!.isDefault).to.be.true;
    });

    it('a rejected GitHub App configuration saves nothing and leaves the selected account intact', async () => {
      seedAccounts([mockAccount]);
      appConfigResponse = { connected: false, user: null, scopes: [] };
      uiStore.getState().toasts.length = 0;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      expect(dialog.selectedAccountId).to.equal('gh-acc-1');

      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      expect(savedAccounts(), 'a rejected config persists nothing').to.be.empty;
      expect(dialog.error).to.be.a('string').and.not.empty;
      expect(uiStore.getState().toasts.some((t) => t.type === 'error')).to.be.true;

      const pat = unifiedProfileStore.getState().accounts.find((a) => a.id === 'gh-acc-1');
      expect(pat!.name).to.equal('Work GitHub');
      expect(pat!.isDefault).to.be.true;
      expect(dialog.selectedAccountId).to.equal('gh-acc-1');
    });

    const deletedAccountIds = (): string[] =>
      invokeHistory
        .filter((h) => h.command === 'delete_global_account')
        .map((h) => (h.args as { accountId: string }).accountId);

    it('connecting a second GitHub App removes the App account it supersedes', async () => {
      // The backend stores ONE GitHub App configuration, so the previous App
      // account has no credential of its own left to resolve through.
      const oldApp = createTestAccount({
        id: 'github-app-99999',
        name: 'Old App',
        integrationType: 'github',
        isDefault: false,
      });
      seedAccounts([mockAccount, oldApp]);
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      expect(savedAccounts().map((a) => a.id)).to.deep.equal(['github-app-12345']);
      expect(deletedAccountIds(), 'the superseded App account is removed').to.deep.equal([
        'github-app-99999',
      ]);

      const remaining = unifiedProfileStore.getState().accounts.map((a) => a.id);
      expect(remaining).to.not.include('github-app-99999');
      expect(remaining, 'the PAT account is untouched').to.include('gh-acc-1');
      expect(
        (dialog.accounts as IntegrationAccount[]).map((a) => a.id),
        'the selector no longer offers the superseded App',
      ).to.not.include('github-app-99999');
      expect(dialog.selectedAccountId).to.equal('github-app-12345');
    });

    it('the replacement App account inherits the superseded App account Default flag', async () => {
      const oldApp = createTestAccount({
        id: 'github-app-99999',
        name: 'Old App',
        integrationType: 'github',
        isDefault: true,
      });
      seedAccounts([oldApp]);
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      const saved = savedAccounts();
      expect(saved).to.have.lengthOf(1);
      expect(saved[0].isDefault, 'the github type is not left without a default').to.be.true;
      expect(selectDefaultGlobalAccount('github')?.id).to.equal('github-app-12345');
    });

    it('warns but still connects when the superseded App account cannot be removed', async () => {
      const oldApp = createTestAccount({
        id: 'github-app-99999',
        name: 'Old App',
        integrationType: 'github',
        isDefault: false,
      });
      seedAccounts([mockAccount, oldApp]);
      appConfigResponse = { connected: true, user: null, scopes: ['app-installation'] };
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'delete_global_account') throw new Error('keyring is locked');
        return previous(command, args);
      };

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);
      uiStore.getState().toasts.length = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      fillAppForm(dialog);
      await dialog.handleConnectGitHubApp();

      expect(dialog.connectionStatus?.connected, 'the App is still connected').to.be.true;
      expect(dialog.error, 'a cleanup failure is not a connect failure').to.be.null;
      const warning = uiStore
        .getState()
        .toasts.find((t) => t.type === 'warning' && t.message.includes('keyring is locked'));
      expect(warning, 'the failed cleanup is surfaced to the user').to.exist;
    });
  });
  // Lists used to stop dead at the first page: the backend never sent a `page`
  // param and no tab offered a way to ask for more, so a repository with more
  // than one page of PRs/issues/releases/runs simply hid the rest.
  describe('list pagination', () => {
    async function openOnTab(tabLabel: string): Promise<LvGitHubDialog> {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const tab = Array.from(tabs).find((t) => t.textContent?.trim() === tabLabel) as HTMLButtonElement;
      tab.click();
      await waitForLoad(el);
      return el;
    }

    function loadMoreButton(el: LvGitHubDialog): HTMLButtonElement | null {
      return el.shadowRoot!.querySelector('.load-more .btn');
    }

    async function clickLoadMore(el: LvGitHubDialog): Promise<void> {
      loadMoreButton(el)!.click();
      await waitForLoad(el);
    }

    function callsTo(command: string): Array<Record<string, unknown>> {
      return invokeHistory
        .filter((c) => c.command === command)
        .map((c) => (c.args ?? {}) as Record<string, unknown>);
    }

    it('shows Load more in the pull requests tab when a full page came back', async () => {
      prPages = { 1: makePullRequests(30, 100) };

      const el = await openOnTab('Pull Requests');

      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(30);
      const button = loadMoreButton(el);
      expect(button, 'a full page must offer a way to reach the next one').to.not.be.null;
      expect(button!.textContent?.trim()).to.equal('Load more');
    });

    it('appends the next page and asks GitHub for page 2', async () => {
      prPages = { 1: makePullRequests(30, 100), 2: makePullRequests(5, 70) };

      const el = await openOnTab('Pull Requests');
      await clickLoadMore(el);

      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(35);
      expect(el.shadowRoot!.textContent).to.contain('Generated PR 70');

      const calls = callsTo('list_pull_requests');
      expect(calls.length).to.be.at.least(2);
      expect(calls[0].page, 'the first load starts at page 1').to.equal(1);
      const latest = calls[calls.length - 1];
      expect(latest.page, 'Load more must request the next page').to.equal(2);
      expect(latest.perPage).to.equal(30);
    });

    it('hides Load more once a short page comes back', async () => {
      prPages = { 1: makePullRequests(30, 100), 2: makePullRequests(5, 70) };

      const el = await openOnTab('Pull Requests');
      await clickLoadMore(el);

      expect(loadMoreButton(el), 'a short page is the end of the list').to.be.null;
    });

    it('keeps the loaded pull requests and shows an error when the next page fails', async () => {
      prPages = { 1: makePullRequests(30, 100) };
      prPageThatFails = 2;

      const el = await openOnTab('Pull Requests');
      await clickLoadMore(el);

      const banner = el.shadowRoot!.querySelector('.error-message');
      expect(banner, 'a failed page must not fail silently').to.not.be.null;
      expect(banner!.textContent).to.contain('Rate limit exceeded');
      // The pages already on screen survive, and the button stays for a retry.
      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(30);
      expect(loadMoreButton(el)).to.not.be.null;
    });

    it('offers Load more instead of an empty state when the first issue page held only pull requests', async () => {
      // /issues returns pull requests too and the backend filters them out, so
      // page 1 can legitimately contain no issues while page 2 does.
      issuePages = {
        1: { issues: [], nextPage: 2 },
        2: { issues: [mockIssues[0]], nextPage: null },
      };

      const el = await openOnTab('Issues');

      expect(el.shadowRoot!.querySelectorAll('.issue-item').length).to.equal(0);
      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(
        emptyState?.textContent?.trim(),
        'a dead-end "No open issues" must not be claimed while pages remain'
      ).to.not.equal('No open issues');
      expect(loadMoreButton(el)).to.not.be.null;

      await clickLoadMore(el);

      expect(el.shadowRoot!.querySelectorAll('.issue-item').length).to.equal(1);
      expect(loadMoreButton(el)).to.be.null;

      const calls = callsTo('list_issues');
      expect(calls[calls.length - 1].page).to.equal(2);
    });

    it('resets to the first page when the pull request filter changes', async () => {
      prPages = { 1: makePullRequests(30, 100), 2: makePullRequests(5, 70) };

      const el = await openOnTab('Pull Requests');
      await clickLoadMore(el);
      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(35);

      const select = el.shadowRoot!.querySelector('.filter-select') as HTMLSelectElement;
      select.value = 'closed';
      select.dispatchEvent(new Event('change'));
      await waitForLoad(el);

      const calls = callsTo('list_pull_requests');
      expect(calls[calls.length - 1].page, 'a filter change starts the list over').to.equal(1);
      expect(calls[calls.length - 1].state).to.equal('closed');
      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(30);
    });

    it('shows Load more for releases when a full page came back', async () => {
      releasePages = { 1: makeReleases(20, 1), 2: makeReleases(3, 21) };

      const el = await openOnTab('Releases');
      expect(el.shadowRoot!.querySelectorAll('.release-item').length).to.equal(20);

      await clickLoadMore(el);

      expect(el.shadowRoot!.querySelectorAll('.release-item').length).to.equal(23);
      expect(loadMoreButton(el)).to.be.null;
      const calls = callsTo('list_releases');
      expect(calls[calls.length - 1].page).to.equal(2);
      expect(calls[calls.length - 1].perPage).to.equal(20);
    });

    it('shows Load more for workflow runs when a full page came back', async () => {
      runPages = { 1: makeWorkflowRuns(20, 1), 2: makeWorkflowRuns(4, 21) };

      const el = await openOnTab('Actions');
      expect(el.shadowRoot!.querySelectorAll('.workflow-item').length).to.equal(20);

      await clickLoadMore(el);

      expect(el.shadowRoot!.querySelectorAll('.workflow-item').length).to.equal(24);
      expect(loadMoreButton(el)).to.be.null;
      const calls = callsTo('get_workflow_runs');
      expect(calls[calls.length - 1].page).to.equal(2);
    });

    it('keeps other tabs loadable while a pull request page is in flight', async () => {
      prPages = { 1: makePullRequests(30, 100), 2: makePullRequests(5, 70) };
      runPages = { 1: makeWorkflowRuns(20, 1) };
      let releaseSecondPage = (): void => {};
      prPageGates[2] = new Promise<void>((resolve) => {
        releaseSecondPage = resolve;
      });

      const el = await openOnTab('Pull Requests');
      loadMoreButton(el)!.click();
      await el.updateComplete;

      const actionsTab = Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (tab) => tab.textContent?.trim() === 'Actions'
      ) as HTMLButtonElement;
      actionsTab.click();
      await waitForLoad(el);

      const actionsLoadMore = loadMoreButton(el);
      expect(actionsLoadMore).to.not.be.null;
      expect(actionsLoadMore!.disabled, 'a PR request must not disable the Actions cursor').to.be.false;
      expect(actionsLoadMore!.textContent?.trim()).to.equal('Load more');

      releaseSecondPage();
      await waitForLoad(el);
    });

    it('keeps loading visible when a superseded request finishes first', async () => {
      const el = await openOnTab('Pull Requests');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      let releaseOpen = (): void => {};
      let releaseClosed = (): void => {};
      const openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const closedGate = new Promise<void>((resolve) => {
        releaseClosed = resolve;
      });

      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'list_pull_requests') {
          const state = (args as { state?: string } | undefined)?.state;
          await (state === 'closed' ? closedGate : openGate);
          return makePullRequests(30, state === 'closed' ? 200 : 100);
        }
        return null;
      };

      dialog.prFilter = 'open';
      const superseded = dialog.loadPullRequests('tok');
      await Promise.resolve();
      dialog.prFilter = 'closed';
      const current = dialog.loadPullRequests('tok');
      await Promise.resolve();

      releaseOpen();
      await superseded;
      expect(
        dialog.isLoading,
        'the stale request must not clear the newer request loading state'
      ).to.be.true;

      releaseClosed();
      await current;
      expect(dialog.isLoading).to.be.false;
    });

    it('does not append a superseded page after the pull request filter changed', async () => {
      prPages = { 1: makePullRequests(30, 100), 2: makePullRequests(5, 70) };
      let releaseSecondPage = (): void => {};
      prPageGates[2] = new Promise<void>((resolve) => {
        releaseSecondPage = resolve;
      });

      const el = await openOnTab('Pull Requests');

      // Load more is still in flight...
      loadMoreButton(el)!.click();
      await el.updateComplete;

      // ...when the filter changes and restarts the list at page 1.
      const select = el.shadowRoot!.querySelector('.filter-select') as HTMLSelectElement;
      select.value = 'closed';
      select.dispatchEvent(new Event('change'));
      await waitForLoad(el);

      releaseSecondPage();
      await waitForLoad(el);

      expect(
        el.shadowRoot!.querySelectorAll('.pr-item').length,
        'the superseded page belongs to the old filter and must not be appended'
      ).to.equal(30);
      expect(el.shadowRoot!.textContent).to.not.contain('Generated PR 70');

      // The cursor belongs to the new list too: the next page is 2, not 3.
      delete prPageGates[2];
      await clickLoadMore(el);
      const calls = callsTo('list_pull_requests');
      expect(
        calls[calls.length - 1].page,
        'a superseded page must not advance the new list\'s cursor'
      ).to.equal(2);
    });

    it('does not overwrite the issue cursor with a superseded page', async () => {
      const el = await openOnTab('Issues');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;

      let releaseStalePage = (): void => {};
      const stalePage = new Promise<void>((resolve) => {
        releaseStalePage = resolve;
      });
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'list_issues' || command === 'list_github_issues') {
          if (requestedPage(args as Record<string, unknown>) === 5) {
            await stalePage;
            return { issues: [mockIssues[0]], nextPage: 6 };
          }
          return { issues: [], nextPage: null };
        }
        return null;
      };

      dialog.issues = [];
      dialog.issuesNextPage = 5;
      const superseded = dialog.loadIssues('tok', true);
      // A restart lands first and reports that the list ends here.
      await dialog.loadIssues('tok');
      releaseStalePage();
      await superseded;

      expect(
        dialog.issuesNextPage,
        'a superseded page must not resurrect a cursor the restart retired'
      ).to.equal(null);
      expect(dialog.issues.length, 'a superseded page must not be appended').to.equal(0);
    });

    it('clears the stale error banner when a workflow-run retry succeeds', async () => {
      runPages = { 1: makeWorkflowRuns(20, 1), 2: makeWorkflowRuns(4, 21) };
      runPageThatFails = 2;

      const el = await openOnTab('Actions');
      await clickLoadMore(el);
      expect(
        el.shadowRoot!.querySelector('.error-message')?.textContent,
        'the failed page is reported'
      ).to.contain('Rate limit exceeded');

      runPageThatFails = null;
      await clickLoadMore(el);

      expect(el.shadowRoot!.querySelectorAll('.workflow-item').length).to.equal(24);
      // Compared as text, not as a node: a failure must print a string rather
      // than an element the test runner cannot serialise.
      expect(
        el.shadowRoot!.querySelector('.error-message')?.textContent ?? null,
        'a successful retry must not leave the previous failure banner standing'
      ).to.equal(null);
    });

    it('clears the stale error when an issues load succeeds after a failure', async () => {
      const el = await openOnTab('Issues');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      dialog.error = 'Rate limit exceeded';

      await dialog.loadIssues('tok');

      expect(dialog.issues.length, 'the retry loaded issues').to.be.greaterThan(0);
      expect(dialog.error, 'a successful load must clear the previous failure').to.equal(null);
    });

    it('clears the stale error when a releases load succeeds after a failure', async () => {
      const el = await openOnTab('Releases');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      dialog.error = 'Rate limit exceeded';

      await dialog.loadReleases('tok');

      expect(dialog.releases.length, 'the retry loaded releases').to.be.greaterThan(0);
      expect(dialog.error, 'a successful load must clear the previous failure').to.equal(null);
    });
  });

  describe('load-failure feedback', () => {
    it('surfaces an error banner when loading issues fails instead of silently swallowing it', async () => {
      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true}></lv-github-dialog>
      `);
      await waitForLoad(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = el as any;
      dialog.detectedRepo = { owner: 'octocat', repo: 'hello' };
      dialog.connectionStatus = { connected: true };
      dialog.error = null;

      mockInvoke = async (command: string) => {
        if (command === 'list_issues' || command === 'list_github_issues') {
          throw new Error('rate limit exceeded');
        }
        return null;
      };

      await dialog.loadIssues('tok');

      // Surfaced via the shared error banner (not a toast), so batched load
      // failures collapse to a single message rather than stacking.
      expect(dialog.error, 'a failed issues load is surfaced').to.contain('rate limit exceeded');
    });
  });

  describe('PR review comments drawer', () => {
    async function openPullRequestsTab(): Promise<LvGitHubDialog> {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<LvGitHubDialog>(html`
        <lv-github-dialog .open=${true} .repositoryPath=${'/mock/repo'}></lv-github-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const prTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pull Requests') as HTMLButtonElement;
      prTab.click();
      await waitForLoad(el);
      return el;
    }

    it('loads and renders general and inline PR comments when the comments drawer is toggled', async () => {
      const el = await openPullRequestsTab();

      const toggleBtn = el.shadowRoot!.querySelector('[data-testid="pr-comments-toggle-42"]') as HTMLButtonElement;
      expect(toggleBtn).to.not.be.null;

      toggleBtn.click();
      await waitForLoad(el);

      const getCall = invokeHistory.find((h) => h.command === 'get_github_pr_comments');
      expect(getCall).to.not.be.undefined;
      expect(getCall!.args).to.deep.include({
        owner: 'test-owner',
        repo: 'test-repo',
        pullNumber: 42,
      });

      const drawer = el.shadowRoot!.querySelector('[data-testid="pr-comments-drawer-42"]');
      expect(drawer).to.not.be.null;
      expect(drawer!.textContent).to.contain('General review note');
      expect(drawer!.textContent).to.contain('Please handle null here');
      expect(drawer!.textContent).to.contain('src/auth.ts:27');
      expect(toggleBtn.textContent).to.contain('Comments (2)');
    });

    it('posts an inline PR review comment with file path, line, and headSha and refreshes comments', async () => {
      const el = await openPullRequestsTab();

      const toggleBtn = el.shadowRoot!.querySelector('[data-testid="pr-comments-toggle-42"]') as HTMLButtonElement;
      toggleBtn.click();
      await waitForLoad(el);

      const drawer = el.shadowRoot!.querySelector('[data-testid="pr-comments-drawer-42"]')!;
      const fileInput = drawer.querySelector('.pr-comment-file-input') as HTMLInputElement;
      const lineInput = drawer.querySelector('.pr-comment-line-input') as HTMLInputElement;
      const bodyInput = drawer.querySelector('.pr-comment-body-input') as HTMLTextAreaElement;
      const submitBtn = drawer.querySelector('[data-testid="pr-comment-submit-42"]') as HTMLButtonElement;

      fileInput.value = 'src/main.ts';
      fileInput.dispatchEvent(new Event('input'));
      lineInput.value = '18';
      lineInput.dispatchEvent(new Event('input'));
      bodyInput.value = 'Looks good on line 18';
      bodyInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      invokeHistory.length = 0;

      submitBtn.click();
      await waitForLoad(el);

      const addCall = invokeHistory.find((h) => h.command === 'add_github_pr_comment');
      expect(addCall).to.not.be.undefined;
      expect(addCall!.args).to.deep.include({
        owner: 'test-owner',
        repo: 'test-repo',
        pullNumber: 42,
        body: 'Looks good on line 18',
        path: 'src/main.ts',
        line: 18,
        commitId: 'abc1234',
      });

      const refreshCall = invokeHistory.find((h) => h.command === 'get_github_pr_comments');
      expect(refreshCall, 'refreshes comment list after posting').to.not.be.undefined;
      expect(
        uiStore.getState().toasts.some((t) => t.type === 'success' && /Comment posted/.test(t.message))
      ).to.be.true;
    });

    it('surfaces an error toast and banner when posting a PR comment fails', async () => {
      const el = await openPullRequestsTab();

      const toggleBtn = el.shadowRoot!.querySelector('[data-testid="pr-comments-toggle-42"]') as HTMLButtonElement;
      toggleBtn.click();
      await waitForLoad(el);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'add_github_pr_comment') {
          throw new Error('Validation Failed: line is not part of diff');
        }
        return previous(command, args);
      };

      const drawer = el.shadowRoot!.querySelector('[data-testid="pr-comments-drawer-42"]')!;
      const bodyInput = drawer.querySelector('.pr-comment-body-input') as HTMLTextAreaElement;
      const submitBtn = drawer.querySelector('[data-testid="pr-comment-submit-42"]') as HTMLButtonElement;

      bodyInput.value = 'Will fail';
      bodyInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      submitBtn.click();
      await waitForLoad(el);

      expect(
        uiStore.getState().toasts.some((t) => t.type === 'error' && /Validation Failed/.test(t.message))
      ).to.be.true;
    });
  });
});
