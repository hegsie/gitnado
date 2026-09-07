/**
 * Removing a worktree that still holds uncommitted or untracked work.
 *
 * git refuses and tells the user to pass --force. The dialog never exposed that
 * flag, so the flow dead-ended on a raw CLI error with no way to finish from
 * inside Gitnado. It must offer the same force escalation the branch-delete
 * paths do, and the confirm must name the work at stake.
 */

import type { Worktree } from '../../../services/git.service.ts';

const DIRTY = "fatal: '/test/worktree-1' contains modified or untracked files, use --force to delete it";

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

const removeCalls: Array<{ worktreePath?: string; force?: boolean }> = [];
/** Messages the user was shown, in order. */
const confirmMessages: string[] = [];
/** Answers handed back to each successive showConfirm. */
let confirmAnswers: boolean[] = [];
/** When set, remove_worktree fails with this instead of succeeding. */
let unforcedFailure: string | null = DIRTY;

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args?: unknown) => {
    // plugin-dialog's confirm() resolves true only for the OK button label.
    if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
      const a = (args ?? {}) as { message?: string };
      confirmMessages.push(a.message ?? '');
      return confirmAnswers.shift() ? 'Ok' : 'Cancel';
    }
    if (command === 'remove_worktree') {
      const a = (args ?? {}) as { worktreePath?: string; force?: boolean };
      removeCalls.push({ worktreePath: a.worktreePath, force: a.force });
      if (unforcedFailure !== null && !a.force) {
        throw { code: 'COMMAND_ERROR', message: unforcedFailure };
      }
      return null;
    }
    if (command === 'get_worktrees') return mockWorktrees;
    if (command === 'get_branches') return [];
    return null;
  },
};

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-worktree-dialog.ts';
import type { LvWorktreeDialog } from '../lv-worktree-dialog.ts';

describe('lv-worktree-dialog force removal', () => {
  beforeEach(() => {
    removeCalls.length = 0;
    confirmMessages.length = 0;
    confirmAnswers = [];
    unforcedFailure = DIRTY;
  });

  it('offers a force retry when git refuses a dirty worktree, and names the work at stake', async () => {
    confirmAnswers = [true, true];
    const el = await fixture<LvWorktreeDialog>(
      html`<lv-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockWorktrees[1]);

    expect(removeCalls.map((c) => c.force), 'unforced attempt, then forced').to.deep.equal([
      undefined,
      true,
    ]);
    expect(confirmMessages.length, 'a second confirm was shown').to.equal(2);
    expect(confirmMessages[1]).to.contain('modified or untracked files');
    expect(confirmMessages[1], 'says the work is discarded').to.contain('permanently discard');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error, 'no dead-end error left on screen').to.equal('');
  });

  it('declining the force retry leaves the worktree alone', async () => {
    confirmAnswers = [true, false];
    const el = await fixture<LvWorktreeDialog>(
      html`<lv-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockWorktrees[1]);

    expect(removeCalls.map((c) => c.force)).to.deep.equal([undefined]);
  });

  it('the first confirm says what removing a worktree destroys', async () => {
    confirmAnswers = [false];
    const el = await fixture<LvWorktreeDialog>(
      html`<lv-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockWorktrees[1]);

    expect(confirmMessages[0]).to.contain('working directory will be deleted');
    expect(removeCalls).to.have.length(0);
  });

  it('an unrelated failure is still reported, not silently retried with force', async () => {
    confirmAnswers = [true, true];
    unforcedFailure = 'fatal: not a valid worktree';

    const el = await fixture<LvWorktreeDialog>(
      html`<lv-worktree-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-worktree-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockWorktrees[1]);

    expect(removeCalls, 'no force retry for an unrelated error').to.have.length(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error).to.contain('not a valid worktree');
  });
});
