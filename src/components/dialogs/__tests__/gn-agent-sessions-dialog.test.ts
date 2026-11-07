/**
 * Agent Sessions dialog tests (fixture-based). Only Tauri invoke is mocked.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let sessionsResponse: unknown = [];
let terminalError: string | null = null;

const mockInvoke: MockInvoke = async (command) => {
  switch (command) {
    case 'list_agent_sessions':
      if (sessionsResponse instanceof Error) throw sessionsResponse;
      return sessionsResponse;
    case 'open_terminal':
      if (terminalError) throw new Error(terminalError);
      return null;
    case 'plugin:notification|is_permission_granted':
      return false;
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-agent-sessions-dialog.ts';
import type { GnAgentSessionsDialog } from '../gn-agent-sessions-dialog.ts';
import type { AgentSession } from '../../../services/agent-sessions.service.ts';
import { formatElapsed } from '../../../services/agent-sessions.service.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO = '/repo/main';

function session(pid: number, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    pid,
    agent: 'Claude Code',
    command: 'claude',
    cwd: REPO,
    worktreePath: REPO,
    isMainWorktree: true,
    branch: 'main',
    state: 'running',
    startedAt: 0,
    elapsedSecs: 125,
    changedFiles: 3,
    ...extra,
  };
}

async function render(): Promise<GnAgentSessionsDialog> {
  const el = await fixture<GnAgentSessionsDialog>(
    html`<gn-agent-sessions-dialog .repositoryPath=${REPO}></gn-agent-sessions-dialog>`,
  );
  el.open = true;
  await el.updateComplete;
  await waitUntil(() => invokeCalls.some((c) => c.command === 'list_agent_sessions'));
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const $ = (el: GnAgentSessionsDialog, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const $$ = (el: GnAgentSessionsDialog, sel: string) =>
  Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>(sel));

describe('gn-agent-sessions-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    sessionsResponse = [];
    terminalError = null;
    uiStore.setState({ toasts: [] });
  });

  it('lists running agents with state, branch, worktree, changes and elapsed time', async () => {
    sessionsResponse = [
      session(10, { state: 'working' }),
      session(20, {
        agent: 'Codex CLI',
        state: 'waiting',
        isMainWorktree: false,
        worktreePath: '/wt/feature',
        branch: 'feature',
        changedFiles: 1,
        elapsedSecs: 7500,
      }),
    ];
    const el = await render();

    const rows = $$(el, '.session');
    expect(rows).to.have.length(2);
    expect(rows[0].textContent).to.contain('Claude Code');
    expect(rows[0].querySelector('.state.working')!.textContent).to.equal('Working');
    expect(rows[0].textContent).to.contain('main checkout');
    expect(rows[0].textContent).to.contain('3 changed files');
    expect(rows[0].textContent).to.contain('running 2m');
    expect(rows[1].querySelector('.state.waiting')!.textContent).to.equal('Waiting for input');
    expect(rows[1].textContent).to.contain('/wt/feature');
    expect(rows[1].querySelector('.branch')!.textContent).to.equal('feature');
    expect(rows[1].textContent).to.contain('1 changed file');
    expect(rows[1].textContent).to.contain('running 2h 05m');
    expect($(el, '.summary')!.textContent).to.contain('2 running');
    expect((invokeCalls[0].args as { path: string }).path).to.equal(REPO);
  });

  it('explains unknown turn state and detached HEAD', async () => {
    sessionsResponse = [session(1, { branch: null, changedFiles: null })];
    const el = await render();
    const state = $(el, '.state.running')!;
    expect(state.title).to.contain('Claude Code checkpoints');
    expect($(el, '.where')!.textContent).to.contain('detached HEAD');
    expect($(el, '.meta')!.textContent).to.contain('changes unknown');
  });

  it('shows an empty state naming the agents it looks for', async () => {
    const el = await render();
    expect($(el, '.empty-state')!.textContent).to.contain('No coding agents are running');
    expect($(el, '.empty-state')!.textContent).to.contain('Codex CLI');
  });

  it('shows a load error with retry', async () => {
    sessionsResponse = new Error('process table unavailable');
    const el = await render();
    expect($(el, '.error-state')!.textContent).to.contain('process table unavailable');

    sessionsResponse = [session(5)];
    $(el, '.retry-btn')!.click();
    await waitUntil(() => $$(el, '.session').length === 1, 'retry did not load sessions');
  });

  it('keeps an agent that exited as Ended until cleared', async () => {
    sessionsResponse = [session(10), session(11, { agent: 'Aider' })];
    const el = await render();
    expect($$(el, '.session')).to.have.length(2);

    sessionsResponse = [session(11, { agent: 'Aider' })];
    await el.refresh();
    await el.updateComplete;

    const ended = $$(el, '.session.ended');
    expect(ended).to.have.length(1);
    expect(ended[0].textContent).to.contain('Claude Code');
    expect(ended[0].textContent).to.contain('Ended');
    expect($(el, '.summary')!.textContent).to.contain('1 running · 1 ended');

    $(el, '.clear-ended-btn')!.click();
    await el.updateComplete;
    expect($$(el, '.session.ended')).to.have.length(0);
    expect($$(el, '.session')).to.have.length(1);
  });

  it('keeps the last list and flags a failed background refresh', async () => {
    sessionsResponse = [session(10)];
    const el = await render();
    sessionsResponse = new Error('temporarily unavailable');
    await el.refresh();
    await el.updateComplete;
    expect($$(el, '.session')).to.have.length(1);
    expect($(el, '.stale-error')!.textContent).to.contain('temporarily unavailable');
  });

  it('refreshes automatically while open and stops when closed', async () => {
    sessionsResponse = [session(10)];
    const el = await render();
    const countCalls = () => invokeCalls.filter((c) => c.command === 'list_agent_sessions').length;
    const initial = countCalls();
    await waitUntil(() => countCalls() > initial, 'no automatic refresh', { timeout: 5000 });

    el.close();
    await el.updateComplete;
    const afterClose = countCalls();
    await new Promise((r) => setTimeout(r, 3300));
    expect(countCalls()).to.equal(afterClose);
  });

  it('opens a terminal in the agent worktree and reports failures', async () => {
    sessionsResponse = [session(20, { worktreePath: '/wt/feature', isMainWorktree: false })];
    const el = await render();
    $(el, '.terminal-btn')!.click();
    await waitUntil(() => invokeCalls.some((c) => c.command === 'open_terminal'));
    expect(invokeCalls.find((c) => c.command === 'open_terminal')!.args).to.deep.equal({
      path: '/wt/feature',
    });

    terminalError = 'No terminal emulator found';
    $(el, '.terminal-btn')!.click();
    await waitUntil(() => uiStore.getState().toasts.some((t) => t.type === 'error'));
    expect(uiStore.getState().toasts.find((t) => t.type === 'error')!.message).to.contain(
      'No terminal emulator found',
    );
  });

  it('exposes the repo-scoped contract for the tab-close sweep', async () => {
    const el = await render();
    expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO);
    expect(el.operationInFlight).to.be.false;
    el.close();
    await el.updateComplete;
    expect(el.pinnedRepositoryPathIfOpen).to.be.null;
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatElapsed(45)).to.equal('45s');
    expect(formatElapsed(720)).to.equal('12m');
    expect(formatElapsed(7500)).to.equal('2h 05m');
    expect(formatElapsed(3 * 86400 + 4 * 3600)).to.equal('3d 4h');
    expect(formatElapsed(-1)).to.equal('');
  });
});
