import { expect } from '@open-wc/testing';
import type { Stack } from '../../types/git.types.ts';
import { findStackBranch, stackChildren, stackStep } from '../stack-navigation.ts';

const entry = (name: string, parent: string, depth: number, extra: Partial<Stack['branches'][0]> = {}) => ({
  name, parent, depth, ahead: 1, behind: 0, isHead: false, parentMissing: false, ...extra,
});

// main -> a -> b, a -> b2, main -> c
const stacks: Stack[] = [{
  base: 'main',
  branches: [entry('a', 'main', 1), entry('b', 'a', 2), entry('b2', 'a', 2), entry('c', 'main', 1)],
}];

describe('stack navigation', () => {
  it('finds entries and children', () => {
    expect(findStackBranch(stacks, 'b')?.parent).to.equal('a');
    expect(findStackBranch(stacks, 'main')).to.be.undefined;
    expect(stackChildren(stacks, 'a')).to.deep.equal(['b', 'b2']);
    expect(stackChildren(stacks, 'main')).to.deep.equal(['a', 'c']);
  });

  it('moves down to the parent, including onto the base', () => {
    expect(stackStep(stacks, 'b', 'down')).to.deep.equal({ target: 'a' });
    expect(stackStep(stacks, 'a', 'down')).to.deep.equal({ target: 'main' });
  });

  it('moves up to the single child', () => {
    const single: Stack[] = [{ base: 'main', branches: [entry('a', 'main', 1), entry('b', 'a', 2)] }];
    expect(stackStep(single, 'a', 'up')).to.deep.equal({ target: 'b' });
  });

  it('moves up to the first of several children and says so', () => {
    const step = stackStep(stacks, 'a', 'up');
    expect(step.target).to.equal('b');
    expect('note' in step && step.note).to.contain('2 branches stacked on it');
  });

  it('explains why it cannot move', () => {
    expect(stackStep(stacks, 'b', 'up')).to.deep.equal({ reason: 'b is the top of its stack' });
    expect(stackStep(stacks, 'main', 'down')).to.deep.equal({ reason: 'main is the base of its stack' });
    expect(stackStep(stacks, 'other', 'up')).to.deep.equal({ reason: 'other is not part of a stack' });
    expect(stackStep(stacks, null, 'up').target).to.be.undefined;
    const orphan: Stack[] = [{ base: 'gone', branches: [entry('x', 'gone', 1, { parentMissing: true })] }];
    expect(stackStep(orphan, 'x', 'down')).to.deep.equal({ reason: "x's parent gone no longer exists" });
  });
});
