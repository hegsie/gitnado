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
      return Promise.resolve({ id: nextPtyId++, cwd: opts.cwd, program: 'claude', pid: 1, cols: opts.cols, rows: opts.rows, startedAt: 0 });
    }
    if (command in responses) {
      const v = responses[command];
      if (v instanceof Error) return Promise.reject(v.message);
      return Promise.resolve(typeof v === 'function' ? (v as (a: Record<string, unknown>) => unknown)(a) : v);
    }
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-change-feed-dialog.ts';
import type { GnChangeFeedDialog } from '../gn-change-feed-dialog.ts';
import { createTerminalSession, resetTerminalsForTests } from '../../../services/terminal.service.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO = '/repo';
const WT = '/repo-worktrees/agent-fix';
const WORKTREES = [
  { path: REPO, headOid: 'a', branch: 'main', isMain: true, isLocked: false, lockReason: null, isBare: false, isPrunable: false },
  { path: WT, headOid: 'b', branch: 'agent/fix', isMain: false, isLocked: false, lockReason: null, isBare: false, isPrunable: false },
];
const HUNK = {
  index: 0, oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, header: '@@', isStaged: false,
  lines: [{ lineType: 'deletion', content: 'old\n' }, { lineType: 'addition', content: 'new\n' }],
};
let status: unknown[] = [];

function defaults(): void {
  status = [
    { path: 'src/app.ts', status: 'modified', isStaged: false, isConflicted: false },
    { path: 'notes.md', status: 'untracked', isStaged: false, isConflicted: false },
  ];
  responses = {
    get_worktrees: WORKTREES,
    get_status: () => status,
    get_file_hunks: { filePath: 'src/app.ts', hunks: [HUNK], totalAdditions: 1, totalDeletions: 1 },
    'plugin:dialog|message': 'Ok',
  };
}

async function openFeed(): Promise<GnChangeFeedDialog> {
  const el = await fixture<GnChangeFeedDialog>(html`<gn-change-feed-dialog .repositoryPath=${REPO}></gn-change-feed-dialog>`);
  const before = calls.filter((c) => c.command === 'get_status').length;
  el.open = true;
  // The first load is done once a status read has come back and loading ended.
  await waitUntil(
    () => calls.filter((c) => c.command === 'get_status').length > before && !(el as unknown as { loading: boolean }).loading,
    'feed loaded',
  );
  await el.updateComplete;
  return el;
}

const q = (el: GnChangeFeedDialog, sel: string) => el.shadowRoot!.querySelector(sel) as HTMLElement;
const hunkButton = (el: GnChangeFeedDialog, file: string, hunk: string, action: string) =>
  q(el, `.file[data-file="${file}"] .hunk[data-hunk="${hunk}"] [data-action="${action}"]`) as HTMLButtonElement;
const toasts = () => uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

