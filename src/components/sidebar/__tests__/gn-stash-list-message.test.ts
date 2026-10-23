/**
 * Naming a stash from the stash panel.
 *
 * `git stash push -m` exists precisely so stashes can be told apart. This
 * surface sent `message: undefined`, so every entry fell back to git's
 * "WIP on <branch>: <sha> <subject>" — the commit the stash was based on, not
 * the stashed work — and three stashes on one branch were indistinguishable
 * before a destructive Pop/Drop.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnStashList } from '../gn-stash-list.ts';

import '../gn-stash-list.ts';
// Side-effect import so showPrompt finds the singleton already in the DOM.
import '../../dialogs/gn-prompt-dialog.ts';
import type { GnPromptDialog } from '../../dialogs/gn-prompt-dialog.ts';
import { resetRefOpLocks, isRefOpRunning } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

interface PromptRecord {
  count: number;
  lastTitle: string;
}

/** Stubs the themed prompt so it resolves with `value` instead of waiting. */
function setupMockPrompt(value: string | null): PromptRecord {
  let dialog = document.querySelector<GnPromptDialog>('gn-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('gn-prompt-dialog') as GnPromptDialog;
    document.body.appendChild(dialog);
  }
  const record: PromptRecord = { count: 0, lastTitle: '' };
  dialog.open = async (options: { title: string }) => {
    record.count += 1;
    record.lastTitle = options.title;
    return value;
  };
  return record;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('gn-prompt-dialog');
  if (dialog) dialog.remove();
}

const NEW_STASH = { index: 0, message: 'On main: x', oid: 'new-oid' };
let mockStashes: unknown[] = [NEW_STASH];

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_stashes') return Promise.resolve(mockStashes);
  if (command === 'create_stash') return Promise.resolve(NEW_STASH);
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnStashList> {
  mockStashes = [NEW_STASH];
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnStashList>(
    html`<gn-stash-list .repositoryPath=${REPO_PATH}></gn-stash-list>`
  );
  await el.updateComplete;
  invokeCalls.length = 0;
  return el;
}

function createStashCalls(): Array<{ command: string; args?: unknown }> {
  return invokeCalls.filter((c) => c.command === 'create_stash');
}

function messageOf(call: { args?: unknown }): string | undefined {
  return (call.args as { message?: string }).message;
}

async function runCreateStash(el: GnStashList): Promise<void> {
  await (el as unknown as { handleCreateStash: () => Promise<void> }).handleCreateStash();
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-stash-list stash message', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanupMockPrompt();
    resetRefOpLocks();
  });

  it('sends the typed message to create_stash', async () => {
    const el = await createComponent();
    setupMockPrompt('refactor parser');

    await runCreateStash(el);

    const calls = createStashCalls();
    expect(calls, 'the stash must still be created').to.have.length(1);
    expect(messageOf(calls[0]), 'the name the user typed must reach git').to.equal(
      'refactor parser'
    );
  });

  it('asks for a name and keeps git default naming when nothing is typed', async () => {
    const el = await createComponent();
    const prompt = setupMockPrompt('   ');

    await runCreateStash(el);

    expect(prompt.count, 'the user must be asked for a name').to.equal(1);
    expect(prompt.lastTitle).to.equal('Stash Changes');

    const calls = createStashCalls();
    expect(calls, 'an empty message must still stash').to.have.length(1);
    expect(
      messageOf(calls[0]),
      'whitespace is not a name — the backend must fall back to git’s WIP'
    ).to.equal(undefined);
  });

  it('creates nothing and frees the shared lock when the prompt is cancelled', async () => {
    const el = await createComponent();
    setupMockPrompt(null);

    await runCreateStash(el);

    expect(createStashCalls(), 'a dismissed prompt must not stash').to.have.length(0);
    expect(isRefOpRunning(REPO_PATH), 'a stuck lock would wedge the repo').to.equal(false);
    expect((el as unknown as { isStashing: boolean }).isStashing).to.equal(false);
    expect(
      uiStore.getState().toasts.some((t) => /stash created/i.test(t.message)),
      'nothing was created, so nothing may claim it was'
    ).to.equal(false);
  });

  it('reports and releases when the backend fails after naming', async () => {
    const el = await createComponent();
    setupMockPrompt('wip parser');
    mockInvoke = (command: string) =>
      command === 'create_stash'
        ? Promise.reject({ code: 'COMMAND_ERROR', message: 'disk full' })
        : defaultMockInvoke(command);

    await runCreateStash(el);

    const calls = createStashCalls();
    expect(calls).to.have.length(1);
    expect(messageOf(calls[0])).to.equal('wip parser');
    expect(
      uiStore.getState().toasts.some((t) => /disk full/i.test(t.message)),
      'the failure must be reported'
    ).to.equal(true);
    expect(isRefOpRunning(REPO_PATH), 'the lock must be released on failure too').to.equal(false);
  });
});
