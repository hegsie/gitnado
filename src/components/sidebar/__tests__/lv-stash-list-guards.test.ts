/**
 * Tests for operationInProgress guards in lv-stash-list.
 *
 * Verifies that async handlers (createStash, applyStash, popStash, dropStash)
 * are protected against double-click / re-entry while an operation is
 * already in progress.
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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { LvStashList } from '../lv-stash-list.ts';

// Import the actual component
import '../lv-stash-list.ts';
// Side-effect import so showPrompt finds the singleton already in the DOM.
import '../../dialogs/lv-prompt-dialog.ts';
import type { LvPromptDialog } from '../../dialogs/lv-prompt-dialog.ts';
import { tryAcquireRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

/**
 * handleCreateStash now asks for an optional stash message, so these tests
 * install a stub that answers it immediately. '' is "OK with nothing typed",
 * which keeps git's default naming and the exact behaviour asserted below.
 */
function setupMockPrompt(value: string | null): void {
  let dialog = document.querySelector<LvPromptDialog>('lv-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('lv-prompt-dialog') as LvPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => value;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('lv-prompt-dialog');
  if (dialog) dialog.remove();
}

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeStash(overrides: Partial<{
  index: number;
  message: string;
  oid: string;
}> = {}) {
  return {
    index: overrides.index ?? 0,
    message: overrides.message ?? 'WIP on main',
    oid: overrides.oid ?? 'abc123',
  };
}

/**
 * Stash list returned by `get_stashes`. The handlers re-resolve the
 * right-clicked stash by oid against this list before acting, so a test that
 * expects an operation to RUN must seed it with that stash.
 */
let mockStashes: unknown[] = [];

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_stashes') {
    return Promise.resolve(mockStashes);
  }
  return Promise.resolve(null);
}

