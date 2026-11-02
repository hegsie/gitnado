/**
 * Embedded terminal panel tests (fixture-based). Only Tauri invoke is mocked.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let worktrees: unknown[] = [];
let spawnError: string | null = null;
let nextPtyId = 1;
let cbId = 0;

const mockInvoke: MockInvoke = (command, args) => {
  invokeCalls.push({ command, args });
  switch (command) {
    case 'pty_spawn': {
      if (spawnError) return Promise.reject(new Error(spawnError));
      const opts = (args as { options: { cwd: string } }).options;
      return Promise.resolve({
        id: nextPtyId++,
        cwd: opts.cwd,
        program: '/bin/zsh',
        pid: 99,
        cols: 80,
        rows: 24,
        startedAt: 0,
      });
    }
    case 'get_worktrees':
      return Promise.resolve(worktrees);
    case 'plugin:notification|is_permission_granted':
      return Promise.resolve(false);
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-terminal-panel.ts';
import type { GnTerminalPanel } from '../gn-terminal-panel.ts';
import {
  getTerminalSessions,
  handlePtyExit,
  resetTerminalsForTests,
} from '../../../services/terminal.service.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { OpenRepository } from '../../../stores/repository.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO = '/repo/main';

function calls(command: string) {
  return invokeCalls.filter((c) => c.command === command);
}

function openRepos(...paths: string[]): void {
  repositoryStore.setState({
    openRepositories: paths.map((path) => ({ repository: { path } }) as unknown as OpenRepository),
    activeIndex: paths.length ? 0 : -1,
  });
}

async function renderPanel(repoPath = REPO): Promise<GnTerminalPanel> {
  const el = await fixture<GnTerminalPanel>(html`
    <div style="height: 300px; width: 700px; display: flex; flex-direction: column;">
      <gn-terminal-panel .repositoryPath=${repoPath}></gn-terminal-panel>
    </div>
  `);
  const panel = el.querySelector('gn-terminal-panel')!;
  await panel.updateComplete;
  return panel;
}

function tabs(panel: GnTerminalPanel): HTMLElement[] {
  return Array.from(panel.shadowRoot!.querySelectorAll<HTMLElement>('.tab'));
}

describe('gn-terminal-panel', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    worktrees = [];
    spawnError = null;
    nextPtyId = 1;
    uiStore.setState({ toasts: [] });
    openRepos(REPO, '/repo/other');
  });

  afterEach(() => {
    resetTerminalsForTests();
    openRepos();
  });

  it('starts a first terminal in the repository root when opened', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1, 'no terminal tab');

    const spawn = calls('pty_spawn')[0].args as { options: { cwd: string } };
    expect(spawn.options.cwd).to.equal(REPO);
    expect(tabs(panel)[0].classList.contains('active')).to.be.true;
    expect(tabs(panel)[0].textContent).to.contain('main');
    // The xterm renders inside the panel.
    await waitUntil(() => panel.shadowRoot!.querySelector('.terminal-container .xterm'));
  });

  it('adds another tab with the + button and makes it active', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);

    panel.shadowRoot!.querySelector<HTMLButtonElement>('.new-terminal-btn')!.click();
    await waitUntil(() => tabs(panel).length === 2, 'second tab missing');
    await panel.updateComplete;

    expect(calls('pty_spawn')).to.have.length(2);
    expect(tabs(panel)[1].classList.contains('active')).to.be.true;
  });

  it('switches the visible terminal when a tab is clicked', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);
    await panel.newTerminal();
    await panel.updateComplete;

    tabs(panel)[0].click();
    await panel.updateComplete;
    expect(tabs(panel)[0].getAttribute('aria-selected')).to.equal('true');
    const [first] = getTerminalSessions(REPO);
    expect(panel.shadowRoot!.querySelector('.terminal-container')!.contains(first.host)).to.be.true;
  });

  it('closing a tab kills its shell and shows the empty state after the last one', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);

    panel.shadowRoot!.querySelector<HTMLButtonElement>('.tab-close')!.click();
    await waitUntil(() => tabs(panel).length === 0, 'tab not removed');
    await panel.updateComplete;

    expect(calls('pty_kill').map((c) => c.args)).to.deep.equal([{ id: 1 }]);
    const empty = panel.shadowRoot!.querySelector('.empty-state');
    expect(empty?.textContent).to.contain('No terminals open');
    // Closing the last tab must not respawn a shell on its own.
    expect(calls('pty_spawn')).to.have.length(1);

    empty!.querySelector('button')!.click();
    await waitUntil(() => tabs(panel).length === 1, 'New Terminal button did nothing');
  });

  it('marks an exited session on its tab', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);
    handlePtyExit({ id: 1, exitCode: 2 });
    await panel.updateComplete;
    const tab = tabs(panel)[0];
    expect(tab.classList.contains('exited')).to.be.true;
    expect(tab.title).to.contain('exited with code 2');
  });

  it('shows an error toast and a failed tab when the shell cannot start', async () => {
    spawnError = 'Failed to start /bin/zsh: No such file';
    const panel = await renderPanel();
    await waitUntil(() => uiStore.getState().toasts.some((t) => t.type === 'error'), 'no toast');

    const toast = uiStore.getState().toasts.find((t) => t.type === 'error')!;
    expect(toast.message).to.contain('Could not start terminal');
    expect(toast.message).to.contain('No such file');
    await panel.updateComplete;
    expect(tabs(panel)[0].classList.contains('failed')).to.be.true;
  });

  it('offers worktrees as the directory for new terminals', async () => {
    worktrees = [
      { path: REPO, branch: 'main', isMain: true, isBare: false, isPrunable: false, isLocked: false, headOid: null, lockReason: null },
      { path: '/wt/feature', branch: 'feature', isMain: false, isBare: false, isPrunable: false, isLocked: false, headOid: null, lockReason: null },
      { path: '/wt/stale', branch: 'stale', isMain: false, isBare: false, isPrunable: true, isLocked: false, headOid: null, lockReason: null },
    ];
    const panel = await renderPanel();
    await waitUntil(() => panel.shadowRoot!.querySelector('.cwd-select'), 'no worktree picker');

    const select = panel.shadowRoot!.querySelector<HTMLSelectElement>('.cwd-select')!;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).to.deep.equal([REPO, '/wt/feature']);

    select.value = '/wt/feature';
    select.dispatchEvent(new Event('change'));
    await panel.newTerminal();

    const last = calls('pty_spawn').at(-1)!.args as { options: { cwd: string } };
    expect(last.options.cwd).to.equal('/wt/feature');
  });

  it('hides the worktree picker when there is only one place to open a shell', async () => {
    worktrees = [
      { path: REPO, branch: 'main', isMain: true, isBare: false, isPrunable: false, isLocked: false, headOid: null, lockReason: null },
    ];
    const panel = await renderPanel();
    await waitUntil(() => calls('get_worktrees').length === 1);
    await panel.updateComplete;
    expect(panel.shadowRoot!.querySelector('.cwd-select')).to.be.null;
  });

  it('shows only the active repository terminals and keeps others running', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);

    panel.repositoryPath = '/repo/other';
    await waitUntil(() => calls('pty_spawn').length === 2, 'other repo got no terminal');
    await panel.updateComplete;
    expect(tabs(panel)).to.have.length(1);
    expect(getTerminalSessions(REPO)).to.have.length(1);
    expect(calls('pty_kill')).to.have.length(0);

    panel.repositoryPath = REPO;
    await panel.updateComplete;
    // Coming back reuses the existing shell rather than starting another.
    expect(calls('pty_spawn')).to.have.length(2);
    expect(tabs(panel)).to.have.length(1);
  });

  it('dispatches close from the hide button without killing shells', async () => {
    const panel = await renderPanel();
    await waitUntil(() => tabs(panel).length === 1);
    let closed = false;
    panel.addEventListener('close', () => (closed = true));
    panel.shadowRoot!.querySelector<HTMLButtonElement>('.close-panel-btn')!.click();
    expect(closed).to.be.true;
    expect(calls('pty_kill')).to.have.length(0);
  });
});
