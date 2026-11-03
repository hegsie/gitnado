import { expect } from '@open-wc/testing';
import type { RecomposeSource } from '../../services/git/merge-rebase.ts';
import { initialPlan, moveFile, planFromSuggestion, planProblem, unassignedFiles } from '../recompose-plan.ts';

const range: RecomposeSource = {
  mode: 'range', branch: 'main', headOid: 'h', baseOid: 'b',
  commits: [
    { oid: '1', summary: 'wip 1', files: ['a.ts', 'b.ts'] },
    { oid: '2', summary: 'wip 2', files: ['a.ts', 'c.ts'] },
    { oid: '3', summary: 'wip 3', files: ['flip.ts'] },
  ],
  files: [
    { path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'added' },
    { path: 'c.ts', status: 'added' }, { path: 'd.ts', status: 'modified' },
  ],
};
const strip = (gs: Array<{ message: string; files: string[] }>) => gs.map((g) => [g.message, g.files]);

describe('recompose plan', () => {
  it('starts from the original commits, each file in the last commit that touched it', () => {
    expect(strip(initialPlan(range))).to.deep.equal([
      ['wip 1', ['b.ts']],
      ['wip 2', ['a.ts', 'c.ts', 'd.ts']],
    ]);
  });

  it('starts uncommitted changes as one commit', () => {
    const wt: RecomposeSource = { ...range, mode: 'worktree', commits: [] };
    expect(strip(initialPlan(wt))).to.deep.equal([['', ['a.ts', 'b.ts', 'c.ts', 'd.ts']]]);
    expect(initialPlan({ ...wt, files: [] })).to.deep.equal([]);
  });

  it('cleans an AI suggestion into a valid partition', () => {
    const plan = planFromSuggestion(range, [
      { label: 'x', suggestedMessage: 'feat: a', files: ['a.ts', 'ghost.ts'] },
      { label: 'only dupes', suggestedMessage: 'feat: dup', files: ['a.ts'] },
      { label: 'docs', suggestedMessage: '', files: ['c.ts'] },
    ]);
    expect(strip(plan)).to.deep.equal([
      ['feat: a', ['a.ts']],
      ['docs', ['c.ts']],
      ['chore: remaining changes', ['b.ts', 'd.ts']],
    ]);
    expect(planProblem(range, plan)).to.be.null;
  });

  it('moves files between commits and out of them', () => {
    const plan = initialPlan(range);
    const moved = moveFile(plan, 'b.ts', plan[1].id);
    expect(strip(moved)).to.deep.equal([['wip 1', []], ['wip 2', ['a.ts', 'b.ts', 'c.ts', 'd.ts']]]);
    const out = moveFile(moved, 'a.ts', null);
    expect(unassignedFiles(range, out)).to.deep.equal(['a.ts']);
  });

  it('explains what blocks applying', () => {
    const plan = initialPlan(range);
    expect(planProblem(range, [])).to.equal('Add at least one commit');
    expect(planProblem(range, [{ ...plan[0], message: ' ' }, plan[1]])).to.equal('Commit 1 needs a message');
    expect(planProblem(range, moveFile(plan, 'b.ts', plan[1].id))).to.equal('Commit 1 has no files');
    expect(planProblem(range, [plan[1]])).to.equal('Put every changed file in a commit (1 left)');
    // Uncommitted mode may leave files out.
    expect(planProblem({ ...range, mode: 'worktree' }, [plan[1]])).to.be.null;
  });
});
