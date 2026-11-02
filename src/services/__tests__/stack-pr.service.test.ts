// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect } from '@open-wc/testing';
import type { Branch, Stack } from '../../types/git.types.ts';
import type { PullRequestProviderTarget } from '../pull-request.service.ts';
import { planStackPullRequests, summarizeStackSync, syncStackPullRequests } from '../stack-pr.service.ts';
import { STACK_SECTION_START } from '../../utils/stack-pr-table.ts';

const GITHUB: PullRequestProviderTarget = {
  provider: 'github', providerName: 'GitHub', itemNoun: 'pull request', itemNounPlural: 'pull requests',
  itemNounTitle: 'Pull Requests', repoLabel: 'octo/gitnado',
  github: { owner: 'octo', repo: 'gitnado' } as PullRequestProviderTarget['github'],
};
const GITLAB: PullRequestProviderTarget = {
  provider: 'gitlab', providerName: 'GitLab', itemNoun: 'merge request', itemNounPlural: 'merge requests',
  itemNounTitle: 'Merge Requests', repoLabel: 'octo/gitnado',
  gitlab: { instanceUrl: 'https://gitlab.com', projectPath: 'octo/gitnado' } as PullRequestProviderTarget['gitlab'],
};

const entry = (name: string, parent: string, depth: number, parentMissing = false) => ({
  name, parent, depth, ahead: 1, behind: 0, isHead: false, parentMissing,
});
// main <- feat-a <- feat-b <- feat-c
const STACK: Stack = {
  base: 'main',
  branches: [entry('feat-a', 'main', 1), entry('feat-b', 'feat-a', 2), entry('feat-c', 'feat-b', 3)],
};
const branch = (name: string, upstream: string | null = `origin/${name}`) =>
  ({ name, shorthand: name, isHead: false, isRemote: false, upstream, targetOid: `${name}-oid` }) as unknown as Branch;
const BRANCHES = new Map([branch('feat-a'), branch('feat-b'), branch('feat-c')].map((b) => [b.name, b]));

const ghPr = (number: number, head: string, base: string) => ({
  number, title: `PR ${number}`, state: 'open', user: { login: 'me' }, createdAt: '', updatedAt: '',
  headRef: head, baseRef: base, draft: false, mergeable: null, htmlUrl: `https://gh/pr/${number}`,
});

