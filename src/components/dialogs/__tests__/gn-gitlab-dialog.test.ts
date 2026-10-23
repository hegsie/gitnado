/**
 * GitLab Dialog Integration Tests
 *
 * Tests the gn-gitlab-dialog Lit component for rendering, connection,
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
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import * as oauthService from '../../../services/oauth.service.ts';
import { createEmptyIntegrationAccount } from '../../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';
import '../gn-gitlab-dialog.ts';
import type { GnGitLabDialog } from '../gn-gitlab-dialog.ts';

// --- Test Data ---

const mockGitLabUser = {
  id: 54321,
  username: 'gluser',
  name: 'GL User',
  avatarUrl: 'https://example.com/gl-avatar.png',
  webUrl: 'https://gitlab.com/gluser',
};

const mockConnectedStatus = {
  connected: true,
  user: mockGitLabUser,
  instanceUrl: 'https://gitlab.com',
};

const mockDisconnectedStatus = {
  connected: false,
  user: null,
  instanceUrl: 'https://gitlab.com',
};

const mockDetectedRepo = {
  instanceUrl: 'https://gitlab.com',
  projectPath: 'test-group/test-project',
  remoteName: 'origin',
};

const mockMergeRequests = [
  {
    iid: 15,
    title: 'Add CI pipeline config',
    description: 'Adds .gitlab-ci.yml',
    state: 'opened',
    author: mockGitLabUser,
    createdAt: '2025-01-15T10:00:00Z',
    sourceBranch: 'feature/ci-setup',
    targetBranch: 'main',
    draft: false,
    webUrl: 'https://gitlab.com/test-group/test-project/-/merge_requests/15',
  },
  {
    iid: 14,
    title: 'Fix deploy script',
    description: null,
    state: 'merged',
    author: mockGitLabUser,
    createdAt: '2025-01-10T10:00:00Z',
    sourceBranch: 'fix/deploy',
    targetBranch: 'main',
    draft: false,
    webUrl: 'https://gitlab.com/test-group/test-project/-/merge_requests/14',
  },
];

const mockIssues = [
  {
    iid: 42,
    title: 'Performance regression in API',
    description: 'API calls are slow',
    state: 'opened',
    author: mockGitLabUser,
    assignees: [],
    labels: ['bug', 'performance'],
    createdAt: '2025-01-12T10:00:00Z',
    webUrl: 'https://gitlab.com/test-group/test-project/-/issues/42',
  },
];

const mockPipelines = [
  {
    id: 1001,
    iid: 55,
    status: 'success',
    source: 'push',
    ref: 'main',
    sha: 'abc1234567890def',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:05:00Z',
    webUrl: 'https://gitlab.com/test-group/test-project/-/pipelines/1001',
  },
];

const mockLabels = ['bug', 'enhancement', 'performance'];

function createTestAccount(
  overrides: Partial<IntegrationAccount> & { id: string }
): IntegrationAccount {
  const base = createEmptyIntegrationAccount(overrides.integrationType ?? 'gitlab');
  return {
    ...base,
    name: 'Test Account',
    isDefault: true,
    cachedUser: null,
    ...overrides,
  } as IntegrationAccount;
}

async function waitForLoad(el: GnGitLabDialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
}

// --- Mock Setup ---

const mockAccount = createTestAccount({
  id: 'gl-acc-1',
  name: 'Work GitLab',
  integrationType: 'gitlab',
  config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
  isDefault: true,
  cachedUser: {
    username: 'gluser',
    displayName: 'GL User',
    avatarUrl: 'https://example.com/gl-avatar.png',
    email: 'gl@example.com',
  },
});

let connectionResponse: unknown = mockDisconnectedStatus;
let detectedRepoResponse: unknown = mockDetectedRepo;
/** Raw result of `oauth_refresh_token`; null → the refresh fails. */
let refreshResponse: unknown = null;
/** Accounts returned by `get_unified_profiles_config`. */
let accountsResponse: IntegrationAccount[] = [];

function setupMockInvoke(): void {
  keyringStore.clear();
  keyringStore.set('gitlab_token_gl-acc-1', 'glpat-testtoken123456');

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
        accounts: accountsResponse,
        repositoryAssignments: {},
      };
    }
    if (command === 'load_unified_profile_for_repository') return null;
    if (command === 'save_global_account') return params;
    if (command === 'update_global_account_cached_user') return null;

    // GitLab-specific commands
    if (command === 'check_gitlab_connection') return connectionResponse;
    if (command === 'check_gitlab_connection_with_token') return connectionResponse;
    if (command === 'detect_gitlab_repo') return detectedRepoResponse;
    if (command === 'list_gitlab_merge_requests') return mockMergeRequests;
    if (command === 'list_gitlab_issues') return mockIssues;
    if (command === 'list_gitlab_pipelines') return mockPipelines;
    if (command === 'get_gitlab_labels') return mockLabels;
    if (command === 'create_gitlab_merge_request') return mockMergeRequests[0];
    if (command === 'create_gitlab_issue') return mockIssues[0];

    // OAuth
    if (command === 'get_oauth_client_id') return null;
    if (command === 'oauth_refresh_token') return refreshResponse;

    return null;
  };
}

