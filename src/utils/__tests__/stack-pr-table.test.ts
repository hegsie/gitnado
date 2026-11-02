import { expect } from '@open-wc/testing';
import type { Stack } from '../../types/git.types.ts';
import { renderStackSection, spliceStackSection, STACK_SECTION_START, STACK_SECTION_END } from '../stack-pr-table.ts';

const entry = (name: string, parent: string, depth: number) => ({
  name, parent, depth, ahead: 1, behind: 0, isHead: false, parentMissing: false,
});
const stack: Stack = { base: 'main', branches: [entry('feat-a', 'main', 1), entry('feat-b', 'feat-a', 2)] };

describe('stack PR table', () => {
  it('lists the stack top to bottom with links and marks the current request', () => {
    const prs = new Map([['feat-a', { number: 11, url: 'https://x/11' }], ['feat-b', { number: 12, url: 'https://x/12' }]]);
    const section = renderStackSection(stack, prs, 'feat-a', '#');
    expect(section.split('\n')).to.deep.equal([
      STACK_SECTION_START,
      '**Stack** (top to bottom; kept up to date by Gitnado)',
      '',
      '- [#12](https://x/12) `feat-b`',
      '- [#11](https://x/11) `feat-a` ← this one',
      '- `main`',
      STACK_SECTION_END,
    ]);
  });

  it('uses the provider prefix and leaves branches without a request unlinked', () => {
    const section = renderStackSection(stack, new Map([['feat-a', { number: 3, url: 'u' }]]), 'feat-b', '!');
    expect(section).to.contain('- `feat-b` ← this one');
    expect(section).to.contain('- [!3](u) `feat-a`');
  });

  it('appends to a description, replaces an existing section, and keeps the rest', () => {
    expect(spliceStackSection(null, 'S')).to.equal('S');
    expect(spliceStackSection('Intro\n\n', 'S')).to.equal('Intro\n\nS');
    const old = `Intro\n\n${STACK_SECTION_START}\nold\n${STACK_SECTION_END}\n\nOutro`;
    expect(spliceStackSection(old, 'NEW')).to.equal('Intro\n\nNEW\n\nOutro');
  });
});
