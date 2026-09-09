/**
 * Ordering and reporting for graph multi-selection actions.
 *
 * The ordering is the load-bearing part: the graph hands the selection over in
 * CLICK order, and a cherry-pick sequence replayed newest-first conflicts or
 * builds a different tree. Everything here derives the order from the loaded
 * commit list (the graph's own newest-first walk) instead.
 */

import { expect } from '@open-wc/testing';
import {
  cherryPickConfirmMessage,
  cherryPickFailureMessage,
  numberedCommitList,
  orderCommitsForApply,
  shortCommitLabel,
} from '../commit-selection.ts';
import type { Commit } from '../../types/git.types.ts';

function makeCommit(oid: string, summary: string, timestamp = 1700000000): Commit {
  return {
    oid: oid.padEnd(40, '0'),
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: null,
    author: { name: 'Test Author', email: 'test@example.com', timestamp },
    committer: { name: 'Test Author', email: 'test@example.com', timestamp },
    parentIds: [],
    timestamp,
  };
}

// The graph's walk: newest first.
const newest = makeCommit('ccc3333', 'Third commit');
const middle = makeCommit('bbb2222', 'Second commit');
const oldest = makeCommit('aaa1111', 'First commit');
const loaded = [newest, middle, oldest];

describe('orderCommitsForApply', () => {
  it('orders a click-ordered selection ancestor first', () => {
    // Ctrl+clicked newest → oldest → middle, the order a user actually clicks in.
    const ordered = orderCommitsForApply([newest, oldest, middle], loaded);
    expect(ordered.map((c) => c.summary)).to.deep.equal([
      'First commit',
      'Second commit',
      'Third commit',
    ]);
  });

  it('is unchanged by the order the commits were selected in', () => {
    const a = orderCommitsForApply([oldest, middle, newest], loaded);
    const b = orderCommitsForApply([middle, newest, oldest], loaded);
    expect(a.map((c) => c.oid)).to.deep.equal(b.map((c) => c.oid));
  });

  it('ignores timestamps, which a rewritten history can order backwards', () => {
    // A rebase stamps new committer times: the graph's topological walk is the
    // only order that can be trusted here.
    const child = makeCommit('ddd4444', 'Child', 100);
    const parent = makeCommit('eee5555', 'Parent', 900);
    const ordered = orderCommitsForApply([child, parent], [child, parent]);
    expect(ordered.map((c) => c.summary)).to.deep.equal(['Parent', 'Child']);
  });

  it('drops commits the graph no longer has, so the count matches the work', () => {
    const gone = makeCommit('fff6666', 'Rewritten away');
    const ordered = orderCommitsForApply([newest, gone, oldest], loaded);
    expect(ordered.map((c) => c.summary)).to.deep.equal(['First commit', 'Third commit']);
  });

  it('returns nothing when the graph has no loaded commits to order against', () => {
    expect(orderCommitsForApply([newest, oldest], [])).to.deep.equal([]);
  });

  it('de-duplicates a repeated selection entry', () => {
    const ordered = orderCommitsForApply([newest, newest, oldest], loaded);
    expect(ordered.map((c) => c.oid)).to.deep.equal([oldest.oid, newest.oid]);
  });
});

describe('commit labels', () => {
  it('pairs the short id with the summary', () => {
    expect(shortCommitLabel(newest)).to.equal('ccc3333 Third commit');
  });

  it('falls back to the oid when a commit carries no short id', () => {
    const noShortId = { ...newest, shortId: '' };
    expect(shortCommitLabel(noShortId)).to.equal('ccc3333 Third commit');
  });

  it('caps a long subject so one commit cannot push a list off the side', () => {
    const long = makeCommit('999aaaa', 'x'.repeat(200));
    const label = shortCommitLabel(long);
    expect(label.length).to.be.lessThan(80);
    expect(label.endsWith('…')).to.equal(true);
  });

  it('numbers a list in the order it is given', () => {
    expect(numberedCommitList([oldest, newest])).to.equal(
      '1. aaa1111 First commit\n2. ccc3333 Third commit',
    );
  });
});

describe('cherryPickConfirmMessage', () => {
  it('names the count, the branch, the order and what a failure does', () => {
    const message = cherryPickConfirmMessage([oldest, middle, newest], 'main');
    expect(message).to.contain('Cherry-pick 3 commits onto main');
    expect(message).to.contain('oldest first');
    expect(message).to.contain('1. aaa1111 First commit');
    expect(message).to.contain('3. ccc3333 Third commit');
    expect(message).to.contain('the sequence stops there');
  });
});

describe('cherryPickFailureMessage', () => {
  it('reports what was applied, where it stopped and what is left', () => {
    const message = cherryPickFailureMessage([oldest], [middle, newest], 3, 'merge conflict');
    expect(message).to.contain('Cherry-picked 1 of 3 commits');
    expect(message).to.contain('stopped at bbb2222 Second commit');
    expect(message).to.contain('merge conflict');
    expect(message).to.contain('Still to apply after it: ccc3333');
  });

  it('says nothing was applied when the first commit fails', () => {
    const message = cherryPickFailureMessage([], [oldest, middle, newest], 3, 'boom');
    expect(message).to.contain('stopped on the first of 3 commits');
    expect(message).to.contain('aaa1111 First commit');
    expect(message).to.contain('Still to apply after it: bbb2222, ccc3333');
  });

  it('does not promise a remainder when the last commit is the one that failed', () => {
    const message = cherryPickFailureMessage([oldest, middle], [newest], 3, 'boom');
    expect(message).to.contain('Cherry-picked 2 of 3 commits');
    expect(message).to.contain('It was the last one in the sequence.');
    expect(message).to.not.contain('Still to apply');
  });
});
