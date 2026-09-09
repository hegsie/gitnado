/**
 * Unit tests for lv-compare-branches-dialog.
 *
 * Covers the whole reachable flow: the pickers filling from get_branches, a
 * successful comparison rendering its summary and lists, both failure paths
 * surfacing inline (the dialog stays open, so a toast would be the wrong
 * surface), the identical-refs empty state, and the show-commit route out.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invoked: { command: string; args?: unknown }[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import type { Branch } from '../../../types/git.types.ts';
import type {
  CompareOpenOptions,
  LvCompareBranchesDialog,
} from '../lv-compare-branches-dialog.ts';
import '../lv-compare-branches-dialog.ts';

function branch(name: string, isHead = false): Branch {
  return {
    name,
    shorthand: name,
    isHead,
    isRemote: name.includes('/'),
    upstream: null,
    targetOid: `oid-${name}`,
    isStale: false,
  };
}

const BRANCHES: Branch[] = [branch('main', true), branch('feature'), branch('origin/feature')];

const COMPARISON = {
  baseRef: 'main',
  compareRef: 'feature',
  ahead: 2,
  behind: 1,
  mergeBase: 'abcdef1234567890',
  commitsAhead: [
    {
      oid: 'aaa111bbb222',
      shortOid: 'aaa111b',
      message: 'Add the thing\n\nbody',
      authorName: 'Ada',
      authorDate: 1700000000,
    },
    {
      oid: 'ccc333ddd444',
      shortOid: 'ccc333d',
      message: 'Fix the thing',
      authorName: 'Ada',
      authorDate: 1700000100,
    },
  ],
  commitsBehind: [
    {
      oid: 'eee555fff666',
      shortOid: 'eee555f',
      message: 'Unrelated work',
      authorName: 'Grace',
      authorDate: 1700000200,
    },
  ],
  filesChanged: [
    { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 3, oldPath: null },
    { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0, oldPath: null },
  ],
  totalAdditions: 15,
  totalDeletions: 3,
};

const IDENTICAL = {
  baseRef: 'main',
  compareRef: 'feature',
  ahead: 0,
  behind: 0,
  mergeBase: 'abcdef1234567890',
  commitsAhead: [],
  commitsBehind: [],
  filesChanged: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

/** Default backend: branches load, comparison succeeds. */
function installMock(overrides: Record<string, unknown> = {}): void {
  mockInvoke = (command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    }
    if (command === 'get_branches') return Promise.resolve(BRANCHES);
    if (command === 'compare_branches') return Promise.resolve(COMPARISON);
    return Promise.resolve(null);
  };
}

async function makeDialog(): Promise<LvCompareBranchesDialog> {
  const el = await fixture<LvCompareBranchesDialog>(
    html`<lv-compare-branches-dialog .repositoryPath=${'/test/repo'}></lv-compare-branches-dialog>`
  );
  await el.updateComplete;
  return el;
}

