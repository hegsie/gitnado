// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let responses: Record<string, unknown> = {};
let nextPtyId = 1;
let cbId = 0;
(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke; transformCallback: () => number } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: a });
    if (command === 'pty_spawn') {
      const opts = a.options as { cwd: string; cols: number; rows: number };
      return Promise.resolve({ id: nextPtyId++, cwd: opts.cwd, program: '/bin/bash', pid: 1, cols: opts.cols, rows: opts.rows, startedAt: 0 });
    }
    if (command in responses) {
      const v = responses[command];
      return typeof v === 'function' ? Promise.resolve((v as (a: Record<string, unknown>) => unknown)(a)) : Promise.resolve(v);
    }
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

import { expect } from '@open-wc/testing';
import {
  feedSignature,
  findAgentTerminal,
  formatFeedback,
  hunkRange,
  loadFeed,
  MAX_FEED_FILES,
  sendFeedback,
  unstagedEntries,
} from '../change-feed.service.ts';
import { createTerminalSession, handlePtyExit, resetTerminalsForTests } from '../terminal.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import type { IndexedDiffHunk, StatusEntry } from '../../types/git.types.ts';

const entry = (path: string, status: StatusEntry['status'], isStaged = false): StatusEntry => ({ path, status, isStaged, isConflicted: false });
const hunk = (index: number, newStart: number, newLines: number): IndexedDiffHunk => ({
  index, oldStart: newStart, oldLines: newLines, newStart, newLines, header: '', isStaged: false,
  lines: [{ lineType: 'addition', content: 'x\n' }] as IndexedDiffHunk['lines'],
});

describe('change feed service', () => {
  beforeEach(() => {
    calls.length = 0;
    responses = {};
    repositoryStore.setState({ openRepositories: [{ repository: { path: '/repo', name: 'repo' } }], activeIndex: 0 } as never);
  });
  afterEach(() => resetTerminalsForTests());

  it('keeps only unstaged, non-ignored, non-conflicted changes and fingerprints them order-independently', () => {
    const entries = [entry('b.ts', 'modified'), entry('a.ts', 'modified', true), entry('c.ts', 'untracked'), entry('d.log', 'ignored')];
    expect(unstagedEntries(entries).map((e) => e.path)).to.deep.equal(['b.ts', 'c.ts']);
    expect(feedSignature(entries)).to.equal(feedSignature([...entries].reverse()));
    expect(feedSignature(entries)).to.not.equal(feedSignature([entry('b.ts', 'modified')]));
    expect(feedSignature([])).to.equal('');
  });

  it('loads hunks per tracked file, treats untracked files as whole files, and reports read failures', async () => {
    responses.get_file_hunks = (a: Record<string, unknown>) => {
      if (a.filePath === 'bad.ts') throw 'boom';
      return { filePath: a.filePath, hunks: [hunk(0, 3, 2)], totalAdditions: 1, totalDeletions: 0 };
    };
    const feed = await loadFeed('/wt', [entry('z.ts', 'modified'), entry('new.md', 'untracked'), entry('bad.ts', 'modified'), entry('gone.ts', 'deleted')]);
    expect(feed.map((f) => [f.path, f.isNew, f.isDeleted, f.hunks.length])).to.deep.equal([
      ['bad.ts', false, false, 0], ['gone.ts', false, true, 1], ['new.md', true, false, 0], ['z.ts', false, false, 1],
    ]);
    expect(feed[0].hunksError).to.equal('boom');
    const hunkCalls = calls.filter((c) => c.command === 'get_file_hunks');
    expect(hunkCalls.every((c) => c.args.path === '/wt' && c.args.staged === false)).to.be.true;
    expect(hunkCalls.some((c) => c.args.filePath === 'new.md')).to.be.false;
  });

  it('does not load hunks beyond the file cap', async () => {
    responses.get_file_hunks = { hunks: [] };
    const many = Array.from({ length: MAX_FEED_FILES + 2 }, (_, i) => entry(`f${String(i).padStart(3, '0')}.ts`, 'modified'));
    const feed = await loadFeed('/wt', many);
    expect(calls.filter((c) => c.command === 'get_file_hunks')).to.have.length(MAX_FEED_FILES);
    expect(feed[MAX_FEED_FILES].hunksError).to.contain(`first ${MAX_FEED_FILES} files`);
  });

  it('describes hunk ranges and formats one-line feedback', () => {
    expect(hunkRange(hunk(0, 12, 7))).to.equal('lines 12-18');
    expect(hunkRange(hunk(0, 4, 1))).to.equal('line 4');
    expect(hunkRange(hunk(0, 9, 0))).to.equal('after line 9');
    expect(formatFeedback('src/a.ts', hunk(0, 12, 7), '  Use the helper.\n\nAnd add a test. ')).to.equal(
      'Feedback on src/a.ts (lines 12-18): Use the helper. And add a test.',
    );
    expect(formatFeedback('new.md', null, 'Delete this')).to.equal('Feedback on new.md: Delete this');
  });

  it('types feedback into the running terminal in that worktree and submits it', async () => {
    await createTerminalSession({ repoPath: '/repo', cwd: '/wt/other' });
    const agent = await createTerminalSession({ repoPath: '/repo', cwd: '/wt/agent/', label: 'claude' });
    expect(findAgentTerminal('/wt/agent')?.key).to.equal(agent.key);

    const result = await sendFeedback('/wt/agent', 'Feedback on a.ts: rename it');
    expect(result).to.deep.equal({ via: 'terminal', label: 'claude' });
    const write = calls.find((c) => c.command === 'pty_write')!;
    expect(write.args).to.deep.equal({ id: agent.ptyId, data: 'Feedback on a.ts: rename it\r' });
  });

  it('falls back to the clipboard when no agent terminal is running there', async () => {
    const session = await createTerminalSession({ repoPath: '/repo', cwd: '/wt/agent' });
    handlePtyExit({ id: session.ptyId!, exitCode: 0 });
    expect(findAgentTerminal('/wt/agent')).to.be.undefined;

    let copied = '';
    const original = navigator.clipboard.writeText;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => { copied = t; } });
    try {
      expect(await sendFeedback('/wt/agent', 'hello')).to.deep.equal({ via: 'clipboard' });
      expect(copied).to.equal('hello');
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('denied'); } });
      expect(await sendFeedback('/wt/agent', 'hello')).to.deep.equal({ via: 'failed' });
    } finally {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: original });
    }
    expect(calls.some((c) => c.command === 'pty_write')).to.be.false;
  });
});
