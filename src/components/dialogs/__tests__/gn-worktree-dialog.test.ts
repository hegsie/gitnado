/**
 * Worktree Dialog Tests
 *
 * Tests lock/unlock operations dispatch worktrees-changed events
 * and show success messages.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { Worktree } from '../../../services/git.service.ts';

// Mock data
const mockWorktrees: Worktree[] = [
  {
    path: '/test/repo',
    headOid: 'abc123',
    branch: 'main',
    isMain: true,
    isLocked: false,
    lockReason: null,
    isBare: false,
    isPrunable: false,
  },
  {
    path: '/test/worktree-1',
    headOid: 'def456',
    branch: 'feature-1',
    isMain: false,
    isLocked: false,
    lockReason: null,
    isBare: false,
    isPrunable: false,
  },
];

/** What `get_worktrees` answers with; a test may swap it before mounting. */
let worktreeFixture: Worktree[] = mockWorktrees;

const invokedCommands: string[] = [];
let failingCommands: Set<string> = new Set();

/** Commands parked mid-flight until the test releases them. */
const gatedCommands = new Set<string>();
const gateReleases = new Map<string, () => void>();
/** Every repo path `get_worktrees` was asked for, in order. */
const worktreeReads: string[] = [];

function gate(command: string): void {
  gatedCommands.add(command);
}

/** Resolves once `command` is actually in flight (parked on its gate). */
async function waitForGate(command: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (gateReleases.has(command)) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`${command} never reached its gate`);
}

function release(command: string): void {
  const resolve = gateReleases.get(command);
  gatedCommands.delete(command);
  gateReleases.delete(command);
  resolve?.();
}