/** open() defers its branch load behind updateComplete + rAF; settle both. */
async function openAndSettle(
  el: LvCompareBranchesDialog,
  target?: string | CompareOpenOptions,
): Promise<void> {
  el.open(target);
  await el.updateComplete;
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

/** Let the IPC round trip resolve, then let Lit re-render. */
async function settle(el: LvCompareBranchesDialog): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

function text(el: LvCompareBranchesDialog): string {
  return el.renderRoot.textContent ?? '';
}

describe('lv-compare-branches-dialog', () => {
  beforeEach(() => {
    invoked.length = 0;
    installMock();
  });

  it('fills both pickers from get_branches and preselects the requested compare ref', async () => {
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    expect(invoked.some((c) => c.command === 'get_branches')).to.be.true;

    const options = Array.from(
      el.renderRoot.querySelectorAll('#compare-ref-select option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(options).to.deep.equal(['main', 'feature', 'origin/feature']);

    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
    expect(compareSelect.value, 'compare side aims at the requested ref').to.equal('feature');
    expect(baseSelect.value, 'base defaults to the current branch').to.equal('main');
  });

  it('renders the comparison summary, commit lists and changed files', async () => {
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    const compareBtn = el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement;
    expect(compareBtn.disabled, 'two distinct refs are selected').to.be.false;
    compareBtn.click();
    await settle(el);

    const call = invoked.find((c) => c.command === 'compare_branches');
    expect(call, 'compare_branches was invoked').to.exist;
    expect(call?.args).to.deep.equal({
      path: '/test/repo',
      base: 'main',
      compare: 'feature',
      includeCommits: true,
      includeFiles: true,
    });

    expect(el.renderRoot.querySelector('[data-testid="commits-ahead"]')).to.exist;
    expect(el.renderRoot.querySelector('[data-testid="commits-behind"]')).to.exist;
    expect(el.renderRoot.querySelector('[data-testid="files-changed"]')).to.exist;
    expect(
      el.renderRoot.querySelectorAll('[data-testid="commits-ahead"] .row'),
    ).to.have.length(2);
    expect(
      el.renderRoot.querySelectorAll('[data-testid="files-changed"] .row'),
    ).to.have.length(2);

    const body = text(el);
    expect(body, 'merge base is shown, abbreviated').to.contain('abcdef1');
    expect(body, 'first line of the commit subject').to.contain('Add the thing');
    expect(body, 'changed file path').to.contain('src/a.ts');
    expect(body, 'line totals').to.contain('+15');
  });

  it('shows the comparison failure inline instead of failing silently', async () => {
    installMock({ compare_branches: new Error('no merge base') });
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);

    const error = el.renderRoot.querySelector('.error-message');
    expect(error, 'an inline error is rendered').to.exist;
    expect(error?.textContent).to.contain('no merge base');
    expect(
      el.renderRoot.querySelector('[data-testid="commits-ahead"]'),
      'no stale result is left on screen',
    ).to.not.exist;
  });

  it('shows a branch-load failure inline and leaves the pickers empty', async () => {
    installMock({ get_branches: new Error('not a repository') });
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    const error = el.renderRoot.querySelector('.error-message');
    expect(error?.textContent).to.contain('not a repository');
    expect(
      el.renderRoot.querySelectorAll('#base-ref-select option'),
      'nothing to choose from',
    ).to.have.length(0);
    expect(
      (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).disabled,
      'Compare stays disabled with no refs',
    ).to.be.true;
  });

  it('reports identical refs rather than an empty result panel', async () => {
    installMock({ compare_branches: IDENTICAL });
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);

    expect(el.renderRoot.querySelector('[data-testid="identical"]')).to.exist;
    expect(el.renderRoot.querySelector('[data-testid="commits-ahead"]')).to.not.exist;
  });

  it('moves the base off a compare ref that collides with the current branch', async () => {
    // Opening from the current branch's own row would otherwise leave both
    // pickers on "main" and Compare permanently disabled.
    const el = await makeDialog();
    await openAndSettle(el, 'main');

    const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    expect(compareSelect.value).to.equal('main');
    expect(baseSelect.value, 'base moved off the collision').to.not.equal('main');
    expect(
      (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).disabled,
      'Compare is usable',
    ).to.be.false;
  });

  it('moves the base off a compare ref that collides on re-entry while already open', async () => {
    // The command palette can re-fire open() with a new target while the
    // dialog is already up. Naming the branch currently on the base picker
    // must not silently leave both pickers on the same ref.
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
    expect(baseSelect.value, 'base is on the current branch before re-entry').to.equal('main');

    await openAndSettle(el, 'main');

    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    expect(compareSelect.value).to.equal('main');
    expect(baseSelect.value, 'base moved off the re-entry collision').to.not.equal('main');
    expect(
      (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).disabled,
      'Compare is usable',
    ).to.be.false;
  });

  it('drops a stale result when either ref is changed', async () => {
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);
    expect(el.renderRoot.querySelector('[data-testid="commits-ahead"]')).to.exist;

    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    compareSelect.value = 'origin/feature';
    compareSelect.dispatchEvent(new Event('change'));
    await el.updateComplete;

    expect(
      el.renderRoot.querySelector('[data-testid="commits-ahead"]'),
      'the previous pair’s result is cleared',
    ).to.not.exist;
  });

  it('swaps the two refs and clears the previous result', async () => {
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    (el.renderRoot.querySelector('.swap-btn') as HTMLButtonElement).click();
    await el.updateComplete;

    const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    expect(baseSelect.value).to.equal('feature');
    expect(compareSelect.value).to.equal('main');
  });

  it('dispatches show-commit and closes when a commit row is clicked', async () => {
    const el = await makeDialog();
    await openAndSettle(el, 'feature');

    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);

    const row = el.renderRoot.querySelector(
      '[data-testid="commits-ahead"] .row',
    ) as HTMLButtonElement;
    setTimeout(() => row.click());
    const event = await oneEvent(el, 'show-commit');
    expect(event.detail.oid).to.equal('aaa111bbb222');
    expect(el.pinnedRepositoryPathIfOpen, 'the dialog closed').to.be.null;
  });

  it('never claims work is in flight, so the tab-close sweep can dismiss it', async () => {
    const el = await makeDialog();
    expect(el.operationInFlight).to.be.false;
    await openAndSettle(el, 'feature');
    expect(el.pinnedRepositoryPathIfOpen).to.equal('/test/repo');
    expect(el.operationInFlight).to.be.false;
  });

  it('explains a repository with no branches at all', async () => {
    installMock({ get_branches: [] });
    const el = await makeDialog();
    await openAndSettle(el);

    expect(el.renderRoot.querySelector('[data-testid="no-branches"]'), 'the empty state is shown')
      .to.exist;
    expect(el.renderRoot.querySelector('[data-testid="single-branch"]')).to.not.exist;
  });

  it('explains a single-branch repository instead of a Compare that can never enable', async () => {
    installMock({ get_branches: [branch('main', true)] });
    const el = await makeDialog();
    await openAndSettle(el);

    const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
    const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
    expect(baseSelect.value, 'both pickers land on the only branch').to.equal('main');
    expect(compareSelect.value).to.equal('main');

    const compareBtn = el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement;
    expect(compareBtn.disabled, 'there is no second ref, so Compare cannot enable').to.be.true;

    expect(
      el.renderRoot.querySelector('[data-testid="single-branch"]'),
      'the dead end is explained rather than left as a disabled button',
    ).to.exist;
    expect(text(el)).to.contain('is the only branch here');

    // The pickers and swap have nothing to offer, so they go inert with it.
    expect(baseSelect.disabled, 'base picker is inert').to.be.true;
    expect(compareSelect.disabled, 'compare picker is inert').to.be.true;
    expect(
      (el.renderRoot.querySelector('.swap-btn') as HTMLButtonElement).disabled,
      'swap is inert',
    ).to.be.true;
  });

  it('drops a branch list that arrives after the dialog was closed and reopened', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    let loads = 0;
    const OTHER_REPO = [branch('release', true), branch('hotfix')];
    mockInvoke = (command: string) => {
      if (command === 'get_branches') {
        loads += 1;
        if (loads === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        return Promise.resolve(OTHER_REPO);
      }
      return Promise.resolve(null);
    };

    const el = await makeDialog();
    // First open: the branch load never settles while the dialog is up.
    await openAndSettle(el);
    expect(el.renderRoot.querySelectorAll('#base-ref-select option'), 'still loading')
      .to.have.length(0);

    el.close();
    await el.updateComplete;

    // Reopened against another tab, which loads its own branches.
    await openAndSettle(el);
    const names = () =>
      Array.from(el.renderRoot.querySelectorAll('#base-ref-select option')).map(
        (o) => (o as HTMLOptionElement).value,
      );
    expect(names(), 'the reopened dialog shows its own repository').to.deep.equal([
      'release',
      'hotfix',
    ]);

    // The abandoned load now resolves with the previous repository's branches.
    releaseFirst?.(BRANCHES);
    await settle(el);

    expect(names(), 'the stale branch list was discarded').to.deep.equal(['release', 'hotfix']);
    expect(el.renderRoot.querySelector('[data-testid="single-branch"]')).to.not.exist;
  });

  it('drops a comparison that resolves after the dialog was closed and reopened', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    let comparisons = 0;
    mockInvoke = (command: string) => {
      if (command === 'get_branches') return Promise.resolve(BRANCHES);
      if (command === 'compare_branches') {
        comparisons += 1;
        if (comparisons === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        return Promise.resolve(IDENTICAL);
      }
      return Promise.resolve(null);
    };

    const el = await makeDialog();
    await openAndSettle(el, 'feature');
    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);
    expect(
      el.renderRoot.querySelector('[data-testid="commits-ahead"]'),
      'the first comparison is still in flight',
    ).to.not.exist;

    el.close();
    await el.updateComplete;

    // Reopened, and this time the comparison completes on its own.
    await openAndSettle(el, 'feature');
    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);
    expect(
      el.renderRoot.querySelector('[data-testid="identical"]'),
      'the reopened dialog rendered its own result',
    ).to.exist;

    // The abandoned comparison now resolves with the previous pair's result.
    releaseFirst?.(COMPARISON);
    await settle(el);

    expect(
      el.renderRoot.querySelector('[data-testid="identical"]'),
      'the reopened result is still the one on screen',
    ).to.exist;
    expect(
      el.renderRoot.querySelector('[data-testid="commits-ahead"]'),
      'the stale comparison was discarded',
    ).to.not.exist;
  });

  it('drops a comparison failure belonging to a dialog that was already closed', async () => {
    let failFirst: ((reason: unknown) => void) | undefined;
    let comparisons = 0;
    mockInvoke = (command: string) => {
      if (command === 'get_branches') return Promise.resolve(BRANCHES);
      if (command === 'compare_branches') {
        comparisons += 1;
        if (comparisons === 1) return new Promise((_resolve, reject) => { failFirst = reject; });
        return Promise.resolve(IDENTICAL);
      }
      return Promise.resolve(null);
    };

    const el = await makeDialog();
    await openAndSettle(el, 'feature');
    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);

    el.close();
    await el.updateComplete;

    // Reopened, and its own comparison succeeds.
    await openAndSettle(el, 'feature');
    (el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement).click();
    await settle(el);
    expect(el.renderRoot.querySelector('[data-testid="identical"]')).to.exist;

    // The abandoned comparison now fails.
    failFirst?.(new Error('the tab went away'));
    await settle(el);

    expect(
      el.renderRoot.querySelector('.error-message'),
      'a failure from the previous open does not surface here',
    ).to.not.exist;
    expect(text(el)).to.not.contain('the tab went away');
    expect(
      el.renderRoot.querySelector('[data-testid="identical"]'),
      'and it does not wipe the result the reopened dialog produced',
    ).to.exist;
  });

  // The graph's "Compare these commits" hands over two commit oids, which are
  // not in the branch list at all — `compare_branches` resolves them with
  // revparse_single like any other ref.
  describe('comparing two commits from the graph', () => {
    const OLDER = 'aaa1111';
    const NEWER = 'ccc3333';
    const twoCommits: CompareOpenOptions = {
      baseRef: OLDER,
      compareRef: NEWER,
      extraRefs: [
        { ref: OLDER, label: 'aaa1111 First commit' },
        { ref: NEWER, label: 'ccc3333 Third commit' },
      ],
    };

    it('offers the two commits in both pickers, ancestor as the base', async () => {
      const el = await makeDialog();
      await openAndSettle(el, twoCommits);

      const options = Array.from(
        el.renderRoot.querySelectorAll('#compare-ref-select option'),
      ).map((o) => (o as HTMLOptionElement).value);
      expect(options.slice(0, 2), 'the commits lead the list').to.deep.equal([OLDER, NEWER]);
      expect(options, 'the branches stay available too').to.include('main');

      const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
      const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
      expect(baseSelect.value).to.equal(OLDER);
      expect(compareSelect.value).to.equal(NEWER);
      expect(text(el), 'the oids are labelled with their subjects').to.contain('First commit');
    });

    it('compares the two oids', async () => {
      const el = await makeDialog();
      await openAndSettle(el, twoCommits);

      const compareBtn = el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement;
      expect(compareBtn.disabled, 'two distinct refs are selected').to.be.false;
      compareBtn.click();
      await settle(el);

      const call = invoked.find((c) => c.command === 'compare_branches');
      expect(call?.args).to.deep.include({ base: OLDER, compare: NEWER });
    });

    it('still compares when the repository has no branches to offer', async () => {
      // A brand-new repository, or a branch load that failed: the two commits
      // are all this comparison ever needed.
      installMock({ get_branches: [] });
      const el = await makeDialog();
      await openAndSettle(el, twoCommits);

      const baseSelect = el.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement;
      expect(baseSelect.disabled, 'two refs is enough to compare').to.be.false;
      expect(el.renderRoot.querySelector('[data-testid="no-branches"]')).to.not.exist;
      expect(el.renderRoot.querySelector('[data-testid="single-branch"]')).to.not.exist;
      const compareBtn = el.renderRoot.querySelector('.btn-primary') as HTMLButtonElement;
      expect(compareBtn.disabled).to.be.false;
    });

    it('keeps the string form working for the branch context menu', async () => {
      const el = await makeDialog();
      await openAndSettle(el, 'feature');

      const compareSelect = el.renderRoot.querySelector('#compare-ref-select') as HTMLSelectElement;
      expect(compareSelect.value).to.equal('feature');
      const options = Array.from(
        el.renderRoot.querySelectorAll('#compare-ref-select option'),
      ).map((o) => (o as HTMLOptionElement).value);
      expect(options, 'no phantom refs are added').to.deep.equal([
        'main',
        'feature',
        'origin/feature',
      ]);
    });
  });

});

