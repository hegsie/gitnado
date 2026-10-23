/**
 * Cherry-Pick Dialog Tests
 *
 * Regression coverage for merge-commit cherry-picks: the backend requires an
 * explicit mainline parent for a merge commit (like `git cherry-pick -m`), so
 * the dialog must expose a mainline selector for merge commits and forward the
 * chosen `mainline` — while omitting it for ordinary single-parent commits.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { Commit } from '../../../types/git.types.ts';

let lastInvokedCommand: string | null = null;
let lastInvokedArgs: Record<string, unknown> | null = null;
let cherryPickError: { code: string; message: string } | null = null;
let cbId = 0;

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  lastInvokedCommand = command;
  lastInvokedArgs = (args as Record<string, unknown>) ?? null;
  if (command === 'cherry_pick') {
    if (cherryPickError) throw cherryPickError;
    // Mimic a successful cherry-pick returning the new commit.
    return {
      oid: 'newcommit0000',
      shortId: 'newcomm',
      summary: 'Cherry-picked',
      message: 'Cherry-picked',
      body: null,
      timestamp: Math.floor(Date.now() / 1000),
      author: { name: 'T', email: 't@e.com', timestamp: 0 },
      committer: { name: 'T', email: 't@e.com', timestamp: 0 },
      parentIds: ['base'],
    };
  }
  return null;
};

(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// Import the component AFTER setting up the mock
import '../gn-cherry-pick-dialog.ts';
import type { GnCherryPickDialog } from '../gn-cherry-pick-dialog.ts';

function makeCommit(parentIds: string[]): Commit {
  const ts = Math.floor(Date.now() / 1000);
  return {
    oid: 'target00000000',
    shortId: 'target0',
    summary: 'A commit',
    message: 'A commit',
    body: null,
    timestamp: ts,
    author: { name: 'Test User', email: 'test@example.com', timestamp: ts },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: ts },
    parentIds,
  };
}

describe('gn-cherry-pick-dialog', () => {
  beforeEach(() => {
    lastInvokedCommand = null;
    lastInvokedArgs = null;
    cherryPickError = null;
  });

  it('shows a mainline selector only for merge commits', async () => {
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog .repositoryPath=${'/test/repo'}></gn-cherry-pick-dialog>`,
    );

    // Single-parent commit: no mainline selector.
    el.open(makeCommit(['p1']));
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('#mainline-select')).to.be.null;

    // Merge commit: selector appears with one option per parent.
    el.open(makeCommit(['p1', 'p2']));
    await el.updateComplete;
    const select = el.shadowRoot!.querySelector('#mainline-select') as HTMLSelectElement;
    expect(select).to.not.be.null;
    expect(select.querySelectorAll('option')).to.have.length(2);
  });

  it('forwards the chosen mainline when cherry-picking a merge commit', async () => {
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog .repositoryPath=${'/test/repo'}></gn-cherry-pick-dialog>`,
    );
    el.open(makeCommit(['p1', 'p2']));
    await el.updateComplete;

    // Choose the second parent as mainline.
    const select = el.shadowRoot!.querySelector('#mainline-select') as HTMLSelectElement;
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;

    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /cherry-pick/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    btn.click();
    await el.updateComplete;

    expect(lastInvokedCommand).to.equal('cherry_pick');
    expect(lastInvokedArgs?.mainline).to.equal(2);
  });

  it('omits mainline for a non-merge commit', async () => {
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog .repositoryPath=${'/test/repo'}></gn-cherry-pick-dialog>`,
    );
    el.open(makeCommit(['p1']));
    await el.updateComplete;

    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /cherry-pick/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    btn.click();
    await el.updateComplete;

    expect(lastInvokedCommand).to.equal('cherry_pick');
    expect(lastInvokedArgs?.mainline).to.equal(undefined);
  });

  it('cherry-pick-complete carries the repo the pick ran on (pinned pre-await)', async () => {
    // The success refresh must target the ORIGINATING repo — after a
    // mid-operation tab switch, refreshing the active tab would leave the
    // picked-onto repo's graph and state stale.
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog .repositoryPath=${'/test/repo'}></gn-cherry-pick-dialog>`,
    );
    el.open(makeCommit(['p1']));
    await el.updateComplete;

    let detail: { repositoryPath?: string } | undefined;
    el.addEventListener('cherry-pick-complete', (e) => {
      detail = (e as CustomEvent).detail;
    });

    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /cherry-pick/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(detail?.repositoryPath).to.equal('/test/repo');
  });

  it('pins to the repo present at open(), surviving a repositoryPath rebind (tab switch)', async () => {
    // The dialog is long-lived (open → review → later Execute click). A
    // Ctrl+Tab while it sits open rebinds the reactive prop; the pick must
    // still run on the repo shown when it opened.
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog .repositoryPath=${'/repo/A'}></gn-cherry-pick-dialog>`,
    );
    el.open(makeCommit(['p1']));
    await el.updateComplete;

    // Simulate the active-repo tab switching while the dialog stays open.
    el.repositoryPath = '/repo/B';
    await el.updateComplete;

    let detail: { repositoryPath?: string } | undefined;
    el.addEventListener('cherry-pick-complete', (e) => {
      detail = (e as CustomEvent).detail;
    });

    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /cherry-pick/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(lastInvokedCommand).to.equal('cherry_pick');
    expect(lastInvokedArgs?.path, 'runs on the pinned repo, not the rebound one').to.equal('/repo/A');
    expect(detail?.repositoryPath).to.equal('/repo/A');
  });

  it('shows the branch captured at open, not the rebound one after a tab switch', async () => {
    // The "Cherry-pick onto" label must match the repo the operation
    // actually targets — the live currentBranch prop rebinds on a tab
    // switch and would otherwise advertise the wrong target branch.
    const el = await fixture<GnCherryPickDialog>(
      html`<gn-cherry-pick-dialog
        .repositoryPath=${'/repo/A'}
        .currentBranch=${'main'}
      ></gn-cherry-pick-dialog>`,
    );
    el.open(makeCommit(['p1']));
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.target-branch')?.textContent).to.contain('main');

    // Tab switch rebinds both props.
    el.repositoryPath = '/repo/B';
    el.currentBranch = 'develop';
    await el.updateComplete;

    expect(
      el.shadowRoot!.querySelector('.target-branch')?.textContent,
      'label stays pinned to the branch shown at open',
    ).to.contain('main');
    expect(el.shadowRoot!.querySelector('.target-branch')?.textContent).to.not.contain('develop');
  });

  // The backend refuses a cherry-pick whose index would destroy staged work.
  // That is a precondition failure with nothing to resolve, so it must land
  // inline in the dialog — routing it to the conflict-resolution flow would
  // open a resolve/abort UI over a repository with no operation in progress.
  // The routing at handleCherryPick() falls back to a substring match on
  // "conflict", so these also pin the wording of both refusal messages.
  for (const { name, message } of [
    {
      name: 'staged changes',
      message:
        'The index has staged changes. Commit or stash them before starting this operation.',
    },
    {
      name: 'unmerged files',
      message: 'The index has unmerged files. Resolve them before starting this operation.',
    },
  ]) {
    it(`reports a ${name} refusal inline instead of opening the conflict dialog`, async () => {
      cherryPickError = { code: 'OPERATION_FAILED', message };

      const el = await fixture<GnCherryPickDialog>(
        html`<gn-cherry-pick-dialog .repositoryPath=${'/test/repo'}></gn-cherry-pick-dialog>`,
      );
      el.open(makeCommit(['p1']));
      await el.updateComplete;

      let conflictFired = false;
      el.addEventListener('cherry-pick-conflict', () => {
        conflictFired = true;
      });

      const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
        /cherry-pick/i.test(b.textContent ?? ''),
      ) as HTMLButtonElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(conflictFired, 'must not route a precondition failure to the conflict dialog').to.be
        .false;
      expect(el.shadowRoot!.querySelector('.error-message')?.textContent).to.contain(message);
      // The dialog stays open so the user can act and retry.
      expect(el.shadowRoot!.querySelector('gn-modal')?.hasAttribute('open')).to.be.true;
    });
  }
});
