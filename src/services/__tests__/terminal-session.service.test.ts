import { expect, waitUntil } from '@open-wc/testing';

// Mock the Tauri IPC bridge before importing anything that reaches for it.
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let spawnResult: unknown = null;
let spawnError: string | null = null;
let nextPtyId = 1;
let cbId = 0;

const tauriInternals: { invoke: MockInvoke; transformCallback: () => number } = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    if (command === 'pty_spawn') {
      if (spawnError) return Promise.reject(new Error(spawnError));
      const opts = (args as { options: { cwd: string; cols: number; rows: number } }).options;
      return Promise.resolve(
        spawnResult ?? {
          id: nextPtyId++,
          cwd: opts.cwd,
          program: '/bin/bash',
          pid: 1234,
          cols: opts.cols,
          rows: opts.rows,
          startedAt: 0,
        },
      );
    }
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};
(globalThis as unknown as { __TAURI_INTERNALS__: typeof tauriInternals }).__TAURI_INTERNALS__ =
  tauriInternals;

import {
  closeTerminalSession,
  createTerminalSession,
  getTerminalSessions,
  handlePtyExit,
  handlePtyOutput,
  resetTerminalsForTests,
  subscribeTerminals,
  attachTerminalSession,
} from '../terminal.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import type { OpenRepository } from '../../stores/repository.store.ts';

function openRepos(...paths: string[]): void {
  repositoryStore.setState({
    openRepositories: paths.map(
      (path) => ({ repository: { path } }) as unknown as OpenRepository,
    ),
    activeIndex: paths.length > 0 ? 0 : -1,
  });
}

function calls(command: string) {
  return invokeCalls.filter((c) => c.command === command);
}

