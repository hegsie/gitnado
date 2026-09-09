/**
 * Revert precondition failures in app-shell.
 *
 * The backend refuses a revert whose index holds staged work it would destroy
 * (staged changes, or unmerged entries left by a conflicted stash apply). Those
 * are precondition failures with nothing to resolve, so the graph's Revert
 * gesture must surface them as an error toast and leave the conflict-resolution
 * dialog shut — opening it would offer Resolve/Abort over a repository with no
 * operation in progress.
 */

const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};
const mockErrors: Record<string, { code: string; message: string }> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    if (mockErrors[command]) return Promise.reject(mockErrors[command]);
    const handler = mockResponses[command];
    return Promise.resolve(handler ? handler(args || {}) : null);
  },
  transformCallback: () => cbId++,
};

import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';
import { resetRefOpLocks } from '../utils/ref-lock.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const STAGED_CHANGES_MSG =
  'The index has staged changes. Commit or stash them before starting this operation.';
const UNMERGED_MSG = 'The index has unmerged files. Resolve them before starting this operation.';

function mockRepo(): Repository {
  return {
    path: '/repo/one',
    name: 'one',
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  } as Repository;
}

// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell revert precondition failures', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    for (const k of Object.keys(mockErrors)) delete mockErrors[k];
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    // The revert gesture confirms first. plugin-dialog's confirm() routes
    // through the 'message' command and reads the clicked button's label back.
    mockResponses['plugin:dialog|message'] = () => 'Ok';
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  for (const { name, message } of [
    { name: 'staged changes', message: STAGED_CHANGES_MSG },
    { name: 'unmerged files', message: UNMERGED_MSG },
  ]) {
    it(`toasts a ${name} refusal without opening the conflict dialog`, async () => {
      mockErrors['revert'] = { code: 'OPERATION_FAILED', message };

      const el = document.createElement('lv-app-shell') as AppShell;
      (el as any).activeRepository = { repository: mockRepo() };
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        commit: { oid: 'abc1234deadbeef', summary: 's', body: null, parentIds: ['p1'] },
      };

      await (el as any).revertCommit();

      expect(
        invokeCallArgs.some((c) => c.command === 'revert'),
        'the revert was actually attempted',
      ).to.equal(true);
      expect(
        uiStore.getState().toasts.some((t) => t.type === 'error' && t.message.includes(message)),
        `the refusal must reach the user; toasts were ${JSON.stringify(
          uiStore.getState().toasts.map((t) => t.message),
        )}`,
      ).to.equal(true);
      expect(
        dialogs.isOpen('conflict'),
        'nothing is in progress, so there is no conflict to resolve',
      ).to.not.equal(true);
    });
  }

  it('still routes a genuine revert conflict to the conflict dialog', async () => {
    mockErrors['revert'] = { code: 'REVERT_CONFLICT', message: 'Revert conflict' };

    const repo = mockRepo();
    const el = document.createElement('lv-app-shell') as AppShell;
    (el as any).activeRepository = { repository: repo };
    (el as any).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      commit: { oid: 'abc1234deadbeef', summary: 's', body: null, parentIds: ['p1'] },
    };

    await (el as any).revertCommit();

    expect(dialogs.isOpen('conflict')).to.equal(true);
    expect((el as any).conflictOperationType).to.equal('revert');
  });
});