describe('gn-change-feed-dialog', () => {
  beforeEach(() => {
    calls.length = 0;
    defaults();
    uiStore.setState({ toasts: [] });
    repositoryStore.setState({ openRepositories: [{ repository: { path: REPO, name: 'repo' } }], activeIndex: 0 } as never);
  });
  afterEach(() => {
    resetTerminalsForTests();
    document.querySelectorAll('gn-change-feed-dialog').forEach((d) => { (d as GnChangeFeedDialog).open = false; });
  });

  it('opens on the worktree an agent is running in and lists its changes hunk by hunk', async () => {
    await createTerminalSession({ repoPath: REPO, cwd: WT, label: 'claude' });
    const el = await openFeed();
    expect((q(el, '.worktree-select') as HTMLSelectElement).value).to.equal(WT);
    expect(q(el, '.agent').textContent).to.contain('claude');
    expect(calls.find((c) => c.command === 'get_status')!.args).to.deep.equal({ path: WT });
    expect(q(el, '.file[data-file="src/app.ts"] .hunk[data-hunk="0"] .range').textContent).to.equal('line 3');
    expect(q(el, '.file[data-file="src/app.ts"] pre').textContent).to.contain('+new');
    expect(q(el, '.file[data-file="notes.md"] .file-tag').textContent).to.equal('new file');
  });

  it('defaults to a linked worktree, shows the empty state, and says no agent is running', async () => {
    status = [];
    const el = await openFeed();
    expect((q(el, '.worktree-select') as HTMLSelectElement).value).to.equal(WT);
    expect(q(el, '.empty').textContent).to.contain('No unaccepted changes');
    expect(q(el, '.agent').textContent).to.contain('No agent terminal here');
  });

  it('Accept stages the hunk, confirms inline, reloads and notifies the app', async () => {
    const el = await openFeed();
    let applied: Record<string, unknown> | null = null;
    el.addEventListener('change-feed-applied', (e) => { applied = (e as CustomEvent).detail; });
    calls.length = 0;
    hunkButton(el, 'src/app.ts', '0', 'accept').click();
    await waitUntil(() => q(el, '.notice'), 'notice');
    expect(calls.find((c) => c.command === 'stage_hunk_by_index')!.args).to.deep.equal({ path: WT, filePath: 'src/app.ts', hunkIndex: 0 });
    expect(q(el, '.notice').textContent).to.equal('Accepted src/app.ts (line 3)');
    expect(applied).to.deep.equal({ repositoryPath: REPO, worktreePath: WT });
    await waitUntil(() => calls.some((c) => c.command === 'get_status'), 'reloaded');
  });

  it('Revert asks first, then reverts only that hunk; a declined confirm changes nothing', async () => {
    const el = await openFeed();
    responses['plugin:dialog|message'] = 'Cancel';
    hunkButton(el, 'src/app.ts', '0', 'revert').click();
    await waitUntil(() => calls.some((c) => c.command === 'plugin:dialog|message'), 'asked');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.command === 'discard_hunk_by_index')).to.be.false;

    responses['plugin:dialog|message'] = 'Ok';
    hunkButton(el, 'src/app.ts', '0', 'revert').click();
    await waitUntil(() => calls.some((c) => c.command === 'discard_hunk_by_index'), 'reverted');
    expect(calls.find((c) => c.command === 'discard_hunk_by_index')!.args).to.deep.equal({ path: WT, filePath: 'src/app.ts', hunkIndex: 0 });
  });

  it('a new file is accepted and reverted as a whole', async () => {
    const el = await openFeed();
    hunkButton(el, 'notes.md', 'file', 'accept').click();
    await waitUntil(() => calls.some((c) => c.command === 'stage_files'), 'staged');
    expect(calls.find((c) => c.command === 'stage_files')!.args).to.deep.equal({ path: WT, paths: ['notes.md'] });
    await waitUntil(() => !el.operationInFlight && !(el as unknown as { polling: boolean }).polling, 'accept finished');
    await el.updateComplete;
    hunkButton(el, 'notes.md', 'file', 'revert').click();
    await waitUntil(() => calls.some((c) => c.command === 'discard_changes'), 'discarded');
    expect(calls.find((c) => c.command === 'discard_changes')!.args).to.deep.equal({ path: WT, paths: ['notes.md'] });
  });

  it('a failed accept is shown inline and as a toast', async () => {
    responses.stage_hunk_by_index = new Error('patch does not apply');
    const el = await openFeed();
    hunkButton(el, 'src/app.ts', '0', 'accept').click();
    await waitUntil(() => q(el, '.error'), 'error');
    expect(q(el, '.error').textContent).to.equal('Could not accept the change: patch does not apply');
    expect(toasts()).to.include('error:Could not accept the change: patch does not apply');
  });

  it('Feedback types a one-line note into the agent terminal', async () => {
    const agent = await createTerminalSession({ repoPath: REPO, cwd: WT, label: 'claude' });
    const el = await openFeed();
    hunkButton(el, 'src/app.ts', '0', 'feedback').click();
    await el.updateComplete;
    const box = q(el, '.feedback textarea') as HTMLTextAreaElement;
    box.value = 'Keep the old name';
    box.dispatchEvent(new Event('input'));
    await el.updateComplete;
    (q(el, '[data-action="send-feedback"]') as HTMLButtonElement).click();
    await waitUntil(() => q(el, '.notice'), 'sent');
    expect(calls.find((c) => c.command === 'pty_write')!.args).to.deep.equal({
      id: agent.ptyId, data: 'Feedback on src/app.ts (line 3): Keep the old name\r',
    });
    expect(q(el, '.notice').textContent).to.equal('Feedback sent to claude');
    expect(q(el, '.feedback')).to.be.null;
  });

  it('picks up new changes while open and switches worktrees', async () => {
    status = [];
    const el = await openFeed();
    status = [{ path: 'src/app.ts', status: 'modified', isStaged: false, isConflicted: false }];
    await (el as unknown as { poll: (force: boolean) => Promise<void> }).poll(false);
    await el.updateComplete;
    expect(q(el, '.file[data-file="src/app.ts"]')).to.not.be.null;

    calls.length = 0;
    const select = q(el, '.worktree-select') as HTMLSelectElement;
    select.value = REPO;
    select.dispatchEvent(new Event('change'));
    await waitUntil(() => calls.some((c) => c.command === 'get_status'), 'status of the repository');
    expect(calls.find((c) => c.command === 'get_status')!.args).to.deep.equal({ path: REPO });
  });

  it('stops polling when closed and reports itself for the repo sweep', async () => {
    const el = await openFeed();
    expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO);
    el.open = false;
    await el.updateComplete;
    expect((el as unknown as { pollTimer: unknown }).pollTimer).to.be.null;
    expect(el.pinnedRepositoryPathIfOpen).to.be.null;
  });

  it('reports a status read failure and clears it once reads succeed again', async () => {
    const el = await openFeed();
    responses.get_status = new Error('not a git repository');
    await (el as unknown as { poll: (force: boolean) => Promise<void> }).poll(true);
    await el.updateComplete;
    expect(q(el, '.error').textContent).to.equal(`Could not read ${WT}: not a git repository`);
    responses.get_status = () => status;
    await (el as unknown as { poll: (force: boolean) => Promise<void> }).poll(true);
    await el.updateComplete;
    expect(q(el, '.error')).to.be.null;
  });
});
