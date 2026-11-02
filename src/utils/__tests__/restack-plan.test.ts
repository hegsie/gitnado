import { expect } from '@open-wc/testing';
import type { RestackPlan, RestackStep } from '../../types/git.types.ts';
import { restackConflictMessage, restackSummaryLines, restackedCount } from '../restack-plan.ts';

const step = (branch: string, status: RestackStep['status'], extra: Partial<RestackStep> = {}): RestackStep => ({
  branch, onto: 'main', status, commits: 1, conflictFiles: [], conflictCommit: null, ...extra,
});
const plan = (steps: RestackStep[]): RestackPlan => ({
  base: 'main', steps, canApply: !steps.some((s) => s.status === 'conflict'), hasChanges: true,
});

describe('restack plan helpers', () => {
  it('summarises restacked and merged branches, skipping up-to-date ones', () => {
    const lines = restackSummaryLines(plan([
      step('a', 'merged'),
      step('b', 'restacked', { commits: 2 }),
      step('c', 'upToDate'),
      step('d', 'restacked', { onto: 'b' }),
    ]));
    expect(lines).to.deep.equal([
      '• a is already merged into main — skipped; branches above it move onto main',
      '• b → onto main (2 commits)',
      '• d → onto b (1 commit)',
    ]);
  });

  it('explains the first conflict, with the commit and the blocked branches', () => {
    const msg = restackConflictMessage(plan([
      step('a', 'conflict', { conflictFiles: ['x.ts', 'y.ts'], conflictCommit: 'edit x' }),
      step('b', 'blocked'),
    ]));
    expect(msg).to.equal(
      'Restacking would conflict: a at "edit x" in x.ts, y.ts (b above it would wait on it). '
      + 'Nothing was changed — rebase a onto main to resolve it, then restack again.',
    );
  });

  it('omits the commit when unknown and returns null for a clean plan', () => {
    expect(restackConflictMessage(plan([step('a', 'conflict', { conflictFiles: ['x'] })])))
      .to.contain('Restacking would conflict: a in x.');
    expect(restackConflictMessage(plan([step('a', 'restacked')]))).to.be.null;
  });

  it('counts restacked branches', () => {
    expect(restackedCount(plan([step('a', 'restacked'), step('b', 'merged'), step('c', 'restacked')]))).to.equal(2);
  });
});
