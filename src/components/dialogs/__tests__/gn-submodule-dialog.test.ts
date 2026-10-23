/**
 * Submodule Dialog Tests
 *
 * Tests toast notifications on success/error for submodule operations.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { Submodule } from '../../../services/git.service.ts';

const mockSubmodules: Submodule[] = [
  {
    name: 'lib/utils',
    path: 'lib/utils',
    url: 'https://github.com/test/utils.git',
    status: 'current',
    headOid: 'abc123',
    branch: 'main',
    initialized: true,
  },
];

let failingCommands: Set<string> = new Set();
/** When true, the next confirm dialog is answered with Cancel. */
let declineNextConfirm = false;
let lastUpdateSubmodulesArgs: Record<string, unknown> | null = null;

/** Commands parked mid-flight until the test releases them. */
const gatedCommands = new Set<string>();
const gateReleases = new Map<string, () => void>();
/** Every repo path `get_submodules` was asked for, in order. */
const submoduleReads: string[] = [];

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
  if (command === 'plugin:notification|is_permission_granted') return false;

  if (command === 'get_submodules') {
    submoduleReads.push(((args as { path?: string }) ?? {}).path ?? '');
  }

  if (gatedCommands.has(command)) {
    await new Promise<void>((resolve) => gateReleases.set(command, resolve));
  }

  if (command === 'update_submodules') {
    lastUpdateSubmodulesArgs = (args as Record<string, unknown>) ?? null;
  }

  if (failingCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: 'Operation failed' };
  }

  switch (command) {
    case 'get_submodules':
      return mockSubmodules;
    case 'add_submodule':
      return null;
    case 'init_submodules':
      return null;
    case 'update_submodules':
      return null;
    case 'remove_submodule':
      return null;
    // plugin-dialog 2.7 routes confirm() through `message` and returns the
    // clicked button label; 'Ok' means the user confirmed.
    case 'plugin:dialog|message':
      if (declineNextConfirm) return 'Cancel';
      return 'Ok';
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import AFTER setting up the mock
import '../gn-submodule-dialog.ts';
import type { GnSubmoduleDialog } from '../gn-submodule-dialog.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

describe('gn-submodule-dialog', () => {
  beforeEach(() => {
    failingCommands = new Set();
    lastUpdateSubmodulesArgs = null;
    gatedCommands.clear();
    // Release anything a failed test left parked, so its handler unwinds and
    // frees the shared lock instead of poisoning every test after it.
    gateReleases.forEach((resolve) => resolve());
    gateReleases.clear();
    submoduleReads.length = 0;
    resetRefOpLocks();
    const state = uiStore.getState();
    state.toasts.forEach(t => state.removeToast(t.id));
  });

  it('renders when open', async () => {
    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    const dialog = el.shadowRoot!.querySelector('.dialog');
    expect(dialog).to.not.be.null;
  });

  it('shows success toast on add', async () => {
    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).addUrl = 'https://github.com/test/new.git';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).addPath = 'lib/new';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleAdd();

    const toasts = uiStore.getState().toasts;
    const successToast = toasts.find(t => t.type === 'success');
    expect(successToast).to.not.be.undefined;
    expect(successToast!.message).to.include('Submodule added');
  });

  it('shows error toast on add failure', async () => {
    failingCommands.add('add_submodule');

    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).addUrl = 'https://github.com/test/new.git';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).addPath = 'lib/new';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleAdd();

    const toasts = uiStore.getState().toasts;
    const errorToast = toasts.find(t => t.type === 'error');
    expect(errorToast).to.not.be.undefined;
    expect(errorToast!.message).to.include('Operation failed');
  });

  it('shows success toast on remove', async () => {
    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockSubmodules[0]);

    const toasts = uiStore.getState().toasts;
    const successToast = toasts.find(t => t.type === 'success');
    expect(successToast).to.not.be.undefined;
    expect(successToast!.message).to.include('Submodule removed');
  });

  it('shows error toast on remove failure', async () => {
    failingCommands.add('remove_submodule');

    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRemove(mockSubmodules[0]);

    const toasts = uiStore.getState().toasts;
    const errorToast = toasts.find(t => t.type === 'error');
    expect(errorToast).to.not.be.undefined;
    expect(errorToast!.message).to.include('Operation failed');
  });

  it('shows success toast on update all', async () => {
    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUpdateAll();

    const toasts = uiStore.getState().toasts;
    const successToast = toasts.find(t => t.type === 'success');
    expect(successToast).to.not.be.undefined;
    expect(successToast!.message).to.include('All submodules updated');
  });

  it('shows error toast on update all failure', async () => {
    failingCommands.add('update_submodules');

    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUpdateAll();

    const toasts = uiStore.getState().toasts;
    const errorToast = toasts.find(t => t.type === 'error');
    expect(errorToast).to.not.be.undefined;
    expect(errorToast!.message).to.include('Operation failed');
  });

  it('shows error toast on init failure', async () => {
    failingCommands.add('init_submodules');

    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleInit(mockSubmodules[0]);

    const toasts = uiStore.getState().toasts;
    const errorToast = toasts.find(t => t.type === 'error');
    expect(errorToast).to.not.be.undefined;
    expect(errorToast!.message).to.include('Operation failed');
  });

  it('single update checks out the recorded commit (no --remote)', async () => {
    // Canonical `git submodule update <path>` checks out the commit recorded in
    // the superproject. The per-submodule Update button must NOT pass
    // remote:true, which would run `submodule update --remote`, advance the
    // submodule past the recorded commit and dirty the superproject.
    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUpdate(mockSubmodules[0]);

    expect(lastUpdateSubmodulesArgs).to.not.be.null;
    expect(lastUpdateSubmodulesArgs!.submodulePaths).to.deep.equal([mockSubmodules[0].path]);
    expect(lastUpdateSubmodulesArgs!.remote).to.not.equal(true);
  });

  it('shows error toast on single update failure', async () => {
    failingCommands.add('update_submodules');

    const el = await fixture<GnSubmoduleDialog>(
      html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleUpdate(mockSubmodules[0]);

    const toasts = uiStore.getState().toasts;
    const errorToast = toasts.find(t => t.type === 'error');
    expect(errorToast).to.not.be.undefined;
    expect(errorToast!.message).to.include('Operation failed');
  });

  describe('Init runs a network-gated update after the local init', () => {
    afterEach(() => {
      settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    });

    it('does not report a security-settings block a second time', async () => {
      // init_submodules is local and ungated; the follow-up update_submodules
      // is gated. checkNetworkAllowed already toasts on a block, so this
      // handler reporting it again stacked two contradictory messages on one
      // click. Every other handler in the file honours that contract.
      settingsStore.setState({ offlineMode: true });
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleInit(mockSubmodules[0]);

      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(
        messages.filter((m) => /update failed/i.test(m)).length,
        'the gate spoke for itself',
      ).to.equal(0);
    });

    it('does not call the user declining the confirm a failure', async () => {
      // A declined confirm is deliberately silent everywhere else — it is the
      // user's own decision, not an error.
      settingsStore.setState({ confirmNetworkOps: true });
      failingCommands = new Set();
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );
      declineNextConfirm = true;
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleInit(mockSubmodules[0]);
      declineNextConfirm = false;

      const messages = uiStore.getState().toasts.map((t) => t.message).join(' | ');
      expect(messages).to.not.match(/update failed/i);
    });

    it('a genuine update failure after init is still reported', async () => {
      failingCommands = new Set(['update_submodules']);
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleInit(mockSubmodules[0]);

      const messages = uiStore.getState().toasts.map((t) => t.message).join(' | ');
      expect(messages).to.match(/update failed/i);
    });
  });

  describe('successful operations tell the user they happened', () => {
    it('Init reports success', async () => {
      // Add, Remove and Update All in this same dialog all report; Init and
      // Update left the user to infer it from a status badge in a row.
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleInit(mockSubmodules[0]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).success, 'the dialog stays open, so it says so inline').to.contain(
        mockSubmodules[0].path,
      );
    });

    it('Update reports success', async () => {
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleUpdate(mockSubmodules[0]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).success).to.contain(mockSubmodules[0].path);
    });

    it('a failed Update says nothing about success', async () => {
      failingCommands = new Set(['update_submodules']);
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-submodule-dialog>`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleUpdate(mockSubmodules[0]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).success ?? '').to.equal('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).error).to.contain('Operation failed');
    });
  });

  // A removal runs `git submodule deinit -f` + `git rm -f` for seconds. The
  // dialog is bound to the ACTIVE repository and re-pins on every open, so
  // anything that lets it close (or re-pin) mid-removal points the completion
  // — the banner, the reload and the `submodules-changed` refresh — at a
  // repository the removal never touched.
  describe('a removal in flight owns the dialog', () => {
    const REPO_A = '/repo/a';
    const REPO_B = '/repo/b';

    /** Opens on `path` and drops the initial loads from the read log. */
    async function openOn(path: string): Promise<GnSubmoduleDialog> {
      const el = await fixture<GnSubmoduleDialog>(
        html`<gn-submodule-dialog ?open=${true} .repositoryPath=${path}></gn-submodule-dialog>`,
      );
      // connectedCallback loads before the pin is taken, then the open
      // transition pins and loads again.
      await waitUntil(() => submoduleReads.includes(path), 'the initial list load');
      expect(
        submoduleReads.every((p) => p === '' || p === path),
        'nothing but this repo was read while opening',
      ).to.be.true;
      submoduleReads.length = 0;
      return el;
    }

    function routedRepos(el: GnSubmoduleDialog): string[] {
      const seen: string[] = [];
      el.addEventListener('submodules-changed', (e) => {
        seen.push((e as CustomEvent<{ repositoryPath?: string }>).detail?.repositoryPath ?? '');
      });
      return seen;
    }

    /** Starts a removal and returns once `remove_submodule` is in flight. */
    async function startRemoval(el: GnSubmoduleDialog): Promise<{ done: Promise<void> }> {
      gate('remove_submodule');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handleRemove(mockSubmodules[0]) as Promise<void>;
      await waitForGate('remove_submodule');
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

      expect(closes, 'deinit + rm are still deleting a working tree').to.equal(0);
      expect(
        (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).disabled,
        'and the x says so, instead of looking live and doing nothing',
      ).to.be.true;

      release('remove_submodule');
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

      release('remove_submodule');
      await done;

      expect(
        submoduleReads,
        'the reopen must not re-pin under the removal, and the reload must read the repo that changed',
      ).to.deep.equal([REPO_A]);
      expect(routed, 'the host refreshes the repo whose index was rewritten').to.deep.equal([
        REPO_A,
      ]);
    });

    it('routes an add that lands after the dialog reopened elsewhere to the repo it ran on', async () => {
      // `submodule add` clones — also seconds — but it is not destructive, so
      // the dialog does close over it and legitimately re-pins on reopen. The
      // completion must still follow the path it captured.
      const el = await openOn(REPO_A);
      const routed = routedRepos(el);

      gate('add_submodule');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).addUrl = 'https://github.com/test/new.git';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).addPath = 'lib/new';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handleAdd() as Promise<void>;
      await waitForGate('add_submodule');

      el.open = false;
      await el.updateComplete;
      el.repositoryPath = REPO_B;
      el.open = true;
      await el.updateComplete;
      await waitUntil(() => submoduleReads.length === 1, 'the reopened dialog to load repo B');

      release('add_submodule');
      await done;

      expect(
        submoduleReads,
        'the stale reload is dropped, not painted over the repository now on screen',
      ).to.deep.equal([REPO_B]);
      expect(routed, 'the host refreshes the repo the submodule was added to').to.deep.equal([
        REPO_A,
      ]);
    });
  });
});
