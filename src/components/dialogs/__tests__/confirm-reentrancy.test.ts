/**
 * Every destructive button must claim its in-flight flag BEFORE its confirm.
 *
 * `showConfirm` goes through `plugin:dialog|message`, an IPC round trip that
 * happens before the native dialog opens and takes focus. A flag claimed after
 * that await leaves the button live through the whole window, so a double-click
 * re-enters the handler, stacks a second prompt for the same target, and — if
 * both are accepted — runs the operation twice. The second run then fails
 * against a target that is already gone and contradicts the success the user
 * just read.
 *
 * The context-menu surfaces (branch/tag/stash lists, the graph ref menu) are
 * deliberately not covered here: they close the menu synchronously at the top
 * of the handler, so the item cannot be clicked a second time.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: string[] = [];
let confirmCount = 0;
/** Resolves the pending confirm; while set, confirms hang. */
let releaseConfirm: (() => void) | null = null;
let statusEntries: unknown[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    invoked.push(command);
    if (command === 'plugin:dialog|message') {
      confirmCount++;
      if (releaseConfirm) {
        await new Promise<void>((resolve) => {
          releaseConfirm = resolve;
        });
      }
      return 'Ok';
    }
    if (command === 'get_status') return statusEntries;
    if (command === 'get_worktrees') return [];
    if (command === 'get_submodules') return [];
    if (command === 'get_remotes') return [];
    if (command === 'get_workspaces') return [];
    if (command === 'get_lfs_status') {
      return { installed: true, version: '3.0.0', enabled: true, patterns: [] };
    }
    return null;
  },
  transformCallback: () => 0,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-worktree-dialog.ts';
import '../lv-submodule-dialog.ts';
import '../lv-lfs-dialog.ts';
import '../lv-remote-dialog.ts';
import '../lv-workspace-manager-dialog.ts';
import '../lv-reflog-dialog.ts';
import '../../sidebar/lv-file-status.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fire `call` twice with the first confirm still pending, then release it.
 * Returns how many confirm prompts were raised.
 */
async function doubleClick(call: () => Promise<void>): Promise<number> {
  confirmCount = 0;
  releaseConfirm = () => {};
  const first = call();
  await new Promise((r) => setTimeout(r, 10));
  const second = call();
  await new Promise((r) => setTimeout(r, 10));
  const release = releaseConfirm;
  releaseConfirm = null;
  release?.();
  await Promise.all([first, second]);
  return confirmCount;
}

describe('destructive buttons claim their guard before the confirm', () => {
  beforeEach(() => {
    invoked.length = 0;
    confirmCount = 0;
    releaseConfirm = null;
    statusEntries = [];
  });

  it('worktree removal', async () => {
    const el = await fixture<any>(
      html`<lv-worktree-dialog ?open=${true} .repositoryPath=${'/repo/a'}></lv-worktree-dialog>`,
    );
    await el.updateComplete;
    const wt = { path: '/repo/a/wt', branch: 'feature', isMain: false, isLocked: false };

    const prompts = await doubleClick(() => el.handleRemove(wt));

    expect(prompts, 'one prompt for one gesture').to.equal(1);
    expect(invoked.filter((c) => c === 'remove_worktree').length).to.equal(1);
  });

  it('submodule removal', async () => {
    const el = await fixture<any>(
      html`<lv-submodule-dialog ?open=${true} .repositoryPath=${'/repo/a'}></lv-submodule-dialog>`,
    );
    await el.updateComplete;
    const sm = { name: 'lib', path: 'lib', url: 'u', status: 'current', headOid: 'a', branch: null, initialized: true };

    const prompts = await doubleClick(() => el.handleRemove(sm));

    expect(prompts).to.equal(1);
    expect(invoked.filter((c) => c === 'remove_submodule').length).to.equal(1);
  });

  it('LFS prune', async () => {
    const el = await fixture<any>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/repo/a'}></lv-lfs-dialog>`,
    );
    await el.updateComplete;

    const prompts = await doubleClick(() => el.handlePrune());

    // The warning names an irreversible deletion — showing it twice for one
    // gesture is its own defect, even though the second prune is a no-op.
    expect(prompts).to.equal(1);
    expect(invoked.filter((c) => c === 'lfs_prune').length).to.equal(1);
  });

  it('remote removal', async () => {
    const el = await fixture<any>(
      html`<lv-remote-dialog ?open=${true} .repositoryPath=${'/repo/a'}></lv-remote-dialog>`,
    );
    await el.updateComplete;
    const remote = { name: 'origin', url: 'https://example.com/r.git', pushUrl: null };

    const prompts = await doubleClick(() => el.handleRemove(remote));

    expect(prompts).to.equal(1);
    expect(invoked.filter((c) => c === 'remove_remote').length).to.equal(1);
  });

  it('workspace deletion', async () => {
    const el = await fixture<any>(
      html`<lv-workspace-manager-dialog ?open=${true}></lv-workspace-manager-dialog>`,
    );
    await el.updateComplete;
    el.workspaces = [{ id: 'ws1', name: 'Team', repositories: [], color: null, description: '' }];
    el.selectedWorkspaceId = 'ws1';
    await el.updateComplete;

    const prompts = await doubleClick(() => el.handleDelete());

    expect(prompts).to.equal(1);
    expect(invoked.filter((c) => c === 'delete_workspace').length).to.equal(1);
  });

  it('the file-status discard controls', async () => {
    // The row × and the "Discard" toolbar button stay on screen through the
    // confirm — unlike the context menus, which close synchronously — so this
    // component needed the claim too and was missed by the round-29 sweep.
    statusEntries = [
      { path: 'untracked.txt', status: 'untracked', isStaged: false, isConflicted: false },
      { path: 'other.txt', status: 'untracked', isStaged: false, isConflicted: false },
    ];
    const el = await fixture<any>(
      html`<lv-file-status .repositoryPath=${'/repo/a'}></lv-file-status>`,
    );
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    el.unstagedFiles = statusEntries;
    el.selectedFiles = new Set(['untracked.txt', 'other.txt']);
    await el.updateComplete;

    const prompts = await doubleClick(() => el.handleDiscardSelected());

    expect(prompts, 'one "permanently delete" prompt, not two').to.equal(1);
    expect(invoked.filter((c) => c === 'discard_changes').length).to.equal(1);
  });

  it('reflog hard reset', async () => {
    // The one non-context-menu reset surface: its rows stay on screen through
    // the confirm, and a hard reset run twice discards uncommitted work against
    // a branch that has already moved.
    const el = await fixture<any>(
      html`<lv-reflog-dialog ?open=${true} .repositoryPath=${'/repo/a'}></lv-reflog-dialog>`,
    );
    await el.updateComplete;
    const entry = { index: 0, oid: 'abc123', shortId: 'abc123', message: 'commit', time: 0 };

    const prompts = await doubleClick(() => el.handleReset(entry, 'hard'));

    expect(prompts).to.equal(1);
    expect(invoked.filter((c) => c === 'reset_to_reflog').length).to.equal(1);
  });
});
