/**
 * Submodule, worktree and LFS dialogs must hold the SHARED locks.
 *
 * These three were missed by every lock sweep — none of them imported
 * `ref-lock.ts` or `maintenance-confirms.ts` — even though each reaches a
 * command that mutates state the rest of the app serializes on:
 *
 *   - `remove_submodule` runs `git submodule deinit -f` + `git rm -f`, which
 *     rewrite the SUPERPROJECT's index and working tree. While it ran, every
 *     branch row, Discard button and graph ref menu stayed live, and a
 *     checkout's auto-stash could capture a half-removed tree or die on
 *     `index.lock`.
 *   - `add_worktree -b` creates a branch and `remove_worktree` prunes shared
 *     worktree metadata — refs the sidebar branch list holds this lock for.
 *   - `lfs_prune` irreversibly deletes local LFS objects (its own confirm says
 *     objects that were never pushed cannot be recovered) yet was the one
 *     maintenance command that could run beside a `git gc`.
 *
 * Each case asserts BOTH halves: the control greys out on a lock taken by
 * another surface (which needs the subscription, not just the getter), and the
 * handler refuses without reaching the backend.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invoked: string[] = [];

let lfsEnabled = true;
const failCommands = new Set<string>();

const mockInvoke: MockInvoke = async (command: string) => {
  invoked.push(command);
  if (failCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: `Failed: ${command}` };
  }
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (
    command === 'plugin:dialog|message' ||
    command === 'plugin:dialog|confirm' ||
    command === 'plugin:dialog|ask'
  ) {
    return 'Ok';
  }
  switch (command) {
    case 'get_submodules':
      return [
        {
          name: 'lib/utils',
          path: 'lib/utils',
          url: 'https://example.test/utils.git',
          status: 'current',
          headOid: 'abc123',
          branch: 'main',
          initialized: true,
        },
      ];
    case 'get_worktrees':
      return [
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
    case 'get_branches':
      return [
        { name: 'main', shorthand: 'main', isHead: true, isRemote: false, upstream: null, targetOid: 'a' },
        { name: 'feature-1', shorthand: 'feature-1', isHead: false, isRemote: false, upstream: null, targetOid: 'b' },
        { name: 'free', shorthand: 'free', isHead: false, isRemote: false, upstream: null, targetOid: 'c' },
        { name: 'origin/main', shorthand: 'origin/main', isHead: false, isRemote: true, upstream: null, targetOid: 'd' },
      ];
    case 'get_lfs_status':
      return {
        installed: true,
        version: '3.0.0',
        enabled: lfsEnabled,
        patterns: [],
        fileCount: 0,
        totalSize: 0,
      };
    case 'get_lfs_files':
      return [];
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-submodule-dialog.ts';
import '../gn-worktree-dialog.ts';
import '../gn-lfs-dialog.ts';
import { tryAcquireRefOp, releaseRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { resetMaintenanceLocks } from '../../../utils/maintenance-confirms.ts';

const REPO_PATH = '/test/repo';

interface Updatable extends HTMLElement {
  updateComplete: Promise<unknown>;
}

/** Wait for an async load to put `selector` in the shadow root. */
async function waitForRendered(el: Updatable, selector: string): Promise<Element> {
  for (let i = 0; i < 100; i++) {
    await el.updateComplete;
    const found = el.shadowRoot!.querySelector(selector);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${selector} never rendered`);
}

/**
 * The control must track the lock with no further gesture — no reopening, no
 * re-render triggered by the test. Reading a getter is not enough: it calls
 * isRefOpRunning on every access and so reports the truth even with the
 * subscription deleted.
 */
async function expectDisabledTracksLock(
  el: Updatable,
  btn: HTMLButtonElement,
  what: string,
): Promise<void> {
  expect(btn.disabled, `${what}: enabled while the repo is idle`).to.equal(false);

  tryAcquireRefOp(REPO_PATH);
  await el.updateComplete;
  expect(btn.disabled, `${what}: a claim from another surface must disable it`).to.equal(true);

  releaseRefOp(REPO_PATH);
  await el.updateComplete;
  expect(btn.disabled, `${what}: the release must revive it`).to.equal(false);
}

describe('the worktree Add form offers only usable branches', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
    lfsEnabled = true;
  });

  // `git worktree add <path> origin/main` exits 0 having created a DETACHED
  // worktree — the DWIM that makes a tracking branch fires only for a bare
  // name, not `remote/name`. Listing remotes here meant the dialog reported
  // "Worktree added successfully" and then drew a row reading `detached HEAD`,
  // not the branch the user had picked.
  it('excludes remote branches and branches already checked out', async () => {
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.worktree-item, .action-btn');

    const branches = (el as unknown as { branches: Array<{ name: string }> }).branches;
    const names = branches.map((b) => b.name);

    expect(names, 'a free local branch is offered').to.include('free');
    expect(names, 'no remote branch may be offered').to.not.include('origin/main');
    expect(
      names,
      'a branch already checked out in another worktree is not free'
    ).to.not.include('feature-1');
  });

  // The filter is derived from this.worktrees at LOAD time, and only `updated`
  // called loadBranches — so the branch just consumed stayed listed and the
  // next Add dead-ended on git's raw "already used by worktree at ...".
  it('reloads the branch list after an add', async () => {
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.action-btn');

    const internal = el as unknown as {
      addPath: string;
      addBranch: string;
      handleAdd: () => Promise<void>;
    };
    internal.addPath = '/test/wt-new';
    internal.addBranch = 'free';

    invoked.length = 0;
    await internal.handleAdd();

    expect(invoked, 'the add ran').to.include('add_worktree');
    expect(
      invoked.filter((c) => c === 'get_branches').length,
      'the dropdown must be rebuilt from the new worktree list'
    ).to.be.greaterThan(0);
  });
});

// Every handler reset `error` on entry and none reset `success`, so a failure
// rendered UNDER a stale green banner still asserting the previous destructive
// operation had succeeded.
describe('a failure never renders under a stale success banner', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
    lfsEnabled = true;
  });

  it('gn-worktree-dialog clears the success banner when the next action fails', async () => {
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.action-btn');

    const internal = el as unknown as {
      success: string;
      error: string;
      handleLock: (w: { path: string; isMain: boolean }) => Promise<void>;
    };
    internal.success = 'Worktree removed';

    // The next operation FAILS — the case that matters, because a failing
    // handler sets only `error` and so leaves any stale success on screen.
    failCommands.add('lock_worktree');
    try {
      await internal.handleLock({ path: '/test/worktree-1', isMain: false });
    } finally {
      failCommands.delete('lock_worktree');
    }

    expect(internal.error, 'the failure is reported').to.not.equal('');
    expect(
      internal.success,
      'a green "Worktree removed" must not survive alongside it'
    ).to.equal('');
  });
});

// The scripted edit that added the success reset matched a shape two sites did
// not have: gn-lfs-dialog's handleInit (restructured earlier, so the pattern
// no longer matched) and the mode-switch Cancel buttons, which are inline
// arrow handlers in render rather than methods.
describe('the success banner is cleared everywhere it can go stale', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
    lfsEnabled = true;
  });

  it('gn-lfs-dialog handleInit clears a stale success banner', async () => {
    const el = await fixture<Updatable>(html`
      <gn-lfs-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-lfs-dialog>
    `);
    await waitForRendered(el, '.actions');

    const internal = el as unknown as {
      success: string;
      error: string;
      handleInit: () => Promise<void>;
    };
    internal.success = 'Now tracking *.psd';

    failCommands.add('init_lfs');
    try {
      await internal.handleInit();
    } finally {
      failCommands.delete('init_lfs');
    }

    expect(internal.error, 'the failure is reported').to.not.equal('');
    expect(internal.success, 'the stale success must not survive it').to.equal('');
  });

  // These dialogs stay mounted — app-shell only toggles ?open — so `success`
  // survived close/reopen, and a Ctrl+Tab in between replayed "Worktree
  // removed" above a DIFFERENT repository's untouched list.
  it('gn-worktree-dialog clears the banner when it is reopened', async () => {
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.action-btn');

    const internal = el as unknown as { success: string; open: boolean };
    internal.success = 'Worktree removed';
    await el.updateComplete;

    internal.open = false;
    await el.updateComplete;
    internal.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    expect(
      internal.success,
      'reopening must not replay a destructive operation that already finished'
    ).to.equal('');
  });

  it('gn-submodule-dialog Cancel clears the banner on the way back to the list', async () => {
    const el = await fixture<Updatable>(html`
      <gn-submodule-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-submodule-dialog>
    `);
    await waitForRendered(el, '.action-btn');

    const internal = el as unknown as { mode: string; success: string };
    internal.mode = 'add';
    internal.success = 'Submodule added successfully';
    await el.updateComplete;

    const cancel = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancel, 'the Cancel button must be rendered in add mode').to.not.be.undefined;

    cancel.click();
    await el.updateComplete;

    expect(internal.success, 'leaving the form must not carry the banner back').to.equal('');
  });
});

describe('the LFS dialog is not a dead end before .gitattributes exists', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
    lfsEnabled = true;
  });

  // "enabled" means .gitattributes exists and contains filter=lfs. The only
  // thing that writes it is `git lfs track`, whose input lived behind the same
  // `enabled` flag — while `git lfs install` (the Initialize button) writes
  // config and hooks and never touches .gitattributes. So Initialize reported
  // success forever and nothing became usable.
  it('offers the Track input on a repo with LFS installed but nothing tracked', async () => {
    lfsEnabled = false;
    const el = await fixture<Updatable>(html`
      <gn-lfs-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-lfs-dialog>
    `);
    await waitForRendered(el, '.status-section');

    const titles = Array.from(el.shadowRoot!.querySelectorAll('.section-title')).map(
      (n) => n.textContent ?? '',
    );
    expect(
      titles.some((t) => /Tracked Patterns/.test(t)),
      'the pattern list must be reachable before anything is tracked'
    ).to.be.true;

    const track = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Track',
    );
    expect(track, 'the Track button is the only way out of "Not configured"').to.not.be.undefined;

    // Pull/Prune still wait for a real LFS setup.
    expect(
      Array.from(el.shadowRoot!.querySelectorAll('button')).some((b) =>
        /Prune/i.test(b.textContent ?? ''),
      ),
      'prune stays gated on a configured repo'
    ).to.be.false;
  });
});

// `git worktree remove` refuses only the MAIN worktree — it happily removes the
// one you are standing in. This app has a second constraint git does not: the
// open repository's directory must keep existing. Opening a linked worktree is
// supported, and `git worktree list` always prints the main worktree first, so
// the open one got isMain:false and its Remove button was live.
describe('the worktree dialog will not delete the repository it has open', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
  });

  it('disables Remove for the currently-open worktree and refuses the handler', async () => {
    // The app is open ON the linked worktree, not the main one.
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${'/test/worktree-1'} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.action-btn');

    // Row 0 is the main worktree (always listed first); row 1 is the open one.
    const removes = el.shadowRoot!.querySelectorAll('.action-btn.danger');
    expect((removes[1] as HTMLButtonElement).disabled, 'the open worktree must not be removable').to
      .be.true;

    invoked.length = 0;
    await (
      el as unknown as { handleRemove: (w: { path: string; isMain: boolean }) => Promise<void> }
    ).handleRemove({ path: '/test/worktree-1', isMain: false });

    expect(invoked, 'and the handler must refuse too').to.not.include('remove_worktree');
  });
});

describe('destructive dialogs hold the shared locks', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
    invoked.length = 0;
    lfsEnabled = true;
  });

  afterEach(() => {
    resetMaintenanceLocks();
    resetRefOpLocks();
  });

  it('submodule Remove greys out and refuses while the working tree is locked', async () => {
    const el = await fixture<Updatable>(html`
      <gn-submodule-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-submodule-dialog>
    `);
    const btn = (await waitForRendered(el, '.action-btn.danger')) as HTMLButtonElement;

    await expectDisabledTracksLock(el, btn, 'submodule Remove');

    // And the handler itself refuses, for the surfaces with no disabled state.
    tryAcquireRefOp(REPO_PATH);
    invoked.length = 0;
    await (
      el as unknown as { handleRemove: (s: { name: string; path: string }) => Promise<void> }
    ).handleRemove({ name: 'lib/utils', path: 'lib/utils' });
    expect(invoked, 'no confirm and no removal while another op holds the lock').to.not.include(
      'remove_submodule',
    );
    expect(invoked, 'the irreversible warning must not even be raised').to.not.include(
      'plugin:dialog|message',
    );
  });

  it('worktree Remove greys out and refuses while the working tree is locked', async () => {
    const el = await fixture<Updatable>(html`
      <gn-worktree-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-worktree-dialog>
    `);
    await waitForRendered(el, '.action-btn.danger');
    // The FIRST danger button belongs to the main worktree, which is
    // permanently disabled (isMain); the removable one is the second.
    const btn = el.shadowRoot!.querySelectorAll('.action-btn.danger')[1] as HTMLButtonElement;
    expect(btn, 'a removable worktree row must be rendered').to.not.be.undefined;

    await expectDisabledTracksLock(el, btn, 'worktree Remove');

    tryAcquireRefOp(REPO_PATH);
    invoked.length = 0;
    await (
      el as unknown as {
        handleRemove: (w: { path: string; isMain: boolean }) => Promise<void>;
      }
    ).handleRemove({ path: '/test/worktree-1', isMain: false });
    expect(invoked, 'no removal while another op holds the lock').to.not.include('remove_worktree');
  });

  it('LFS Prune greys out and refuses while maintenance or the working tree is busy', async () => {
    const el = await fixture<Updatable>(html`
      <gn-lfs-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-lfs-dialog>
    `);
    // The prune button is the only .actions button with the "Prune" label.
    const buttons = Array.from(
      (await waitForRendered(el, '.actions')).querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const btn = buttons.find((b) => /Prune/i.test(b.textContent ?? ''));
    expect(btn, 'the Prune button must be rendered').to.not.be.undefined;

    await expectDisabledTracksLock(el, btn!, 'LFS Prune');

    tryAcquireRefOp(REPO_PATH);
    invoked.length = 0;
    await (el as unknown as { handlePrune: () => Promise<void> }).handlePrune();
    expect(invoked, 'no prune while another op holds the lock').to.not.include('lfs_prune');
    expect(invoked, 'the irreversible warning must not even be raised').to.not.include(
      'plugin:dialog|message',
    );
  });
});
