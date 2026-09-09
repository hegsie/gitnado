import { expect } from '@open-wc/testing';

// Mock the Tauri IPC bridge before importing anything that reaches for it.
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const tauriInternals: { invoke: MockInvoke; transformCallback?: () => number } = {
  invoke: () => Promise.resolve(null),
};
(globalThis as unknown as { __TAURI_INTERNALS__: typeof tauriInternals }).__TAURI_INTERNALS__ =
  tauriInternals;

import { clearLogEntries, getLogEntries } from '../output-log.service.ts';
import {
  recordGitCommandEvent,
  startGitCommandLogging,
  stopGitCommandLogging,
} from '../git-output.service.ts';
import { collectUnhandledRejections } from '../../test-utils/unhandled-rejections.ts';

describe('git-output.service', () => {
  beforeEach(() => {
    clearLogEntries();
  });

  afterEach(() => {
    stopGitCommandLogging();
  });

  it('records a real backend invocation with its command line and output', () => {
    recordGitCommandEvent({
      command: 'git push --force-with-lease origin main',
      output: 'To github.com:o/r.git\n + abc1234...def5678 main -> main (forced update)',
      success: true,
      durationMs: 1820,
      repoPath: '/repo/a',
    });

    const entry = getLogEntries()[0];
    expect(entry.command).to.equal('git push --force-with-lease origin main');
    expect(entry.gitCommand).to.equal('git push --force-with-lease origin main');
    // It really ran — it must never be marked as a libgit2 equivalent.
    expect(entry.synthesized).to.be.false;
    expect(entry.success).to.be.true;
    expect(entry.durationMs).to.equal(1820);
    expect(entry.repoPath).to.equal('/repo/a');
    expect(entry.output).to.contain('forced update');
  });

  it('records a failing invocation with its error output', () => {
    recordGitCommandEvent({
      command: 'git rebase --continue',
      output: 'error: could not apply abc1234',
      success: false,
      durationMs: 12,
      repoPath: '/repo/a',
    });

    const entry = getLogEntries()[0];
    expect(entry.success).to.be.false;
    expect(entry.output).to.equal('error: could not apply abc1234');
  });

  it('tolerates an event with no repo path or output', () => {
    recordGitCommandEvent({
      command: 'git gc',
      output: '',
      success: true,
      durationMs: 5,
      repoPath: null,
    });

    const entry = getLogEntries()[0];
    expect(entry.repoPath).to.equal(undefined);
    expect(entry.output).to.equal('');
  });

  it('starting twice attaches only one listener, so nothing is logged twice', async () => {
    // Both calls resolve without a working event bridge; the point is that the
    // second is a no-op rather than a second subscription.
    await Promise.all([startGitCommandLogging(), startGitCommandLogging()]);
    await startGitCommandLogging();

    recordGitCommandEvent({
      command: 'git fetch origin',
      output: '',
      success: true,
      durationMs: 1,
    });
    expect(getLogEntries().length).to.equal(1);
  });
});

describe('git-output.service teardown without the event plugin internals', () => {
  beforeEach(() => {
    // The IPC layer is present and listen() SUCCEEDS (an event id resolves)…
    tauriInternals.transformCallback = () => 1;
    tauriInternals.invoke = () => Promise.resolve(1);
    // …but the event plugin's own internals — which the unlisten closure reads
    // before its IPC call — are not. That is every unit test that mocks
    // `invoke` and nothing else, and the plain-browser preview.
    delete (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  });

  afterEach(() => {
    stopGitCommandLogging();
    delete tauriInternals.transformCallback;
    tauriInternals.invoke = () => Promise.resolve(null);
  });

  it('stopping neither throws nor rejects when the unlisten closure cannot reach the bridge', async () => {
    await startGitCommandLogging();

    const rejections = await collectUnhandledRejections(() => {
      expect(() => stopGitCommandLogging()).to.not.throw();
    });
    expect(rejections, 'a rejection here is charged to whatever test runs next').to.deep.equal([]);
  });

  it('can start again after a stop that could not reach the bridge', async () => {
    await startGitCommandLogging();
    stopGitCommandLogging();

    const listens: string[] = [];
    tauriInternals.invoke = (command: string) => {
      listens.push(command);
      return Promise.resolve(2);
    };
    await startGitCommandLogging();
    expect(listens).to.deep.equal(['plugin:event|listen']);
  });
});
