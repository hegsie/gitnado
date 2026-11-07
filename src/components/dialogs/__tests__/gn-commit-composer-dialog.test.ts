// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let responses: Record<string, unknown> = {};
let cbId = 0;
(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke; transformCallback: () => number } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: a });
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
import '../gn-commit-composer-dialog.ts';
import { defaultRecomposeBase, type GnCommitComposerDialog } from '../gn-commit-composer-dialog.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { resetRefOpLocks, isRefOpRunning } from '../../../utils/ref-lock.ts';

const REPO = '/repo';
const SOURCE = {
  mode: 'range', branch: 'feature', headOid: 'h'.repeat(40), baseOid: 'b'.repeat(40),
  commits: [
    { oid: '1'.repeat(40), summary: 'wip', files: ['a.ts', 'b.ts'] },
    { oid: '2'.repeat(40), summary: 'more wip', files: ['c.ts'] },
  ],
  files: [{ path: 'a.ts', status: 'added' }, { path: 'b.ts', status: 'added' }, { path: 'c.ts', status: 'modified' }],
};
const RECORD = { branch: 'feature', before: 'h'.repeat(40), after: 'n'.repeat(40), mode: 'range', createdAt: 1 };

function openRepo(upstream: string | null, branches: string[] = ['main', 'feature']): void {
  repositoryStore.setState({
    openRepositories: [{
      repository: { path: REPO, name: 'repo' },
      currentBranch: { name: 'feature', shorthand: 'feature', isHead: true, isRemote: false, upstream },
      branches: branches.map((name) => ({ name, shorthand: name, isRemote: false })),
    }],
    activeIndex: 0,
  } as never);
}

async function openComposer(): Promise<GnCommitComposerDialog> {
  const el = await fixture<GnCommitComposerDialog>(html`<gn-commit-composer-dialog .repositoryPath=${REPO}></gn-commit-composer-dialog>`);
  el.open = true;
  await waitUntil(() => calls.some((c) => c.command === 'get_recompose_source') && !(el as unknown as { loading: boolean }).loading, 'loaded');
  await el.updateComplete;
  return el;
}

const q = <T extends Element = HTMLElement>(el: GnCommitComposerDialog, sel: string) => el.shadowRoot!.querySelector<T>(sel)!;
const qa = (el: GnCommitComposerDialog, sel: string) => Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>(sel));
const toasts = () => uiStore.getState().toasts;

