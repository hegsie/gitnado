/**
 * Start Agent on a Task dialog tests (fixture-based). Only Tauri invoke is mocked.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let worktreeError: string | null = null;
let spawnError: string | null = null;
let shellProgram = '/bin/zsh';

const mockInvoke: MockInvoke = async (command, args) => {
  switch (command) {
    case 'add_worktree':
      if (worktreeError) throw new Error(worktreeError);
      return { path: (args as { worktreePath: string }).worktreePath, branch: 'agent/x' };
    case 'pty_spawn': {
      if (spawnError) throw new Error(spawnError);
      const o = (args as { options: { cwd: string } }).options;
      return { id: 1, cwd: o.cwd, program: shellProgram, pid: 1, cols: 80, rows: 24, startedAt: 0 };
    }
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
import '../gn-start-agent-dialog.ts';
import type { GnStartAgentDialog } from '../gn-start-agent-dialog.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { dialogs } from '../../../stores/dialog.store.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { OpenRepository } from '../../../stores/repository.store.ts';
import { getTerminalSessions, resetTerminalsForTests } from '../../../services/terminal.service.ts';

const REPO = '/home/u/code/app';

function calls(c: string) {
  return invokeCalls.filter((x) => x.command === c);
}

async function render(): Promise<GnStartAgentDialog> {
  const el = await fixture<GnStartAgentDialog>(
    html`<gn-start-agent-dialog .repositoryPath=${REPO} .defaultBaseRef=${'main'}></gn-start-agent-dialog>`,
  );
  el.open = true;
  await el.updateComplete;
  return el;
}

const $ = <T extends HTMLElement = HTMLElement>(el: GnStartAgentDialog, sel: string) =>
  el.shadowRoot!.querySelector<T>(sel)!;

async function type(el: GnStartAgentDialog, sel: string, value: string): Promise<void> {
  const input = $<HTMLInputElement>(el, sel);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
}

describe('gn-start-agent-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    worktreeError = null;
    spawnError = null;
    shellProgram = '/bin/zsh';
    uiStore.setState({ toasts: [] });
    dialogs.close('terminalPanel');
    repositoryStore.setState({
      openRepositories: [{ repository: { path: REPO } } as unknown as OpenRepository],
      activeIndex: 0,
    });
  });

  afterEach(() => {
    resetTerminalsForTests();
  });

  it('derives the branch and worktree from the task until edited', async () => {
    const el = await render();
    expect($<HTMLButtonElement>(el, '.start-btn').disabled).to.be.true;
    expect($<HTMLInputElement>(el, '.base-input').value).to.equal('main');

    await type(el, '.task-input', 'Fix the login bug');
    expect($<HTMLInputElement>(el, '.branch-input').value).to.equal('agent/fix-the-login-bug');
    expect($<HTMLInputElement>(el, '.path-input').value).to.equal('/home/u/code/app.worktrees/fix-the-login-bug');

    await type(el, '.issue-input', 'PROJ-7');
    expect($<HTMLInputElement>(el, '.branch-input').value).to.equal('agent/proj-7-fix-the-login-bug');

    await type(el, '.branch-input', 'agent/custom');
    await type(el, '.task-input', 'Something else entirely');
    expect($<HTMLInputElement>(el, '.branch-input').value).to.equal('agent/custom');
    expect($<HTMLInputElement>(el, '.path-input').value).to.equal('/home/u/code/app.worktrees/custom');
    expect($<HTMLButtonElement>(el, '.start-btn').disabled).to.be.false;
  });

  it('blocks invalid branch names with an inline message', async () => {
    const el = await render();
    await type(el, '.task-input', 'Do it');
    await type(el, '.branch-input', 'bad name');
    expect($(el, '.field-error').textContent).to.contain('cannot contain spaces');
    expect($<HTMLButtonElement>(el, '.start-btn').disabled).to.be.true;
  });

  it('creates the worktree, starts the agent in the terminal, and refreshes', async () => {
    const el = await render();
    const events: CustomEvent[] = [];
    el.addEventListener('worktrees-changed', (e) => events.push(e as CustomEvent));
    let closed = false;
    el.addEventListener('close', () => (closed = true));
    await type(el, '.task-input', 'Fix "login"; rm -rf $(whoami)');
    await type(el, '.issue-input', 'PROJ-7');

    $(el, '.start-btn').click();
    await waitUntil(() => closed, 'dialog did not close');

    expect(calls('add_worktree')[0].args).to.deep.include({
      path: REPO,
      newBranch: 'agent/proj-7-fix-login-rm-rf-whoami',
      commit: 'main',
    });
    const spawn = calls('pty_spawn')[0].args as { options: { cwd: string; env: Record<string, string> } };
    expect(spawn.options.cwd).to.equal('/home/u/code/app.worktrees/proj-7-fix-login-rm-rf-whoami');
    expect(spawn.options.env.GITNADO_TASK_PROMPT).to.equal('Issue: PROJ-7\n\nFix "login"; rm -rf $(whoami)');
    // The prompt is never typed into the shell, only the variable name.
    expect(calls('pty_write')[0].args).to.deep.equal({ id: 1, data: 'claude "$GITNADO_TASK_PROMPT"\r' });

    expect(events[0].detail).to.deep.equal({ repositoryPath: REPO });
    expect(dialogs.isOpen('terminalPanel')).to.be.true;
    expect(getTerminalSessions(REPO)).to.have.length(1);
    expect(getTerminalSessions(REPO)[0].label).to.equal('Claude Code · agent/proj-7-fix-login-rm-rf-whoami');
    expect(uiStore.getState().toasts.find((t) => t.type === 'success')!.message).to.contain('Claude Code started');
  });

  it('uses the right syntax for the user shell and agent', async () => {
    shellProgram = 'C:\\Windows\\System32\\cmd.exe';
    const el = await render();
    const select = $<HTMLSelectElement>(el, '.agent-select');
    select.value = 'gemini';
    select.dispatchEvent(new Event('change'));
    await type(el, '.task-input', 'Task');
    $(el, '.start-btn').click();
    await waitUntil(() => calls('pty_write').length > 0);
    expect((calls('pty_write')[0].args as { data: string }).data).to.equal('gemini -i "%GITNADO_TASK_PROMPT%"\r');
  });

  it('keeps the dialog open with the reason when the worktree cannot be created', async () => {
    worktreeError = "fatal: a branch named 'agent/x' already exists";
    const el = await render();
    await type(el, '.task-input', 'x');
    $(el, '.start-btn').click();
    await waitUntil(() => el.shadowRoot!.querySelector('.error'), 'no inline error');
    expect($(el, '.error').textContent).to.contain('already exists');
    expect(el.open).to.be.true;
    expect(calls('pty_spawn')).to.have.length(0);
    expect($<HTMLButtonElement>(el, '.start-btn').disabled).to.be.false;
  });

  it('reports a terminal that cannot start after the worktree exists', async () => {
    spawnError = 'Failed to start /bin/zsh';
    const el = await render();
    await type(el, '.task-input', 'x');
    $(el, '.start-btn').click();
    await waitUntil(() => uiStore.getState().toasts.some((t) => t.type === 'error'));
    const msg = uiStore.getState().toasts.find((t) => t.type === 'error')!.message;
    expect(msg).to.contain('was created');
    expect(msg).to.contain('terminal could not start');
    expect(calls('pty_write')).to.have.length(0);
  });

  it('exposes the repo-scoped contract for the tab-close sweep', async () => {
    const el = await render();
    expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO);
    expect(el.operationInFlight).to.be.false;
  });
});
