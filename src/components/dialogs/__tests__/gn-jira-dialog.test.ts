/**
 * Jira Integration Dialog Tests
 *
 * Tests loading/saving/deleting Jira config, testing connection,
 * listing issues, creating a branch from an issue, and transitioning issue status.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { JiraConfig, JiraIssue, JiraTransition } from '../../../services/git.service.ts';

let mockConfig: JiraConfig | null = null;
let mockIssues: JiraIssue[] = [];
let mockTransitions: JiraTransition[] = [];
let failCommand: string | null = null;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  invokeCalls.push({ command, args });
  if (failCommand === command) {
    throw { code: 'OPERATION_FAILED', message: `${command} failed` };
  }

  const params = args as Record<string, unknown> | undefined;

  switch (command) {
    case 'get_jira_config':
      return mockConfig;
    case 'save_jira_config':
      mockConfig = (params?.config as JiraConfig) ?? null;
      return null;
    case 'delete_jira_config':
      mockConfig = null;
      return null;
    case 'test_jira_connection':
      return true;
    case 'get_jira_issues':
      return mockIssues;
    case 'get_jira_transitions':
      return mockTransitions;
    case 'transition_jira_issue':
      return null;
    case 'create_branch':
      return {
        name: params?.name ?? 'feature/PROJ-123-fix-login-bug',
        shorthand: params?.name ?? 'feature/PROJ-123-fix-login-bug',
        isHead: true,
        isRemote: false,
        upstream: null,
        targetOid: 'abc1234',
        aheadBehind: null,
        lastCommitTimestamp: null,
         isStale: false,
      };
    case 'plugin:notification|is_permission_granted':
      return false;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import '../gn-jira-dialog.ts';
import type { GnJiraDialog } from '../gn-jira-dialog.ts';
import { uiStore } from '../../../stores/ui.store.ts';

describe('gn-jira-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    failCommand = null;
    uiStore.setState({ toasts: [] });
    mockConfig = {
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.com',
      apiToken: 'secret-token',
      projectKey: 'PROJ',
    };
    mockIssues = [
      {
        key: 'PROJ-123',
        summary: 'Fix login bug',
        status: 'To Do',
        issueType: 'Bug',
        assignee: 'Alice',
        priority: 'High',
        url: 'https://acme.atlassian.net/browse/PROJ-123',
      },
      {
        key: 'PROJ-456',
        summary: 'Add dark mode',
        status: 'In Progress',
        issueType: 'Story',
        assignee: null,
        priority: 'Medium',
        url: 'https://acme.atlassian.net/browse/PROJ-456',
      },
    ];
    mockTransitions = [
      { id: '21', name: 'In Progress' },
      { id: '31', name: 'Done' },
    ];
  });

  it('loads and saves Jira config and dispatches jira-config-changed', async () => {
    const el = await fixture<GnJiraDialog>(html`
      <gn-jira-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-jira-dialog>
    `);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(invokeCalls.some((c) => c.command === 'get_jira_config')).to.be.true;

    // Switch to settings tab
    const settingsTab = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-tab="settings"]')!;
    settingsTab.click();
    await el.updateComplete;

    const baseUrlInput = el.shadowRoot!.querySelector<HTMLInputElement>('#jira-base-url')!;
    const emailInput = el.shadowRoot!.querySelector<HTMLInputElement>('#jira-email')!;
    const projectInput = el.shadowRoot!.querySelector<HTMLInputElement>('#jira-project-key')!;

    expect(baseUrlInput.value).to.equal('https://acme.atlassian.net');
    expect(emailInput.value).to.equal('dev@acme.com');
    expect(projectInput.value).to.equal('PROJ');

    projectInput.value = 'NEWPROJ';
    projectInput.dispatchEvent(new Event('input'));
    await el.updateComplete;

    let configChangedFired = false;
    el.addEventListener('jira-config-changed', () => {
      configChangedFired = true;
    });

    const saveBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('.save-config-btn')!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(configChangedFired).to.be.true;
    const saveCall = invokeCalls.find((c) => c.command === 'save_jira_config');
    expect(saveCall).to.not.be.undefined;
    expect((saveCall!.args as { config: JiraConfig }).config.projectKey).to.equal('NEWPROJ');
    expect(el.shadowRoot!.querySelector('.success-banner')).to.not.be.null;
  });

  it('deletes Jira config and dispatches jira-config-changed', async () => {
    const el = await fixture<GnJiraDialog>(html`
      <gn-jira-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-jira-dialog>
    `);
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const settingsTab = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-tab="settings"]')!;
    settingsTab.click();
    await el.updateComplete;

    let configChangedFired = false;
    el.addEventListener('jira-config-changed', () => {
      configChangedFired = true;
    });

    const deleteBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('.delete-config-btn')!;
    deleteBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(configChangedFired).to.be.true;
    expect(invokeCalls.some((c) => c.command === 'delete_jira_config')).to.be.true;
    expect(el.shadowRoot!.querySelector('.success-banner')).to.not.be.null;
  });

  it('tests connection and displays success and error feedback', async () => {
    const el = await fixture<GnJiraDialog>(html`
      <gn-jira-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-jira-dialog>
    `);
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const settingsTab = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-tab="settings"]')!;
    settingsTab.click();
    await el.updateComplete;

    const testBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('.test-connection-btn')!;
    testBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(invokeCalls.some((c) => c.command === 'test_jira_connection')).to.be.true;
    expect(el.shadowRoot!.querySelector('.success-banner')?.textContent).to.include(
      'Successfully connected',
    );

    // Test failure case
    failCommand = 'test_jira_connection';
    testBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.error-banner')?.textContent).to.include(
      'test_jira_connection failed',
    );
  });

  it('lists issues and creates a branch from an issue, dispatching branch-created', async () => {
    const el = await fixture<GnJiraDialog>(html`
      <gn-jira-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-jira-dialog>
    `);
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const issueItems = el.shadowRoot!.querySelectorAll('.issue-item');
    expect(issueItems.length).to.equal(2);
    expect(issueItems[0].querySelector('.issue-key')?.textContent).to.equal('PROJ-123');
    expect(issueItems[0].querySelector('.issue-summary')?.textContent).to.equal('Fix login bug');

    let createdBranchName: string | null = null;
    el.addEventListener('branch-created', ((e: CustomEvent<{ name: string }>) => {
      createdBranchName = e.detail.name;
    }) as EventListener);

    const createBranchBtn = issueItems[0].querySelector<HTMLButtonElement>('.create-branch-btn')!;
    createBranchBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(createdBranchName).to.equal('feature/PROJ-123-fix-login-bug');
    const createCall = invokeCalls.find((c) => c.command === 'create_branch');
    expect(createCall).to.not.be.undefined;
    expect(createCall!.args).to.deep.include({
      path: '/test/repo',
      name: 'feature/PROJ-123-fix-login-bug',
      checkout: true,
    });
  });

  it('loads transitions and transitions an issue status', async () => {
    const el = await fixture<GnJiraDialog>(html`
      <gn-jira-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-jira-dialog>
    `);
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const firstIssue = el.shadowRoot!.querySelector('.issue-item')!;
    const loadTransitionsBtn =
      firstIssue.querySelector<HTMLButtonElement>('.load-transitions-btn')!;
    loadTransitionsBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    expect(invokeCalls.some((c) => c.command === 'get_jira_transitions')).to.be.true;

    const transitionOptionBtn =
      firstIssue.querySelector<HTMLButtonElement>('.transition-option-btn[data-transition-id="31"]')!;
    expect(transitionOptionBtn).to.not.be.null;

    transitionOptionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const transitionCall = invokeCalls.find((c) => c.command === 'transition_jira_issue');
    expect(transitionCall).to.not.be.undefined;
    expect(transitionCall!.args).to.deep.equal({
      path: '/test/repo',
      issueKey: 'PROJ-123',
      transitionId: '31',
    });
  });
});