/** Polls until `predicate` holds, so async work started by Lit can settle. */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  invokedCommands.push(command);

  if (command === 'get_worktrees') {
    worktreeReads.push(((args as { path?: string }) ?? {}).path ?? '');
  }

  if (gatedCommands.has(command)) {
    await new Promise<void>((resolve) => gateReleases.set(command, resolve));
  }

  if (failingCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: `Failed: ${command}` };
  }

  switch (command) {
    case 'get_worktrees':
      return worktreeFixture;
    case 'lock_worktree':
      return null;
    case 'unlock_worktree':
      return null;
    case 'add_worktree':
      return null;
    case 'remove_worktree':
      return null;
    case 'get_branches':
      return [];
    // plugin-dialog 2.7 routes confirm() through `message` and returns the
    // clicked button label; 'Ok' means the user confirmed.
    case 'plugin:dialog|message':
    case 'plugin:dialog|confirm':
    case 'plugin:dialog|ask':
      return 'Ok';
    case 'plugin:notification|is_permission_granted':
      return false;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import the component AFTER setting up the mock
import '../gn-worktree-dialog.ts';
import type { GnWorktreeDialog } from '../gn-worktree-dialog.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

describe('gn-worktree-dialog', () => {
  beforeEach(() => {
    invokedCommands.length = 0;
    failingCommands = new Set();
    gatedCommands.clear();
    // Release anything a failed test left parked, so its handler unwinds and
    // frees the shared lock instead of poisoning every test after it.
    gateReleases.forEach((resolve) => resolve());
    gateReleases.clear();
    worktreeReads.length = 0;
    worktreeFixture = mockWorktrees;
    resetRefOpLocks();
  });

  it('renders when open', async () => {
    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    const dialog = el.shadowRoot!.querySelector('.dialog');
    expect(dialog).to.not.be.null;
  });

  it('dispatches worktrees-changed on lock', async () => {
    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('worktrees-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleLock(mockWorktrees[1]);

    expect(invokedCommands).to.include('lock_worktree');
    expect(eventFired).to.be.true;
  });

  it('shows success message on lock', async () => {
    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleLock(mockWorktrees[1]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).success).to.equal('Worktree locked successfully');
  });

  it('dispatches worktrees-changed on unlock', async () => {
    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('worktrees-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUnlock(mockWorktrees[1]);

    expect(invokedCommands).to.include('unlock_worktree');
    expect(eventFired).to.be.true;
  });

  it('shows success message on unlock', async () => {
    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUnlock(mockWorktrees[1]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).success).to.equal('Worktree unlocked successfully');
  });

  it('shows error on lock failure', async () => {
    failingCommands.add('lock_worktree');

    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('worktrees-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleLock(mockWorktrees[1]);

    expect(eventFired).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error).to.include('Failed');
  });

  it('shows error on unlock failure', async () => {
    failingCommands.add('unlock_worktree');

    const el = await fixture<GnWorktreeDialog>(
      html`<gn-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-worktree-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('worktrees-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUnlock(mockWorktrees[1]);

    expect(eventFired).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error).to.include('Failed');
  });

  // A removal runs `git worktree remove --force`, deleting a working directory
  // from disk. The dialog is bound to the ACTIVE repository and re-pins on
  // every open, so anything that lets it close (or re-pin) mid-removal points
  // the completion — the banner, the reload and the `worktrees-changed`
  // refresh — at a repository the removal never touched.
  describe('a removal in flight owns the dialog', () => {
    const REPO_A = '/repo/a';
    const REPO_B = '/repo/b';

    /** Opens on `path` and drops the initial loads from the read log. */
    async function openOn(path: string): Promise<GnWorktreeDialog> {
      const el = await fixture<GnWorktreeDialog>(
        html`<gn-worktree-dialog ?open=${true} .repositoryPath=${path}></gn-worktree-dialog>`,
      );
      // connectedCallback loads before the pin is taken, then the open
      // transition pins and loads again.
      await waitUntil(() => worktreeReads.includes(path), 'the initial worktree load');
      expect(
        worktreeReads.every((p) => p === '' || p === path),
        'nothing but this repo was read while opening',
      ).to.be.true;
      worktreeReads.length = 0;
      return el;
    }

    function routedRepos(el: GnWorktreeDialog): string[] {
      const seen: string[] = [];
      el.addEventListener('worktrees-changed', (e) => {
        seen.push((e as CustomEvent<{ repositoryPath?: string }>).detail?.repositoryPath ?? '');
      });
      return seen;
    }

    /** Starts a removal and returns once `remove_worktree` is in flight. */
    async function startRemoval(el: GnWorktreeDialog): Promise<{ done: Promise<void> }> {
      gate('remove_worktree');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handleRemove(mockWorktrees[1]) as Promise<void>;
      await waitForGate('remove_worktree');
      // Wrapped: `await`ing a promise that resolves TO a promise would chain
      // onto the parked removal and hang the test.
      return { done };
    }

    it('Escape does not close the dialog while the removal is running', async () => {
      const el = await openOn(REPO_A);
      let closes = 0;
      el.addEventListener('close', () => { closes++; });

      const { done } = await startRemoval(el);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;

      expect(closes, 'a working directory is still being deleted').to.equal(0);
      expect(
        (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).disabled,
        'and the x says so, instead of looking live and doing nothing',
      ).to.be.true;

      release('remove_worktree');
      await done;
      await el.updateComplete;
      expect(
        (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).disabled,
        'and it comes back once the removal lands',
      ).to.be.false;

      // The control: once nothing is in flight, Escape dismisses as always.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;
      expect(closes, 'Escape still works when idle').to.equal(1);
    });

    it('reloads and routes the finished removal to the repo it ran on, not a repo reopened over it', async () => {
      const el = await openOn(REPO_A);
      const routed = routedRepos(el);
      const { done } = await startRemoval(el);

      // The host owns ?open and can clear it without going through
      // handleClose (closing the tab does exactly that), then reopen the
      // dialog over another repository.
      el.open = false;
      await el.updateComplete;
      el.repositoryPath = REPO_B;
      el.open = true;
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      release('remove_worktree');
      await done;

      expect(
        worktreeReads,
        'the reopen must not re-pin under the removal, and the reload must read the repo that changed',
      ).to.deep.equal([REPO_A]);
      expect(routed, 'the host refreshes the repo whose worktree was deleted').to.deep.equal([
        REPO_A,
      ]);
    });

    it('routes an add that lands after the dialog reopened elsewhere to the repo it ran on', async () => {
      // `worktree add` checks out a whole tree — also seconds — but it is not
      // destructive, so the dialog does close over it and legitimately re-pins
      // on reopen. The completion must still follow the path it captured.
      const el = await openOn(REPO_A);
      const routed = routedRepos(el);

      gate('add_worktree');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).addPath = '/tmp/wt-new';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).createNewBranch = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).newBranchName = 'feature/new';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handleAdd() as Promise<void>;
      await waitForGate('add_worktree');

      el.open = false;
      await el.updateComplete;
      el.repositoryPath = REPO_B;
      el.open = true;
      await el.updateComplete;
      await waitUntil(() => worktreeReads.length === 1, 'the reopened dialog to load repo B');

      release('add_worktree');
      await done;

      expect(
        worktreeReads,
        'the stale reload is dropped, not painted over the repository now on screen',
      ).to.deep.equal([REPO_B]);
      expect(routed, 'the host refreshes the repo the worktree was added to').to.deep.equal([
        REPO_A,
      ]);
    });
  });

  // `git worktree remove` deletes a working directory from disk, and the one
  // the app is open on must survive. The paths being compared come from two
  // different sources — git's `worktree list` and the OS file dialog — so the
  // same directory reaches the dialog under two spellings, and the raw string
  // compare that used to back this guard simply missed.
  describe('the open worktree cannot be removed', () => {
    async function open(repositoryPath: string): Promise<GnWorktreeDialog> {
      return fixture<GnWorktreeDialog>(
        html`<gn-worktree-dialog
          ?open=${true}
          .repositoryPath=${repositoryPath}
        ></gn-worktree-dialog>`,
      );
    }

    it('blocks removal when git and the file dialog disagree on separators', async () => {
      const el = await open('C:\\work\\repo');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleRemove({ ...mockWorktrees[1], path: 'C:/work/repo' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.contain('currently have open');
      expect(invokedCommands).to.not.include('remove_worktree');
    });

    it('blocks removal when the two spellings differ only in case on Windows', async () => {
      const el = await open('C:\\work\\repo');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleRemove({ ...mockWorktrees[1], path: 'c:/Work/Repo' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.contain('currently have open');
      expect(invokedCommands).to.not.include('remove_worktree');
    });

    // `get_worktrees` falls back to a raw string compare when canonicalize
    // fails on either side, so an explicit `isCurrent: false` can be a false
    // negative. The spelling fallback must still run — treating the backend's
    // `false` as authoritative would re-open the bug this guard exists for.
    it('blocks removal when the backend said false but the spellings match', async () => {
      const el = await open('C:\\work\\repo');

      await (el as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .handleRemove({ ...mockWorktrees[1], path: 'C:/work/repo', isCurrent: false });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.contain('currently have open');
      expect(invokedCommands).to.not.include('remove_worktree');
    });

    it('blocks removal when only the backend can tell (a symlinked repo path)', async () => {
      const el = await open('/var/folders/x/repo');

      await (el as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .handleRemove({
          ...mockWorktrees[1],
          path: '/private/var/folders/x/repo',
          isCurrent: true,
        });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.contain('currently have open');
      expect(invokedCommands).to.not.include('remove_worktree');
    });

    it('disables the Remove button for the open worktree', async () => {
      worktreeFixture = [mockWorktrees[0], { ...mockWorktrees[1], path: 'C:/work/repo' }];
      const el = await open('C:\\work\\repo');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await waitUntil(() => (el as any).worktrees.length === 2, 'the worktree list');
      await el.updateComplete;

      const removeBtns = el.shadowRoot!.querySelectorAll('.action-btn.danger');
      expect((removeBtns[1] as HTMLButtonElement).disabled).to.be.true;
    });

    it('still removes a worktree that is merely a sibling of the open one', async () => {
      const el = await open('/test/repo');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleRemove(mockWorktrees[1]);

      expect(invokedCommands).to.include('remove_worktree');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.equal('');
    });

    it('keeps POSIX paths case-sensitive: /test/repo is not /test/Repo', async () => {
      const el = await open('/test/Repo');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleRemove({ ...mockWorktrees[1], path: '/test/repo' });

      expect(invokedCommands).to.include('remove_worktree');
    });
  });
});