/** Text currently in the terminal's active buffer. */
function bufferText(session: { term: { buffer: { active: { length: number; getLine: (i: number) => { translateToString: (t?: boolean) => string } | undefined } } } }): string {
  const buf = session.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

/** xterm parses writes asynchronously. */
async function flushWrites(session: { term: { write: (d: string, cb?: () => void) => void } }): Promise<void> {
  await new Promise<void>((r) => session.term.write('', r));
}

describe('terminal.service', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    spawnResult = null;
    spawnError = null;
    nextPtyId = 1;
    openRepos('/repo/a', '/repo/b');
  });

  afterEach(() => {
    resetTerminalsForTests();
    openRepos();
  });

  it('spawns a PTY in the repository root with camelCase options', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });

    const [spawn] = calls('pty_spawn');
    const opts = (spawn.args as { options: Record<string, unknown> }).options;
    expect(opts.cwd).to.equal('/repo/a');
    expect(opts.cols).to.be.a('number');
    expect(opts.rows).to.be.a('number');
    expect(session.status).to.equal('running');
    expect(session.ptyId).to.equal(1);
    expect(session.program).to.equal('/bin/bash');
    expect(session.label).to.equal('a');
  });

  it('spawns in a chosen worktree and numbers labels per repository', async () => {
    await createTerminalSession({ repoPath: '/repo/a' });
    const second = await createTerminalSession({ repoPath: '/repo/a', cwd: '/wt/feature' });
    expect((calls('pty_spawn')[1].args as { options: { cwd: string } }).options.cwd).to.equal(
      '/wt/feature',
    );
    expect(second.label).to.equal('feature (2)');
    expect(getTerminalSessions('/repo/a')).to.have.length(2);
    expect(getTerminalSessions('/repo/b')).to.have.length(0);
  });

  it('passes an explicit command through to the backend', async () => {
    await createTerminalSession({ repoPath: '/repo/a', command: ['claude', '--help'] });
    const opts = (calls('pty_spawn')[0].args as { options: { command: string[] } }).options;
    expect(opts.command).to.deep.equal(['claude', '--help']);
  });

  it('marks a session failed and shows the reason when spawn fails', async () => {
    spawnError = 'Invalid path: /gone';
    const session = await createTerminalSession({ repoPath: '/repo/a', cwd: '/gone' });
    expect(session.status).to.equal('failed');
    expect(session.error).to.contain('Invalid path');
    attachTerminalSession(session, document.body.appendChild(document.createElement('div')));
    await flushWrites(session);
    expect(bufferText(session)).to.contain('Invalid path');
  });

  it('writes backend output into the matching terminal only', async () => {
    const a = await createTerminalSession({ repoPath: '/repo/a' });
    const b = await createTerminalSession({ repoPath: '/repo/b' });
    const host = document.body.appendChild(document.createElement('div'));
    attachTerminalSession(a, host);

    handlePtyOutput({ id: a.ptyId!, data: 'hello from a' });
    await flushWrites(a);
    await flushWrites(b);
    expect(bufferText(a)).to.contain('hello from a');
    expect(bufferText(b)).to.not.contain('hello from a');
  });

  it('replays output and exit that arrive before spawn resolves', async () => {
    // The backend can start streaming before the IPC reply carrying the id.
    handlePtyOutput({ id: 1, data: 'early prompt$ ' });
    handlePtyExit({ id: 1, exitCode: 0 });
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    await flushWrites(session);
    expect(bufferText(session)).to.contain('early prompt$');
    expect(session.status).to.equal('exited');
    expect(session.exitCode).to.equal(0);
  });

  it('marks a session exited, prints the exit code, and notifies listeners', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    let notified = 0;
    const unsubscribe = subscribeTerminals(() => notified++);
    handlePtyExit({ id: session.ptyId!, exitCode: 130 });
    await flushWrites(session);
    unsubscribe();

    expect(session.status).to.equal('exited');
    expect(bufferText(session)).to.contain('exited with code 130');
    expect(notified).to.be.greaterThan(0);
  });

  it('sends typed input to the PTY while running, and not after exit', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    session.term.input('ls\r');
    expect(calls('pty_write').map((c) => c.args)).to.deep.equal([
      { id: session.ptyId, data: 'ls\r' },
    ]);

    handlePtyExit({ id: session.ptyId!, exitCode: 0 });
    session.term.input('x');
    expect(calls('pty_write')).to.have.length(1);
  });

  it('kills a running session when it is closed', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    await closeTerminalSession(session.key);
    expect(calls('pty_kill').map((c) => c.args)).to.deep.equal([{ id: session.ptyId }]);
    expect(getTerminalSessions('/repo/a')).to.have.length(0);
  });

  it('does not kill an already-exited session when closing it', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    handlePtyExit({ id: session.ptyId!, exitCode: 0 });
    await closeTerminalSession(session.key);
    expect(calls('pty_kill')).to.have.length(0);
  });

  it('terminates the sessions of a repository tab when that tab closes', async () => {
    const a = await createTerminalSession({ repoPath: '/repo/a' });
    await createTerminalSession({ repoPath: '/repo/b' });

    openRepos('/repo/b');
    await waitUntil(() => calls('pty_kill').length === 1, 'session of closed tab not killed');

    expect(calls('pty_kill')[0].args).to.deep.equal({ id: a.ptyId });
    expect(getTerminalSessions('/repo/a')).to.have.length(0);
    expect(getTerminalSessions('/repo/b')).to.have.length(1);
  });

  it('resizes the PTY to the fitted terminal size when attached', async () => {
    const session = await createTerminalSession({ repoPath: '/repo/a' });
    const host = document.body.appendChild(document.createElement('div'));
    host.style.width = '600px';
    host.style.height = '300px';
    attachTerminalSession(session, host);
    const resizes = calls('pty_resize');
    expect(resizes.length).to.be.greaterThan(0);
    const last = resizes.at(-1)!.args as { id: number; cols: number; rows: number };
    expect(last.id).to.equal(session.ptyId);
    expect(last.cols).to.equal(session.term.cols);
    expect(last.rows).to.equal(session.term.rows);
    host.remove();
  });
});