describe('gn-commit-composer-dialog', () => {
  beforeEach(() => {
    calls.length = 0;
    resetRefOpLocks();
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    responses = { get_recompose_source: SOURCE, is_ai_available: true };
    openRepo(null);
  });
  afterEach(() => resetRefOpLocks());

  it('defaults the base to the upstream, then main, then the parent commit', () => {
    openRepo('origin/feature');
    expect(defaultRecomposeBase(REPO)).to.equal('origin/feature');
    openRepo(null);
    expect(defaultRecomposeBase(REPO)).to.equal('main');
    openRepo(null, ['feature']);
    expect(defaultRecomposeBase(REPO)).to.equal('HEAD~1');
  });

  it('shows the commits today and a starting plan built from them', async () => {
    const el = await openComposer();
    expect(calls.find((c) => c.command === 'get_recompose_source')!.args).to.deep.equal({ path: REPO, base: 'main' });
    expect(qa(el, 'ol.before li').map((li) => li.textContent)).to.deep.equal(['wip', 'more wip']);
    expect(qa(el, '.group:not(.unassigned) .message').map((i) => (i as HTMLInputElement).value)).to.deep.equal(['wip', 'more wip']);
    expect(q(el, '.problem').textContent).to.equal('Ready to apply');
  });

  it('switches to uncommitted changes', async () => {
    const el = await openComposer();
    responses.get_recompose_source = { ...SOURCE, mode: 'worktree', commits: [] };
    calls.length = 0;
    const mode = q<HTMLSelectElement>(el, '.mode-select');
    mode.value = 'worktree';
    mode.dispatchEvent(new Event('change'));
    await waitUntil(() => calls.some((c) => c.command === 'get_recompose_source'), 'reloaded');
    expect(calls.find((c) => c.command === 'get_recompose_source')!.args).to.deep.equal({ path: REPO, base: null });
  });

  it('moving a file out blocks Apply until it is placed again', async () => {
    const el = await openComposer();
    const select = q<HTMLSelectElement>(el, '.group li[data-file="c.ts"] select.move');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(q(el, '.problem').textContent).to.equal('Commit 2 has no files');
    expect(q<HTMLButtonElement>(el, '[data-action="apply"]').disabled).to.be.true;
    expect(q(el, '.unassigned').textContent).to.contain('c.ts');
  });

  it('AI suggestions replace the plan, cleaned into a valid partition', async () => {
    responses.suggest_recompose = {
      shouldSplit: true, explanation: '',
      groups: [{ label: 'feat', suggestedMessage: 'feat: add a and c', files: ['a.ts', 'c.ts', 'ghost.ts'] }],
    };
    const el = await openComposer();
    await waitUntil(() => !q<HTMLButtonElement>(el, '[data-action="suggest"]').disabled, 'ai ready');
    q<HTMLButtonElement>(el, '[data-action="suggest"]').click();
    await waitUntil(() => qa(el, '.group:not(.unassigned) .message').some((i) => (i as HTMLInputElement).value === 'feat: add a and c'), 'suggested');
    expect(calls.find((c) => c.command === 'suggest_recompose')!.args).to.deep.equal({ repoPath: REPO, base: SOURCE.baseOid });
    expect(qa(el, '.group:not(.unassigned) .message').map((i) => (i as HTMLInputElement).value)).to.deep.equal(['feat: add a and c', 'chore: remaining changes']);
  });

  it('without AI the suggest button is disabled and says how to enable it', async () => {
    responses.is_ai_available = false;
    const el = await openComposer();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;
    const btn = q<HTMLButtonElement>(el, '[data-action="suggest"]');
    expect(btn.disabled).to.be.true;
    expect(btn.title).to.contain('Set up an AI provider');
  });

  it('a failed AI suggestion keeps the manual plan and says so', async () => {
    responses.suggest_recompose = new Error('model not loaded');
    const el = await openComposer();
    await waitUntil(() => !q<HTMLButtonElement>(el, '[data-action="suggest"]').disabled, 'ai ready');
    q<HTMLButtonElement>(el, '[data-action="suggest"]').click();
    await waitUntil(() => q(el, '.error'), 'error');
    expect(q(el, '.error').textContent).to.contain('model not loaded');
    expect(qa(el, '.group:not(.unassigned)')).to.have.length(2);
  });

  it('Apply sends the edited plan, announces it with Undo, and releases the lock', async () => {
    responses.apply_recompose = RECORD;
    const el = await openComposer();
    let applied = false;
    el.addEventListener('recompose-applied', () => { applied = true; });
    const msg = q<HTMLInputElement>(el, '.group[data-group="0"] .message');
    msg.value = 'feat: a and b';
    msg.dispatchEvent(new Event('input'));
    await el.updateComplete;
    q<HTMLButtonElement>(el, '[data-action="apply"]').click();
    await waitUntil(() => q(el, '.notice'), 'applied');
    expect(calls.find((c) => c.command === 'apply_recompose')!.args).to.deep.equal({
      path: REPO, base: SOURCE.baseOid,
      groups: [{ message: 'feat: a and b', files: ['a.ts', 'b.ts'] }, { message: 'more wip', files: ['c.ts'] }],
    });
    expect(applied).to.be.true;
    expect(toasts()[0]).to.include({ type: 'success', message: 'Recomposed feature into 2 commits' });
    expect(toasts()[0].action?.label).to.equal('Undo');
    expect(isRefOpRunning(REPO)).to.be.false;
  });

  it('Undo restores the branch and reloads', async () => {
    responses.apply_recompose = RECORD;
    responses.undo_recompose = RECORD;
    const el = await openComposer();
    q<HTMLButtonElement>(el, '[data-action="apply"]').click();
    await waitUntil(() => q(el, '[data-action="undo"]'), 'applied');
    calls.length = 0;
    q<HTMLButtonElement>(el, '[data-action="undo"]').click();
    await waitUntil(() => calls.some((c) => c.command === 'get_recompose_source'), 'reloaded');
    expect(calls.some((c) => c.command === 'undo_recompose')).to.be.true;
    expect(toasts().some((t) => t.message === 'Restored feature to before the recompose')).to.be.true;
  });

  it('reports load and apply failures', async () => {
    responses.get_recompose_source = new Error('main is not an ancestor of feature');
    const el = await openComposer();
    expect(q(el, '.error').textContent).to.equal('main is not an ancestor of feature');

    responses.get_recompose_source = SOURCE;
    responses.apply_recompose = new Error('feature moved while recomposing');
    q<HTMLButtonElement>(el, '[data-action="load"]').click();
    await waitUntil(() => qa(el, '.group').length > 0, 'reloaded');
    q<HTMLButtonElement>(el, '[data-action="apply"]').click();
    await waitUntil(() => q(el, '.error'), 'apply error');
    expect(q(el, '.error').textContent).to.equal('Recompose failed: feature moved while recomposing');
    expect(toasts().some((t) => t.type === 'error')).to.be.true;
  });

  it('shows the nothing-to-do state', async () => {
    responses.get_recompose_source = { ...SOURCE, mode: 'worktree', commits: [], files: [] };
    const el = await openComposer();
    expect(q(el, '.composer').textContent).to.contain('Nothing to recompose');
    expect(q<HTMLButtonElement>(el, '[data-action="apply"]').disabled).to.be.true;
  });
});