describe('stack pull requests', () => {
  beforeEach(() => { calls.length = 0; });

  it('plans create / retarget / refresh per level and skips unpushed branches and what sits on them', async () => {
    mockInvoke = async (command) => command === 'list_pull_requests'
      ? [ghPr(11, 'feat-a', 'main'), ghPr(12, 'feat-b', 'main')]
      : null;
    const branches = new Map(BRANCHES);
    const plan = await planStackPullRequests(STACK, branches, GITHUB, 'tok');
    expect(plan.data!.map((s) => [s.branch, s.action])).to.deep.equal([
      ['feat-a', 'refresh'], ['feat-b', 'retarget'], ['feat-c', 'create'],
    ]);

    branches.set('feat-b', branch('feat-b', null));
    const skipped = await planStackPullRequests(STACK, branches, GITHUB, 'tok');
    expect(skipped.data!.map((s) => [s.branch, s.action, s.reason])).to.deep.equal([
      ['feat-a', 'refresh', undefined],
      ['feat-b', 'skip', 'it has not been pushed yet'],
      ['feat-c', 'skip', 'feat-b below it has no pull request'],
    ]);
  });

  it('skips a branch whose parent is gone and reports a listing failure', async () => {
    mockInvoke = async () => [];
    const orphan: Stack = { base: 'gone', branches: [entry('feat-a', 'gone', 1, true)] };
    const plan = await planStackPullRequests(orphan, BRANCHES, GITHUB, 'tok');
    expect(plan.data![0]).to.include({ action: 'skip', reason: 'its parent gone no longer exists' });

    mockInvoke = async () => { throw 'rate limited'; };
    const failed = await planStackPullRequests(STACK, BRANCHES, GITHUB, 'tok');
    expect(failed.success).to.be.false;
  });

  it('creates missing PRs bottom-up, retargets, and writes the full stack table into every PR', async () => {
    let next = 13;
    const bodies = new Map<number, string>([[11, 'Intro from the author'], [12, '']]);
    mockInvoke = async (command, raw) => {
      const args = (raw ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (command) {
        case 'list_pull_requests': return [ghPr(11, 'feat-a', 'main'), ghPr(12, 'feat-b', 'main')];
        case 'get_commit': return { summary: `tip of ${args.oid}` };
        case 'create_pull_request': { const n = next++; bodies.set(n, args.input.body); return ghPr(n, args.input.head, args.input.base); }
        case 'get_pull_request': return { body: bodies.get(args.number) ?? null };
        case 'update_pull_request': bodies.set(args.number, args.input.body); return null;
        default: return null;
      }
    };
    const plan = (await planStackPullRequests(STACK, BRANCHES, GITHUB, 'tok')).data!;
    const outcomes = await syncStackPullRequests('/repo', STACK, BRANCHES, plan, GITHUB, 'tok');

    expect(outcomes.map((o) => [o.branch, o.action, o.ok, o.number])).to.deep.equal([
      ['feat-a', 'refresh', true, 11], ['feat-b', 'retarget', true, 12], ['feat-c', 'create', true, 13],
    ]);
    const create = calls.find((c) => c.command === 'create_pull_request')!;
    expect(create.args.input).to.deep.include({ head: 'feat-c', base: 'feat-b', title: 'tip of feat-c-oid' });

    const updates = calls.filter((c) => c.command === 'update_pull_request');
    expect(updates.map((u) => [u.args.number, (u.args.input as { base?: string }).base])).to.deep.equal([
      [11, undefined], [12, 'feat-a'], [13, undefined],
    ]);
    // Every PR links all three, marks itself, and keeps the author's text.
    for (const [n, self] of [[11, 'feat-a'], [12, 'feat-b'], [13, 'feat-c']] as const) {
      const body = bodies.get(n)!;
      expect(body).to.contain(STACK_SECTION_START);
      expect(body).to.contain('[#11](https://gh/pr/11) `feat-a`');
      expect(body).to.contain('[#13](https://gh/pr/13) `feat-c`');
      expect(body).to.contain(`\`${self}\` ← this one`);
    }
    expect(bodies.get(11)!.startsWith('Intro from the author\n\n')).to.be.true;
    expect(bodies.get(11)!.split(STACK_SECTION_START)).to.have.length(2);
  });

  it('reports per-branch failures without stopping the rest', async () => {
    mockInvoke = async (command, raw) => {
      const args = (raw ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (command) {
        case 'list_pull_requests': return [ghPr(11, 'feat-a', 'main')];
        case 'create_pull_request':
          if (args.input.head === 'feat-b') throw 'head branch not found';
          return ghPr(20, args.input.head, args.input.base);
        case 'get_pull_request': return { body: '' };
        default: return null;
      }
    };
    const plan = (await planStackPullRequests(STACK, BRANCHES, GITHUB, 'tok')).data!;
    const outcomes = await syncStackPullRequests('/repo', STACK, BRANCHES, plan, GITHUB, 'tok');
    expect(outcomes.map((o) => [o.branch, o.ok])).to.deep.equal([['feat-a', true], ['feat-b', false], ['feat-c', true]]);
    expect(outcomes[1].error).to.contain('head branch not found');
    const summary = summarizeStackSync(outcomes, 'pull request');
    expect(summary.ok).to.be.false;
    expect(summary.message).to.contain('created 1 pull request');
    expect(summary.message).to.contain('failed: feat-b: head branch not found');
  });

  it('uses GitLab field names and the ! reference prefix', async () => {
    const mr = (iid: number, sourceBranch: string, targetBranch: string) => ({
      iid, title: `MR ${iid}`, sourceBranch, targetBranch, draft: false, webUrl: `https://gl/mr/${iid}`, author: { name: 'me' }, mergeStatus: 'can_be_merged',
    });
    const stack: Stack = { base: 'main', branches: [entry('feat-a', 'main', 1), entry('feat-b', 'feat-a', 2)] };
    let desc = '';
    mockInvoke = async (command, raw) => {
      const args = (raw ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (command) {
        case 'list_gitlab_merge_requests': return [mr(4, 'feat-a', 'main'), mr(5, 'feat-b', 'main')];
        case 'get_gitlab_merge_request': return { description: null };
        case 'update_gitlab_merge_request': if (args.iid === 5) desc = args.input.description; return null;
        default: return null;
      }
    };
    const plan = (await planStackPullRequests(stack, BRANCHES, GITLAB, 'tok')).data!;
    await syncStackPullRequests('/repo', stack, BRANCHES, plan, GITLAB, 'tok');
    const retarget = calls.find((c) => c.command === 'update_gitlab_merge_request' && c.args.iid === 5)!;
    expect(retarget.args.input).to.deep.include({ targetBranch: 'feat-a' });
    expect(desc).to.contain('[!4](https://gl/mr/4) `feat-a`');
  });

  it('summarises a clean sync', () => {
    const s = summarizeStackSync([
      { branch: 'a', action: 'create', ok: true },
      { branch: 'b', action: 'retarget', ok: true },
      { branch: 'c', action: 'refresh', ok: true },
      { branch: 'd', action: 'skip', ok: true, error: 'it has not been pushed yet' },
    ], 'merge request');
    expect(s).to.deep.equal({
      ok: true,
      message: 'Stack merge requests: created 1 merge request, retargeted 1 merge request, updated 1 merge request, skipped d (it has not been pushed yet)',
    });
  });
});