describe('gn-gitlab-dialog', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    connectionResponse = mockDisconnectedStatus;
    detectedRepoResponse = mockDetectedRepo;
    refreshResponse = null;
    accountsResponse = [mockAccount];
    unifiedProfileStore.getState().reset();
    setupMockInvoke();
  });

  describe('Rendering & Modal', () => {
    it('renders gn-modal when open=true', async () => {
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const modal = el.shadowRoot!.querySelector('gn-modal');
      expect(modal).to.not.be.null;
    });

    it('shows 4 tab buttons', async () => {
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      expect(tabs.length).to.equal(4);

      const tabTexts = Array.from(tabs).map((t) => t.textContent?.trim());
      expect(tabTexts).to.include('Connection');
      expect(tabTexts).to.include('Merge Requests');
      expect(tabTexts).to.include('Issues');
      expect(tabTexts).to.include('Pipelines');
    });

    it('shows detected repo info (projectPath @ instanceUrl)', async () => {
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const repoName = el.shadowRoot!.querySelector('.repo-name');
      if (repoName) {
        expect(repoName.textContent).to.include('test-group/test-project');
      }
    });

    // Regression: these provider dialogs are repo-independent (they stay open
    // when the last repository tab closes), at which point repositoryPath goes
    // to ''. The detected repo must be cleared, or the dialog keeps showing --
    // and acting on -- the repository whose tab was just closed.
    it('clears the detected repo when repositoryPath becomes empty', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
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
        (t) => t.textContent?.trim() === 'Merge Requests'
      ) as HTMLButtonElement;
      repoTab.click();
      await waitForLoad(el);

      const emptyText = el.shadowRoot!.querySelector('.empty-state')?.textContent?.trim() ?? '';
      expect(emptyText, 'repo-backed tab after the last repository tab closed').to.contain(
        'No GitLab repository detected'
      );
    });

    // Regression: the dialog outlives the repository, so a detect_gitlab_repo
    // issued for the repository whose tab has since closed can resolve
    // afterwards. Its result must be dropped, or the repo header -- and the
    // repo-backed loaders behind it -- come back for a repository that is gone.
    it('ignores a repository detection that resolves after the repository closed', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Hold the detection open so it can be made to land late.
      const baseInvoke = mockInvoke;
      const pendingDetects: Array<() => void> = [];
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'detect_gitlab_repo') {
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
    it('drops the merge request draft when the repository changes', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const listTab = Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (t) => t.textContent?.trim() === 'Merge Requests'
      ) as HTMLButtonElement;
      listTab.click();
      await waitForLoad(el);

      const newButton = Array.from(el.shadowRoot!.querySelectorAll('button.btn')).find(
        (b) => b.textContent?.trim() === '+ New MR'
      ) as HTMLButtonElement;
      expect(newButton === undefined, 'missing + New MR button').to.be.false;
      newButton.click();
      await waitForLoad(el);

      const titleInput = el.shadowRoot!.querySelector(
        'input[placeholder="Merge request title"]'
      ) as HTMLInputElement | null;
      expect(titleInput === null, 'missing draft title input').to.be.false;
      titleInput!.value = 'Draft for the first repository';
      titleInput!.dispatchEvent(new Event('input'));
      await waitForLoad(el);

      // The user switches to a different repository with the draft on screen.
      el.repositoryPath = '/mock/other-repo';
      await waitForLoad(el);

      expect(
        el.shadowRoot!.querySelectorAll('input[placeholder="Merge request title"]').length,
        'submittable draft form after the repository changed'
      ).to.equal(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).createMrTitle, 'retained draft title').to.equal('');
    });

    it('shows account selector when accounts exist', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const selector = el.shadowRoot!.querySelector('gn-account-selector');
      expect(selector).to.not.be.null;
    });

    // Regression: the account-selector dispatches a bubbling/composed
    // `manage-accounts` event. The dialog must CONSUME it and re-emit its own,
    // so the host receives EXACTLY ONE event — not the selector's plus the
    // re-dispatch. The double-fire corrupted the manager's reversible-Back state.
    it('forwards manage-accounts to the host exactly once', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const events: CustomEvent[] = [];
      el.addEventListener('manage-accounts', (e) => events.push(e as CustomEvent));

      const selector = el.shadowRoot!.querySelector('gn-account-selector')!;
      selector.dispatchEvent(
        new CustomEvent('manage-accounts', {
          detail: { integrationType: 'gitlab' },
          bubbles: true,
          composed: true,
        })
      );

      expect(events).to.have.lengthOf(1);
      expect(events[0].detail.integrationType).to.equal('gitlab');
    });
  });

  describe('Connection Tab', () => {
    it('shows instance URL input and token input when disconnected', async () => {
      connectionResponse = mockDisconnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const tokenForm = el.shadowRoot!.querySelector('.token-form');
      expect(tokenForm).to.not.be.null;

      // Should have instance URL and token inputs
      const inputs = el.shadowRoot!.querySelectorAll('input');
      expect(inputs.length).to.be.greaterThan(0);

      const passwordInput = el.shadowRoot!.querySelector('input[type="password"]');
      expect(passwordInput).to.not.be.null;
    });

    it('shows user info (name, username) when connected', async () => {
      connectionResponse = mockConnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const connectionStatus = el.shadowRoot!.querySelector('.connection-status');
      expect(connectionStatus).to.not.be.null;

      const userName = el.shadowRoot!.querySelector('.user-name');
      expect(userName).to.not.be.null;
      expect(userName!.textContent).to.include('GL User');

      const userLogin = el.shadowRoot!.querySelector('.user-login');
      expect(userLogin).to.not.be.null;
      expect(userLogin!.textContent).to.include('gluser');
    });

    it('shows disconnect button when connected', async () => {
      connectionResponse = mockConnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const disconnectBtn = el.shadowRoot!.querySelector('.btn-danger');
      expect(disconnectBtn).to.not.be.null;
      expect(disconnectBtn!.textContent?.trim()).to.include('Disconnect');
    });
  });

  describe('Merge Requests Tab', () => {
    it('shows empty state when not connected', async () => {
      connectionResponse = mockDisconnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Switch to Merge Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const mrTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Merge Requests') as HTMLButtonElement;
      mrTab.click();
      await waitForLoad(el);

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
      expect(emptyState!.textContent).to.include('merge requests');
    });

    it('renders MR items with !iid, title, state, and branches', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Switch to Merge Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const mrTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Merge Requests') as HTMLButtonElement;
      mrTab.click();
      await waitForLoad(el);

      const mrItems = el.shadowRoot!.querySelectorAll('.mr-item');
      expect(mrItems.length).to.equal(2);

      const firstMr = mrItems[0];
      expect(firstMr.querySelector('.mr-number')?.textContent).to.include('!15');
      expect(firstMr.querySelector('.mr-title')?.textContent).to.include('Add CI pipeline config');
      expect(firstMr.querySelector('.mr-branch')?.textContent).to.include('feature/ci-setup');
      expect(firstMr.querySelector('.mr-branch')?.textContent).to.include('main');
    });

    it('does not disclose a cap when fewer merge requests come back', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (t) => t.textContent?.trim() === 'Merge Requests',
      ) as HTMLButtonElement).click();
      await waitForLoad(el);

      expect(el.shadowRoot!.querySelectorAll('.mr-item').length).to.equal(mockMergeRequests.length);
      expect(el.shadowRoot!.querySelectorAll('.capped-list-hint').length).to.equal(0);
    });

    it('shows filter dropdown and New MR button', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Switch to Merge Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const mrTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Merge Requests') as HTMLButtonElement;
      mrTab.click();
      await waitForLoad(el);

      const filterSelect = el.shadowRoot!.querySelector('.filter-select');
      expect(filterSelect).to.not.be.null;

      const newMrBtn = Array.from(el.shadowRoot!.querySelectorAll('.btn')).find(
        (b) => b.textContent?.trim().includes('New MR')
      );
      expect(newMrBtn).to.not.be.undefined;
    });

    // The dialog asks the backend for an explicit page size and discloses that
    // same number, so serving exactly what was requested keeps the requested cap
    // and the disclosed cap from drifting apart unnoticed.
    it('discloses capped merge requests with the active filter', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;
      let requestedPerPage = 0;
      const baseInvoke = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'list_gitlab_merge_requests') {
          requestedPerPage = Number((args as Record<string, unknown>).perPage);
          return Array.from({ length: requestedPerPage }, (_, index) => ({
            ...mockMergeRequests[0],
            iid: index + 1,
          }));
        }
        return baseInvoke(command, args);
      };
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (tab) => tab.textContent?.trim() === 'Merge Requests',
      ) as HTMLButtonElement).click();
      await waitForLoad(el);

      expect(requestedPerPage, 'dialog requested an explicit page size').to.be.greaterThan(0);
      expect(el.shadowRoot!.querySelectorAll('.mr-item').length).to.equal(requestedPerPage);
      const hint = el.shadowRoot!.querySelector('.capped-list-hint');
      expect(hint?.textContent).to.include(String(requestedPerPage));
      expect(hint?.querySelector('a')?.getAttribute('href')).to.include('state=opened');
    });
  });

  describe('Issues Tab', () => {
    it('renders issue items with #iid, title, and string labels', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
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
      expect(firstIssue.querySelector('.issue-number')?.textContent).to.include('42');
      expect(firstIssue.querySelector('.issue-title')?.textContent).to.include('Performance regression in API');

      const labels = firstIssue.querySelectorAll('.issue-label');
      expect(labels.length).to.equal(2);
      expect(labels[0].textContent?.trim()).to.equal('bug');
      expect(labels[1].textContent?.trim()).to.equal('performance');
    });

    it('does not disclose a cap when fewer issues come back', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (t) => t.textContent?.trim() === 'Issues',
      ) as HTMLButtonElement).click();
      await waitForLoad(el);

      expect(el.shadowRoot!.querySelectorAll('.issue-item').length).to.equal(mockIssues.length);
      expect(el.shadowRoot!.querySelectorAll('.capped-list-hint').length).to.equal(0);
    });

    it('renders one capped hint for label-less issues', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;
      let requestedPerPage = 0;
      const baseInvoke = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'list_gitlab_issues') {
          requestedPerPage = Number((args as Record<string, unknown>).perPage);
          return Array.from({ length: requestedPerPage }, (_, index) => ({
            ...mockIssues[0],
            iid: index + 1,
            labels: [],
          }));
        }
        return baseInvoke(command, args);
      };
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (tab) => tab.textContent?.trim() === 'Issues',
      ) as HTMLButtonElement).click();
      await waitForLoad(el);

      expect(requestedPerPage, 'dialog requested an explicit page size').to.be.greaterThan(0);
      const hints = el.shadowRoot!.querySelectorAll('.capped-list-hint');
      expect(hints.length).to.equal(1);
      expect(hints[0].textContent).to.include(String(requestedPerPage));
      expect(hints[0].querySelector('a')?.getAttribute('href')).to.include('state=opened');
    });
  });

  describe('Pipelines Tab', () => {
    it('renders pipeline items with status dot, ref, and sha', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Switch to Pipelines tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const pipelinesTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Pipelines') as HTMLButtonElement;
      pipelinesTab.click();
      await waitForLoad(el);

      const pipelineItems = el.shadowRoot!.querySelectorAll('.pipeline-item');
      expect(pipelineItems.length).to.equal(1);

      const firstPipeline = pipelineItems[0];
      expect(firstPipeline.querySelector('.pipeline-ref')?.textContent).to.include('main');

      // Status indicator should exist
      const statusDot = firstPipeline.querySelector('.pipeline-status');
      expect(statusDot).to.not.be.null;

      // Should show truncated sha
      const metaText = firstPipeline.querySelector('.pipeline-meta')?.textContent;
      expect(metaText).to.include('abc12345');
    });

    it('does not disclose a cap when fewer pipelines come back', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (t) => t.textContent?.trim() === 'Pipelines',
      ) as HTMLButtonElement).click();
      await waitForLoad(el);

      expect(el.shadowRoot!.querySelectorAll('.pipeline-item').length).to.equal(mockPipelines.length);
      expect(el.shadowRoot!.querySelectorAll('.capped-list-hint').length).to.equal(0);
    });

    it('discloses when the pipeline list may be truncated', async () => {
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;
      let requestedPerPage = 0;
      const baseInvoke = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'list_gitlab_pipelines') {
          requestedPerPage = Number((args as Record<string, unknown>).perPage);
          return Array.from({ length: requestedPerPage }, (_, index) => ({
            ...mockPipelines[0],
            id: 1000 + index,
            iid: index + 1,
          }));
        }
        return baseInvoke(command, args);
      };

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      const tab = Array.from(el.shadowRoot!.querySelectorAll('.tab')).find(
        (item) => item.textContent?.trim() === 'Pipelines',
      ) as HTMLButtonElement;
      tab.click();
      await waitForLoad(el);

      expect(requestedPerPage, 'dialog requested an explicit page size').to.be.greaterThan(0);
      expect(el.shadowRoot!.querySelectorAll('.pipeline-item').length).to.equal(requestedPerPage);
      const hint = el.shadowRoot!.querySelector('.capped-list-hint');
      expect(hint?.textContent).to.include(String(requestedPerPage));
      expect(hint?.querySelector('a')?.getAttribute('href')).to.include('/-/pipelines');
    });
  });

  describe('Tab Navigation', () => {
    it('clicking tab button changes displayed content', async () => {
      connectionResponse = mockDisconnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Initially on Connection tab - verify token form visible
      const tokenForm = el.shadowRoot!.querySelector('.token-form');
      expect(tokenForm).to.not.be.null;

      // Click Merge Requests tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const mrTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Merge Requests') as HTMLButtonElement;
      mrTab.click();
      await waitForLoad(el);

      // Token form should be gone
      const tokenFormAfter = el.shadowRoot!.querySelector('.token-form');
      expect(tokenFormAfter).to.be.null;

      // Empty state should be visible (not connected)
      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
    });

    it('active tab has correct styling', async () => {
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const connectionTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Connection');
      expect(connectionTab?.classList.contains('active')).to.be.true;

      // Click Merge Requests tab
      const mrTab = Array.from(tabs).find((t) => t.textContent?.trim() === 'Merge Requests') as HTMLButtonElement;
      mrTab.click();
      await el.updateComplete;

      expect(mrTab.classList.contains('active')).to.be.true;
      expect(connectionTab?.classList.contains('active')).to.be.false;
    });
  });

  describe('Error Handling', () => {
    it('displays error message when error state is set', async () => {
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // Set error state directly to test error rendering
      (el as unknown as { error: string | null }).error = 'GitLab instance unreachable';
      await el.updateComplete;

      const errorMsg = el.shadowRoot!.querySelector('.error');
      expect(errorMsg).to.not.be.null;
      expect(errorMsg!.textContent).to.include('GitLab instance unreachable');
    });

    it('surfaces a backend error when repo detection fails (not silent)', async () => {
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'detect_gitlab_repo') throw new Error('gitlab detect boom');
        return origMock(command, args);
      };

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.include('gitlab detect boom');
    });
  });

  describe('Delete Integration (M7/M10)', () => {
    function setupConnectedWithAccount(): void {
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);
    }

    async function openConnectedDialog(): Promise<GnGitLabDialog> {
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      // Ensure the dialog has a selected account to delete.
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gl-acc-1';
      await el.updateComplete;
      return el;
    }

    it('M10: deletes the account record BEFORE the keyring token (record is source of truth)', async () => {
      setupConnectedWithAccount();
      const el = await openConnectedDialog();

      uiStore.getState().toasts.length = 0;
      invokeHistory.length = 0;

      // Auto-confirm the destructive dialog.
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
      // M10: record must be deleted first; token cleanup is best-effort last.
      expect(deleteAccountIdx).to.be.lessThan(deleteTokenIdx);
    });

    it('M7: surfaces an error (inline + toast) when account deletion fails', async () => {
      setupConnectedWithAccount();
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

      // Inline error surfaced.
      expect((el as unknown as { error: string | null }).error).to.include('delete record boom');
      // Toast surfaced (not console-only).
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /delete record boom/.test(t.message))).to.be.true;
    });

    it('M10: completes deletion and clears the account from the UI on success', async () => {
      setupConnectedWithAccount();
      const el = await openConnectedDialog();

      uiStore.getState().toasts.length = 0;

      const origMock = mockInvoke;
      let recordDeleted = false;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command.startsWith('plugin:dialog|')) return 'Ok';
        if (command === 'delete_global_account') {
          recordDeleted = true;
          return null;
        }
        // After the record is deleted, the reloaded config no longer lists it,
        // matching real backend behavior.
        if (command === 'get_unified_profiles_config' && recordDeleted) {
          return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
        }
        return origMock(command, args);
      };

      await (el as unknown as { handleDeleteIntegration: () => Promise<void> }).handleDeleteIntegration();
      await el.updateComplete;

      // Account is gone from the dialog and no error surfaced on the happy path.
      expect((el as unknown as { accounts: IntegrationAccount[] }).accounts).to.have.lengthOf(0);
      expect((el as unknown as { error: string | null }).error).to.be.null;
    });
  });

  describe('OAuth failure is surfaced (not a silent dead-end)', () => {
    it('shows an error and a toast when the OAuth flow errors', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_unified_profiles_config') {
          return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
        }
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return null;
      };

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await oauthService.startOAuth('gitlab', 'test-client-id', 'https://gitlab.com');
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error, 'error surfaced').to.be.a('string').and.not.empty;
      expect(uiStore.getState().toasts.some((t) => t.type === 'error'), 'error toast shown').to.be.true;
    });
  });

  describe('Add account guard', () => {
    it('does not re-select an existing account when a background store emit fires mid-add', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;
      expect((el as unknown as { selectedAccountId: string | null }).selectedAccountId).to.equal(null);

      unifiedProfileStore.getState().setAccountConnectionStatus('gl-acc-1', 'connected');
      await el.updateComplete;

      expect((el as unknown as { selectedAccountId: string | null }).selectedAccountId).to.equal(null);
    });

    it('creates a NEW account (not clobbering an existing same-instance account) on OAuth complete when adding', async () => {
      connectionResponse = mockConnectedStatus;
      // An account already exists for gitlab.com. The user adds a SECOND identity
      // on the same instance — the find-existing fallback must not match it.
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { handleAddAccount: () => void }).handleAddAccount();
      await el.updateComplete;
      (el as unknown as { instanceUrlInput: string }).instanceUrlInput = 'https://gitlab.com';
      await el.updateComplete;

      invokeHistory.length = 0;
      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'gitlab',
            tokens: { accessToken: 'glpat_oauth_2' },
            instanceUrl: 'https://gitlab.com',
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const saveCall = invokeHistory.find((h) => h.command === 'save_global_account');
      expect(saveCall, 'save_global_account was called').to.not.be.undefined;
      const account = (saveCall!.args as Record<string, unknown>).account as IntegrationAccount;
      expect(account.id).to.not.equal('gl-acc-1');
      expect(account.config).to.deep.include({ type: 'gitlab', instanceUrl: 'https://gitlab.com' });
    });
  });

  describe('OAuth completes after dialog closed', () => {
    it('persists the account and surfaces a toast instead of failing silently', async () => {
      connectionResponse = mockConnectedStatus;
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${false}></gn-gitlab-dialog>
      `);
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      invokeHistory.length = 0;

      window.dispatchEvent(
        new CustomEvent('oauth-complete', {
          detail: {
            provider: 'gitlab',
            tokens: { accessToken: 'glpat_oauth' },
            instanceUrl: 'https://gitlab.com',
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const persisted = invokeHistory.filter(
        (h) => h.command === 'save_global_account' || h.command === 'store_keyring_token'
      );
      expect(persisted.length).to.be.greaterThan(0);

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /Connected GitLab/.test(t.message))).to.be.true;
    });
  });

  describe('OAuth updates shared connection status (regression)', () => {
    it('marks the account connected in the shared store after OAuth completes', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gl-acc-1';
      await el.updateComplete;

      // Clear any status set during load so we observe the OAuth-driven update.
      unifiedProfileStore.setState({ accountConnectionStatus: {} });

      await (el as unknown as {
        handleOAuthComplete: (t: { accessToken: string }, url?: string) => Promise<void>;
      }).handleOAuthComplete({ accessToken: 'glpat_oauth' }, 'https://gitlab.com');
      await el.updateComplete;

      const status = unifiedProfileStore.getState().accountConnectionStatus['gl-acc-1'];
      expect(status?.status).to.equal('connected');
    });
  });

  // The browser round-trip is asynchronous: the user can switch accounts (or
  // start "Add account", or delete the account) between clicking "Sign in with
  // GitLab" and the callback landing. The flow must stay bound to the account it
  // started on instead of writing the new token onto whatever is selected then.
  describe('OAuth target pinning (regression)', () => {
    interface GitLabDialogInternals {
      oauthTargetAccountId: string | null | undefined;
      oauthTargetWasAddingAccount: boolean | undefined;
      oauthTargetInstanceUrl: string | undefined;
      selectedAccountId: string | null;
      isAddingAccount: boolean;
      instanceUrlInput: string;
      error: string | null;
      handleStartOAuth(): Promise<void>;
      handleCancelOAuth(): void;
      handleOAuthComplete(
        tokens: { accessToken: string; refreshToken?: string; expiresIn?: number },
        instanceUrl?: string
      ): Promise<void>;
    }

    const secondAccount = createTestAccount({
      id: 'gl-acc-2',
      name: 'Personal GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
      isDefault: false,
    });

    /**
     * Hold `check_gitlab_connection_with_token` open so the test can mutate the
     * dialog's selection while an OAuth completion is still in flight.
     */
    function gateVerification(): { started: Promise<void>; release: () => void } {
      let release!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'check_gitlab_connection') {
          markStarted();
          await gate;
        }
        return previous(command, args);
      };
      return { started, release };
    }

    it('pins the selected account and instance when the sign-in flow starts', async () => {
      accountsResponse = [mockAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'oauth_get_authorize_url') {
          return { authorizeUrl: 'https://gitlab.example.com/oauth/authorize', state: 'st-1' };
        }
        return previous(command, args);
      };

      const internals = el as unknown as GitLabDialogInternals;
      internals.selectedAccountId = 'gl-acc-1';
      internals.isAddingAccount = false;
      internals.instanceUrlInput = 'https://gitlab.example.com';

      await internals.handleStartOAuth();

      expect(internals.oauthTargetAccountId, 'account pinned at start').to.equal('gl-acc-1');
      expect(internals.oauthTargetWasAddingAccount, 'add-account pinned at start').to.be.false;
      expect(internals.oauthTargetInstanceUrl, 'instance pinned at start').to.equal(
        'https://gitlab.example.com'
      );
    });

    it('releases the pinned target when the sign-in flow fails to start', async () => {
      accountsResponse = [mockAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'oauth_get_authorize_url') {
          throw new Error('Authorize URL request failed');
        }
        return previous(command, args);
      };

      const internals = el as unknown as GitLabDialogInternals;
      internals.selectedAccountId = 'gl-acc-1';
      internals.isAddingAccount = false;
      // A pin left over from an earlier attempt must not survive a flow that
      // never started — a later completion would otherwise be attributed to it.
      internals.oauthTargetAccountId = 'gl-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetInstanceUrl = 'https://gitlab.com';

      // `startOAuth` never rejects — it reports the failure through the OAuth
      // state subscriber.
      await internals.handleStartOAuth();
      await el.updateComplete;

      expect(internals.oauthTargetAccountId, 'pin released').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;
      expect(internals.oauthTargetInstanceUrl, 'instance pin released').to.be.undefined;
    });

    it('writes the token to the account the flow started on, not a later selection', async () => {
      connectionResponse = mockConnectedStatus;
      accountsResponse = [mockAccount, secondAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount, secondAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as GitLabDialogInternals;
      internals.selectedAccountId = 'gl-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'gl-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetInstanceUrl = 'https://gitlab.com';

      const gate = gateVerification();
      const completion = internals.handleOAuthComplete(
        { accessToken: 'glpat_reauth', refreshToken: 'r-1', expiresIn: 3600 },
        'https://gitlab.com'
      );
      await gate.started;
      // The user switches to a different account while the browser round-trip
      // is still outstanding.
      internals.selectedAccountId = 'gl-acc-2';
      gate.release();
      await completion;

      expect(keyringStore.get('gitlab_token_gl-acc-1')).to.equal('glpat_reauth');
      expect(
        keyringStore.has('gitlab_token_gl-acc-2'),
        'the newly selected account is not overwritten'
      ).to.be.false;
      expect(internals.selectedAccountId, 'newer selection preserved').to.equal('gl-acc-2');
    });

    it('keeps a newer add-account flow when a re-auth completes', async () => {
      connectionResponse = mockConnectedStatus;
      accountsResponse = [mockAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as GitLabDialogInternals;
      internals.selectedAccountId = 'gl-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'gl-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetInstanceUrl = 'https://gitlab.com';

      const gate = gateVerification();
      const completion = internals.handleOAuthComplete(
        { accessToken: 'glpat_reauth_2', refreshToken: 'r-2', expiresIn: 3600 },
        'https://gitlab.com'
      );
      await gate.started;
      internals.selectedAccountId = null;
      internals.isAddingAccount = true;
      // loadInitialData's connection check already marked gl-acc-1 connected —
      // clear it so the final assertion proves handleOAuthComplete set it for
      // the OAuth target, not for the newer (mid-flight) selection.
      unifiedProfileStore.getState().setAccountConnectionStatus('gl-acc-1', 'disconnected');
      gate.release();
      await completion;

      expect(keyringStore.get('gitlab_token_gl-acc-1')).to.equal('glpat_reauth_2');
      expect(internals.selectedAccountId, 'add-account selection preserved').to.be.null;
      expect(internals.isAddingAccount, 'add-account flow preserved').to.be.true;
      expect(
        unifiedProfileStore.getState().accountConnectionStatus['gl-acc-1']?.status,
        'the signed-in account is still marked connected'
      ).to.equal('connected');
    });

    it('does not recreate an account deleted during the OAuth round-trip', async () => {
      connectionResponse = mockConnectedStatus;
      accountsResponse = [mockAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as GitLabDialogInternals;
      internals.selectedAccountId = 'gl-acc-1';
      internals.isAddingAccount = false;
      internals.oauthTargetAccountId = 'gl-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetInstanceUrl = 'https://gitlab.com';

      const gate = gateVerification();
      invokeHistory.length = 0;
      const completion = internals.handleOAuthComplete(
        { accessToken: 'orphan-token', refreshToken: 'r-3', expiresIn: 3600 },
        'https://gitlab.com'
      );
      await gate.started;
      // The account is deleted from the profile manager mid-flow.
      unifiedProfileStore.getState().setAccounts([]);
      keyringStore.delete('gitlab_token_gl-acc-1');
      gate.release();
      await completion;

      expect(
        invokeHistory.some((h) => h.command === 'save_global_account'),
        'a deleted account is not resurrected as a new one'
      ).to.be.false;
      expect(
        keyringStore.has('gitlab_token_gl-acc-1'),
        'no orphaned credential remains'
      ).to.be.false;
      expect(internals.error).to.match(/account was removed/i);
    });

    it('releases the pinned target when the user cancels a pending sign-in', async () => {
      accountsResponse = [mockAccount];
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const internals = el as unknown as GitLabDialogInternals;
      internals.oauthTargetAccountId = 'gl-acc-1';
      internals.oauthTargetWasAddingAccount = false;
      internals.oauthTargetInstanceUrl = 'https://gitlab.com';

      internals.handleCancelOAuth();

      expect(internals.oauthTargetAccountId, 'pin released on cancel').to.be.undefined;
      expect(internals.oauthTargetWasAddingAccount, 'add-account pin released').to.be.undefined;
      expect(internals.oauthTargetInstanceUrl, 'instance pin released').to.be.undefined;
    });
  });

  // Without a Cancel affordance a user who closes the browser tab without
  // authorizing is stuck: the sign-in button, the instance-URL input, the
  // auth-method toggles AND the PAT save button are all disabled until the
  // backend loopback wait times out (~5 minutes).
  describe('Cancelling a pending OAuth sign-in', () => {
    /** Starts a GitLab sign-in that hangs waiting for the browser callback. */
    async function startPendingSignIn(options: { cancelFails?: boolean } = {}) {
      const previousMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'oauth_get_authorize_url') {
          return {
            authorizeUrl: 'https://gitlab.com/oauth/authorize',
            state: 'gl-state-1',
            loopbackPort: 8086,
          };
        }
        // Never resolves: the flow stays pending, as it does while the user is
        // in the browser.
        if (command === 'oauth_wait_for_callback') return new Promise(() => {});
        if (command === 'oauth_cancel_flow' && options.cancelFails) {
          throw new Error('No server found for port 8086');
        }
        return previousMock(command, args);
      };

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await el.updateComplete;

      await oauthService.startOAuth('gitlab', 'test-client-id');
      await el.updateComplete;
      return el;
    }

    afterEach(() => {
      oauthService.cancelOAuth();
    });

    it('offers a Cancel button while pending and returns the form to idle', async () => {
      const el = await startPendingSignIn();

      const signInButton = el.shadowRoot!.querySelector('.btn-oauth') as HTMLButtonElement;
      expect(signInButton.disabled, 'sign in is disabled while pending').to.be.true;
      const cancelButton = el.shadowRoot!.querySelector('.oauth-cancel') as HTMLButtonElement;
      expect(cancelButton, 'a pending sign-in must offer a way out').to.exist;

      invokeHistory.length = 0;
      cancelButton.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 10));

      expect((el as unknown as { oauthState: { status: string } }).oauthState.status).to.equal(
        'idle'
      );
      expect((el.shadowRoot!.querySelector('.btn-oauth') as HTMLButtonElement).disabled).to.be.false;
      expect(
        el.shadowRoot!.querySelector('.oauth-cancel'),
        'cancel disappears once idle'
      ).to.not.exist;
      expect(el.shadowRoot!.querySelector('.oauth-spinner'), 'spinner is gone').to.not.exist;

      const release = invokeHistory.find((h) => h.command === 'oauth_cancel_flow');
      expect(release, 'the backend loopback server is released').to.exist;
      expect(release!.args).to.deep.equal({ port: 8086 });
    });

    it('returns the dialog to idle even when the backend release fails', async () => {
      const el = await startPendingSignIn({ cancelFails: true });

      const cancelButton = el.shadowRoot!.querySelector('.oauth-cancel') as HTMLButtonElement;
      expect(cancelButton).to.exist;

      cancelButton.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 10));

      expect((el.shadowRoot!.querySelector('.btn-oauth') as HTMLButtonElement).disabled).to.be
        .false;
      expect(el.shadowRoot!.querySelector('.oauth-spinner'), 'no spinner remains').to.not.exist;
      expect(
        el.shadowRoot!.querySelector('.oauth-status.error'),
        'a failed release is not user-facing'
      ).to.not.exist;
      expect((el as unknown as { error: string | null }).error).to.be.null;
    });

    it('leaves a sign-in pending in another provider dialog alone', async () => {
      const el = await startPendingSignIn();

      oauthService.cancelOAuth();
      await oauthService.startOAuth('bitbucket', 'bb-client');
      await oauthService.startOAuth('gitlab', 'gl-client');

      (el as unknown as { handleCancelOAuth(): void }).handleCancelOAuth();

      expect(
        oauthService.getPendingProvider(),
        'a sign-in pending in another provider dialog is left alone'
      ).to.equal('bitbucket');
      oauthService.cancelOAuth();
    });
  });

  describe('Create feedback toasts (regression)', () => {
    it('shows a success toast after creating a merge request', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { createMrTitle: string }).createMrTitle = 'My MR';
      (el as unknown as { createMrSource: string }).createMrSource = 'feature/x';
      (el as unknown as { createMrTarget: string }).createMrTarget = 'main';
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      await (el as unknown as { handleCreateMr: () => Promise<void> }).handleCreateMr();
      await el.updateComplete;

      expect(
        uiStore.getState().toasts.some(
          (t) => t.type === 'success' && /Merge request created successfully/.test(t.message)
        )
      ).to.be.true;
    });

    it('shows a success toast after creating an issue', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

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
  });

  describe('Disconnect clears a stale error (regression)', () => {
    it('handleDisconnect resets a pre-existing error banner', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gl-acc-1';
      (el as unknown as { error: string | null }).error = 'stale error';
      await el.updateComplete;

      await (el as unknown as { handleDisconnect: () => Promise<void> }).handleDisconnect();
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.equal(null);
    });
  });
  // Regression: GitLab OAuth access tokens expire in ~2h. The dialog used to read
  // the raw stored access token, so a signed-in account read as disconnected on
  // the next open (and was marked disconnected app-wide) despite a valid stored
  // refresh token. The token read must be refresh-aware, like Azure DevOps'.
  describe('OAuth token refresh (regression)', () => {
    /** Seed an OAuth bundle whose access token expires within the 5-min window. */
    function seedExpiringOAuthToken(accountId = 'gl-acc-1'): void {
      keyringStore.set(`gitlab_token_${accountId}`, 'stale-access');
      keyringStore.set(
        `gitlab_token_${accountId}_oauth`,
        JSON.stringify({
          accessToken: 'stale-access',
          refreshToken: 'r1',
          expiresAt: Date.now() + 60_000,
        })
      );
    }

    function findInvoke(command: string): { command: string; args: unknown } | undefined {
      return invokeHistory.find((h) => h.command === command);
    }

    it('refreshes an expiring OAuth access token before checking the connection', async () => {
      seedExpiringOAuthToken();
      refreshResponse = { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 };
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      const check = findInvoke('check_gitlab_connection');
      expect(check, 'connection was checked').to.not.be.undefined;
      expect((check!.args as { token: string }).token).to.equal('fresh-access');
      expect(
        unifiedProfileStore.getState().accountConnectionStatus['gl-acc-1']?.status
      ).to.equal('connected');
    });

    it("refreshes against the account's instance, not the detected repo's", async () => {
      const selfHosted = createTestAccount({
        id: 'gl-acc-1',
        name: 'Self-hosted GitLab',
        integrationType: 'gitlab',
        config: { type: 'gitlab', instanceUrl: 'https://gitlab.example.com' },
        isDefault: true,
      });
      accountsResponse = [selfHosted];
      seedExpiringOAuthToken();
      refreshResponse = { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 };
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([selfHosted]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      // A detected repo (or a typed-in URL) on gitlab.com must not redirect the
      // refresh grant away from the instance the account belongs to.
      const priv = el as unknown as {
        instanceUrlInput: string;
        checkConnection: () => Promise<void>;
      };
      priv.instanceUrlInput = 'https://gitlab.com';
      // The open-load already rotated the bundle; make it expiring again so this
      // check has to refresh.
      seedExpiringOAuthToken();
      invokeHistory.length = 0;
      await priv.checkConnection();

      const refresh = findInvoke('oauth_refresh_token');
      expect(refresh, 'a refresh was attempted').to.not.be.undefined;
      expect((refresh!.args as { instanceUrl?: string }).instanceUrl).to.equal(
        'https://gitlab.example.com'
      );
    });

    it('falls back to the stored token and reports disconnected when the refresh fails', async () => {
      seedExpiringOAuthToken();
      refreshResponse = null; // invokeCommand treats null as a failed command
      connectionResponse = mockDisconnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      expect(findInvoke('oauth_refresh_token'), 'a refresh was attempted').to.not.be.undefined;
      const check = findInvoke('check_gitlab_connection');
      expect(
        (check!.args as { token: string }).token,
        'falls back to the stored token rather than dead-ending'
      ).to.equal('stale-access');
      expect(
        unifiedProfileStore.getState().accountConnectionStatus['gl-acc-1']?.status
      ).to.equal('disconnected');
      // The user is offered the connect form instead of a silent failure.
      expect(el.shadowRoot!.querySelector('input[type="password"]')).to.not.be.null;
    });

    it('does not attempt a refresh for a personal access token account', async () => {
      keyringStore.set('gitlab_token_gl-acc-1', 'glpat-plain');
      keyringStore.delete('gitlab_token_gl-acc-1_oauth');
      connectionResponse = mockConnectedStatus;
      unifiedProfileStore.getState().setAccounts([mockAccount]);

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      expect(findInvoke('oauth_refresh_token'), 'PATs are never refreshed').to.be.undefined;
      const check = findInvoke('check_gitlab_connection');
      expect((check!.args as { token: string }).token).to.equal('glpat-plain');
    });
  });

  describe('Create issue labels', () => {
    async function openCreateIssueTab(): Promise<GnGitLabDialog> {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { activeTab: string }).activeTab = 'create-issue';
      await el.updateComplete;
      return el;
    }

    function chips(el: GnGitLabDialog): HTMLElement[] {
      return Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.label-chip'));
    }

    function lastCreateIssueInput(): { labels?: string[]; title?: string } | undefined {
      const entries = invokeHistory.filter((e) => e.command === 'create_gitlab_issue');
      if (entries.length === 0) return undefined;
      const args = entries[entries.length - 1].args as Record<string, unknown>;
      return args.input as { labels?: string[]; title?: string };
    }

    it('loads the project labels when the New Issue button is clicked', async () => {
      unifiedProfileStore.getState().setAccounts([mockAccount]);
      connectionResponse = mockConnectedStatus;
      detectedRepoResponse = mockDetectedRepo;

      const el = await fixture<GnGitLabDialog>(html`
        <gn-gitlab-dialog .open=${true} .repositoryPath=${'/mock/repo'}></gn-gitlab-dialog>
      `);
      await waitForLoad(el);

      (el as unknown as { activeTab: string }).activeTab = 'issues';
      await el.updateComplete;

      // Only the click must be credited — the create-issue tab has no other
      // loader, so opening the form is what has to fetch the labels.
      const before = invokeHistory.length;

      const newIssueBtn = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLElement>('.btn')
      ).find((b) => b.textContent?.trim() === '+ New Issue')!;
      expect(newIssueBtn, 'New Issue button').to.not.be.undefined;
      newIssueBtn.click();
      await waitForLoad(el);

      expect(
        invokeHistory.slice(before).some((e) => e.command === 'get_gitlab_labels')
      ).to.be.true;
      expect(chips(el).length).to.equal(3);
    });

    it('renders a chip for every project label on the create-issue form', async () => {
      const el = await openCreateIssueTab();

      const rendered = chips(el);
      expect(rendered.length).to.equal(3);
      expect(rendered.map((c) => c.textContent?.trim())).to.deep.equal([
        'bug',
        'enhancement',
        'performance',
      ]);
    });

    it('sends the selected labels to create_gitlab_issue', async () => {
      const el = await openCreateIssueTab();

      (el as unknown as { createIssueTitle: string }).createIssueTitle = 'Labelled issue';
      await el.updateComplete;

      const bug = chips(el).find((c) => c.textContent?.trim() === 'bug')!;
      bug.click();
      await el.updateComplete;

      expect(
        chips(el).find((c) => c.textContent?.trim() === 'bug')!.classList.contains('selected')
      ).to.be.true;

      await (el as unknown as { handleCreateIssue: () => Promise<void> }).handleCreateIssue();
      await el.updateComplete;

      expect(lastCreateIssueInput()?.labels).to.deep.equal(['bug']);
      // Successful create resets the picker for the next issue.
      expect((el as unknown as { createIssueLabels: string[] }).createIssueLabels).to.deep.equal([]);
    });

    it('deselects a label when its chip is clicked again', async () => {
      const el = await openCreateIssueTab();

      (el as unknown as { createIssueTitle: string }).createIssueTitle = 'No labels after all';
      await el.updateComplete;

      chips(el).find((c) => c.textContent?.trim() === 'bug')!.click();
      await el.updateComplete;
      chips(el).find((c) => c.textContent?.trim() === 'bug')!.click();
      await el.updateComplete;

      const bug = chips(el).find((c) => c.textContent?.trim() === 'bug')!;
      expect(bug.classList.contains('selected')).to.be.false;
      expect(bug.getAttribute('aria-pressed')).to.equal('false');

      await (el as unknown as { handleCreateIssue: () => Promise<void> }).handleCreateIssue();
      await el.updateComplete;

      // Empty selection is omitted, not sent as an empty array.
      expect(lastCreateIssueInput()?.labels).to.equal(undefined);
    });

    it('drops selections for labels the new project does not have', async () => {
      const el = await openCreateIssueTab();

      chips(el).find((c) => c.textContent?.trim() === 'bug')!.click();
      await el.updateComplete;
      expect((el as unknown as { createIssueLabels: string[] }).createIssueLabels).to.deep.equal([
        'bug',
      ]);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_gitlab_labels') return ['enhancement'];
        return previous(command, args);
      };

      await (el as unknown as { loadLabels: () => Promise<void> }).loadLabels();
      await el.updateComplete;

      expect((el as unknown as { labels: string[] }).labels).to.deep.equal(['enhancement']);
      expect((el as unknown as { createIssueLabels: string[] }).createIssueLabels).to.deep.equal([]);
    });

    it('keeps the picker and reports the failure when the labels request fails', async () => {
      const el = await openCreateIssueTab();
      expect(chips(el).length).to.equal(3);

      const previous = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_gitlab_labels') throw new Error('GitLab API error 500');
        return previous(command, args);
      };

      await (el as unknown as { loadLabels: () => Promise<void> }).loadLabels();
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.equal('GitLab API error 500');
      // A failed refresh must not wipe the already-rendered picker.
      expect(chips(el).length).to.equal(3);
    });

    it('clears labels and selections on disconnect', async () => {
      const el = await openCreateIssueTab();
      (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'gl-acc-1';

      chips(el).find((c) => c.textContent?.trim() === 'bug')!.click();
      await el.updateComplete;

      await (el as unknown as { handleDisconnect: () => Promise<void> }).handleDisconnect();
      (el as unknown as { activeTab: string }).activeTab = 'create-issue';
      await el.updateComplete;

      expect((el as unknown as { labels: string[] }).labels).to.deep.equal([]);
      expect((el as unknown as { createIssueLabels: string[] }).createIssueLabels).to.deep.equal([]);
      expect(chips(el).length).to.equal(0);
    });
  });
});