async function createComponent(): Promise<LvStashList> {
  mockStashes = [];
  mockInvoke = defaultMockInvoke;
  const el = await fixture<LvStashList>(
    html`<lv-stash-list .repositoryPath=${REPO_PATH}></lv-stash-list>`
  );
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-stash-list operationInProgress guards', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    setupMockPrompt('');
  });

  afterEach(() => {
    cleanupMockPrompt();
  });

  it('should have operationInProgress initially false', async () => {
    const el = await createComponent();
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('handleApplyStash should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const stash = makeStash({ index: 0 });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null } }).contextMenu = {
      visible: true, x: 0, y: 0, stash,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleApplyStash: () => Promise<void> }).handleApplyStash();

    const applyCalls = invokeCalls.filter(c => c.command === 'apply_stash');
    expect(applyCalls).to.have.length(0);
  });

  it('handlePopStash should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const stash = makeStash({ index: 1 });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null } }).contextMenu = {
      visible: true, x: 0, y: 0, stash,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handlePopStash: () => Promise<void> }).handlePopStash();

    const popCalls = invokeCalls.filter(c => c.command === 'pop_stash');
    expect(popCalls).to.have.length(0);
  });

  it('handleDropStash should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const stash = makeStash({ index: 2 });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null } }).contextMenu = {
      visible: true, x: 0, y: 0, stash,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleDropStash: () => Promise<void> }).handleDropStash();

    const dropCalls = invokeCalls.filter(c => c.command === 'drop_stash');
    expect(dropCalls).to.have.length(0);
  });

  it('handleApplyStash should set and clear operationInProgress', async () => {
    const el = await createComponent();

    let resolveApply!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'apply_stash') {
        return new Promise((resolve) => { resolveApply = resolve; });
      }
      return defaultMockInvoke(command);
    };

    const stash = makeStash({ index: 0 });
    mockStashes = [stash];
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null } }).contextMenu = {
      visible: true, x: 0, y: 0, stash,
    };

    // Start apply (won't resolve yet)
    const promise = (el as unknown as { handleApplyStash: () => Promise<void> }).handleApplyStash();

    // Should be in progress now
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(true);

    // The handler re-resolves the stash by oid (an extra awaited round trip)
    // before calling apply_stash, so let that settle before resolving it.
    await new Promise((r) => setTimeout(r, 0));

    // Resolve
    resolveApply({ success: true });
    await promise;

    // Should be cleared
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('handleApplyStash should clear operationInProgress even on error', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'apply_stash') {
        return Promise.reject(new Error('apply failed'));
      }
      return defaultMockInvoke(command);
    };

    const stash = makeStash({ index: 0 });
    mockStashes = [stash];
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null } }).contextMenu = {
      visible: true, x: 0, y: 0, stash,
    };

    try {
      await (el as unknown as { handleApplyStash: () => Promise<void> }).handleApplyStash();
    } catch {
      // expected
    }

    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('stash-applied carries the repo the apply ran on, even after a mid-op tab switch', async () => {
    // repoPath is captured BEFORE the await. If the active tab (and thus
    // .repositoryPath) rebinds while apply_stash is in flight, the event must
    // still name the origin repo so the host pins its refresh correctly.
    const el = await createComponent();

    let resolveApply!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'apply_stash') {
        return new Promise((resolve) => {
          resolveApply = resolve;
        });
      }
      return defaultMockInvoke(command);
    };

    let detail: { repositoryPath?: string } | null = null;
    el.addEventListener('stash-applied', (e) => {
      detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    });

    const stash = makeStash({ index: 0 });
    mockStashes = [stash];
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, stash };

    const promise = (
      el as unknown as { handleApplyStash: () => Promise<void> }
    ).handleApplyStash();

    // Let the oid re-resolution settle so apply_stash is actually in flight.
    await new Promise((r) => setTimeout(r, 0));

    // User switches tabs mid-apply: the prop rebinds to another repo.
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';

    resolveApply({ success: true });
    await promise;
    await el.updateComplete;

    expect(detail, 'stash-applied dispatched').to.not.be.null;
    expect(detail!.repositoryPath).to.equal(REPO_PATH);
  });

  it('handleDropStash drops from the origin repo, not the tab switched to during the confirm', async () => {
    // Dropping is irreversible and stash.index is from THIS repo's list.
    // showConfirm's await yields; a tab switch during it rebinds
    // this.repositoryPath. The drop must target the repo it was invoked on.
    const el = await createComponent();

    let resolveConfirm!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'plugin:dialog|message') {
        return new Promise((resolve) => {
          resolveConfirm = resolve;
        });
      }
      if (command === 'drop_stash') return Promise.resolve(null);
      return defaultMockInvoke(command);
    };

    const stash = makeStash({ index: 0 });
    mockStashes = [stash];
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; stash: typeof stash | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, stash };

    invokeCalls.length = 0;
    const promise = (el as unknown as { handleDropStash: () => Promise<void> }).handleDropStash();

    await new Promise((r) => setTimeout(r, 10));
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';

    resolveConfirm('Ok');
    await promise;

    const dropCall = invokeCalls.find((c) => c.command === 'drop_stash');
    expect(dropCall, 'drop_stash called').to.not.be.undefined;
    expect((dropCall!.args as { path: string }).path).to.equal(REPO_PATH);
  });

  it('handleDropStash drops the stash the user right-clicked after the list shifts', async () => {
    // Stash.index is a POSITION. Creating a stash while the context menu is
    // open (Ctrl+Shift+S does not close it) pushes every entry down one, so the
    // cached index names a different stash by the time Drop is clicked.
    const el = await createComponent();

    const target = makeStash({ index: 1, message: 'refactor WIP', oid: 'target-oid' });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; stash: typeof target | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, stash: target };

    // A new stash landed at 0, so the target now sits at index 2.
    mockStashes = [
      makeStash({ index: 0, message: 'brand new', oid: 'new-oid' }),
      makeStash({ index: 1, message: 'other', oid: 'other-oid' }),
      target,
    ];

    // Confirm the drop: plugin-dialog's confirm() resolves via
    // `plugin:dialog|message`, where the OK button label means confirmed.
    mockInvoke = (command: string) =>
      command === 'plugin:dialog|message'
        ? Promise.resolve('Ok')
        : defaultMockInvoke(command);

    invokeCalls.length = 0;
    await (el as unknown as { handleDropStash: () => Promise<void> }).handleDropStash();

    const dropCall = invokeCalls.find((c) => c.command === 'drop_stash');
    expect(dropCall, 'drop_stash called').to.not.be.undefined;
    expect(
      (dropCall!.args as { index: number }).index,
      'must drop the right-clicked stash at its CURRENT position, not the stale one'
    ).to.equal(2);
  });

  it('handleDropStash aborts when the right-clicked stash is gone', async () => {
    const el = await createComponent();

    const target = makeStash({ index: 0, message: 'gone', oid: 'gone-oid' });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; stash: typeof target | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, stash: target };

    // Someone dropped it from a terminal — it is no longer in the list.
    mockStashes = [makeStash({ index: 0, message: 'unrelated', oid: 'other-oid' })];

    // Confirm the drop: plugin-dialog's confirm() resolves via
    // `plugin:dialog|message`, where the OK button label means confirmed.
    mockInvoke = (command: string) =>
      command === 'plugin:dialog|message'
        ? Promise.resolve('Ok')
        : defaultMockInvoke(command);

    invokeCalls.length = 0;
    await (el as unknown as { handleDropStash: () => Promise<void> }).handleDropStash();

    expect(
      invokeCalls.filter((c) => c.command === 'drop_stash'),
      'must not drop a substitute stash'
    ).to.have.length(0);
  });

  it('isStashing guard prevents double createStash', async () => {
    const el = await createComponent();

    // Set isStashing to true to simulate in-flight stash creation
    (el as unknown as { isStashing: boolean }).isStashing = true;

    invokeCalls.length = 0;

    await (el as unknown as { handleCreateStash: () => Promise<void> }).handleCreateStash();

    const createCalls = invokeCalls.filter(c => c.command === 'create_stash');
    expect(createCalls).to.have.length(0);
  });

  // handleCreateStash existed but nothing rendered called it, so stashing was
  // a keyboard-only action and the panel that lists stashes offered no way to
  // make one. Being unreachable is also why it was the ONE stash handler that
  // never claimed the shared lock: `git stash push` resets the working tree to
  // HEAD and renumbers every entry, exactly what its siblings serialize for.
  it('renders a Stash Changes button that creates a stash', async () => {
    const el = await createComponent();

    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /Stash Changes/i.test(b.textContent ?? '')
    );
    expect(btn, 'the stash panel must offer a way to create a stash').to.not.be.undefined;

    invokeCalls.length = 0;
    (btn as HTMLButtonElement).click();
    // The click claims the shared lock and then invokes; under load that takes
    // more than one macrotask, so wait for the invoke itself, not a timer.
    await waitUntil(
      () => invokeCalls.some((c) => c.command === 'create_stash'),
      'the button must reach the backend'
    );

    expect(
      invokeCalls.filter((c) => c.command === 'create_stash'),
      'the button must reach the backend exactly once'
    ).to.have.length(1);
  });

  // The shortcut and the palette both toast "Stash created"; this surface
  // reloaded the list and said nothing, so the same operation reported
  // differently depending on where it was started.
  it('toasts on a successful stash, like the other stash surfaces', async () => {
    const el = await createComponent();
    mockStashes = [makeStash({ index: 0, message: 'WIP', oid: 'new-oid' })];
    mockInvoke = (command: string) =>
      command === 'create_stash'
        ? Promise.resolve({ index: 0, message: 'WIP', oid: 'new-oid' })
        : defaultMockInvoke(command);

    uiStore.setState({ toasts: [] });
    await (el as unknown as { handleCreateStash: () => Promise<void> }).handleCreateStash();

    expect(
      uiStore.getState().toasts.some((t) => /stash created/i.test(t.message)),
      'a successful stash must report itself'
    ).to.be.true;
  });

  // Create toasts, and so do branch delete and tag delete — for the same
  // reason: the only signal these ran at all was a row changing or vanishing.
  // The three siblings in this component were left out.
  for (const { handler, command, word } of [
    { handler: 'handleApplyStash', command: 'apply_stash', word: 'applied' },
    { handler: 'handlePopStash', command: 'pop_stash', word: 'popped' },
    { handler: 'handleDropStash', command: 'drop_stash', word: 'dropped' },
  ]) {
    it(`${handler} reports success`, async () => {
      const el = await createComponent();
      const target = makeStash({ index: 0, message: 'WIP', oid: 'abc123' });
      mockStashes = [target];
      (
        el as unknown as {
          contextMenu: { visible: boolean; x: number; y: number; stash: typeof target | null };
        }
      ).contextMenu = { visible: true, x: 0, y: 0, stash: target };

      mockInvoke = (c: string) =>
        c === 'plugin:dialog|message' ? Promise.resolve('Ok') : defaultMockInvoke(c);

      uiStore.setState({ toasts: [] });
      await (el as unknown as Record<string, () => Promise<void>>)[handler]();

      expect(
        invokeCalls.some((c) => c.command === command),
        `${command} ran`
      ).to.be.true;
      expect(
        uiStore.getState().toasts.some((t) => new RegExp(word, 'i').test(t.message)),
        `a successful ${word} stash must report itself`
      ).to.be.true;
    });
  }

  it('the Stash Changes button is refused and disabled while the repo is busy', async () => {
    const el = await createComponent();
    const btn = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /Stash Changes/i.test(b.textContent ?? '')
    ) as HTMLButtonElement;

    expect(btn.disabled, 'enabled while idle').to.equal(false);

    // Another surface — the graph's hard reset, say — takes the working tree.
    tryAcquireRefOp(REPO_PATH);
    await el.updateComplete;
    expect(btn.disabled, 'a claim elsewhere must disable it').to.equal(true);

    invokeCalls.length = 0;
    await (el as unknown as { handleCreateStash: () => Promise<void> }).handleCreateStash();
    expect(
      invokeCalls.filter((c) => c.command === 'create_stash'),
      'and the handler must refuse, not just the button'
    ).to.have.length(0);
  });

  // A conflict is not a failure: the stash content DID land in the working
  // tree and the resolution dialog is about to open. A red "Merge conflict"
  // beside it reads as "nothing happened".
  for (const { handler, command, word } of [
    { handler: 'handleApplyStash', command: 'apply_stash', word: 'applied' },
    { handler: 'handlePopStash', command: 'pop_stash', word: 'popped' },
  ]) {
    it(`${handler} warns rather than erroring on a conflict`, async () => {
      const el = await createComponent();
      const target = makeStash({ index: 0, message: 'WIP', oid: 'abc123' });
      mockStashes = [target];
      (
        el as unknown as {
          contextMenu: { visible: boolean; x: number; y: number; stash: typeof target | null };
        }
      ).contextMenu = { visible: true, x: 0, y: 0, stash: target };

      mockInvoke = (c: string) => {
        if (c === 'plugin:dialog|message') return Promise.resolve('Ok');
        if (c === command) {
          return Promise.reject({ code: 'MERGE_CONFLICT', message: 'Merge conflict' });
        }
        return defaultMockInvoke(c);
      };

      uiStore.setState({ toasts: [] });
      await (el as unknown as Record<string, () => Promise<void>>)[handler]();

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'error'),
        'a conflict must not be reported as a failure'
      ).to.be.false;
      expect(
        toasts.some((t) => t.type === 'warning' && new RegExp(word, 'i').test(t.message)),
        'it must say the stash landed and needs resolving'
      ).to.be.true;
    });
  }
});
