/**
 * LFS Dialog Tests
 *
 * Tests that pull and prune operations dispatch lfs-changed events.
 */

import { expect, fixture, html } from '@open-wc/testing';

let failingCommands: Set<string> = new Set();
/** Result of the app's showConfirm(); prune is gated behind it. */
let confirmResult = true;

/** Commands parked mid-flight until the test releases them. */
const gatedCommands = new Set<string>();
const gateReleases = new Map<string, () => void>();
/** Every repo path `get_lfs_status` was asked for, in order. */
const statusReads: string[] = [];
/** When set, what `get_lfs_status` answers instead of the default. */
let statusOverride: unknown = null;

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

  if (command === 'get_lfs_status') {
    statusReads.push(((args as { path?: string }) ?? {}).path ?? '');
    if (statusOverride) return statusOverride;
  }

  if (gatedCommands.has(command)) {
    await new Promise<void>((resolve) => gateReleases.set(command, resolve));
  }

  if (
    command === 'plugin:dialog|message' ||
    command === 'plugin:dialog|confirm' ||
    command === 'plugin:dialog|ask'
  ) {
    // plugin-dialog's confirm() resolves true only for the OK button label.
    return confirmResult ? 'Ok' : 'Cancel';
  }

  if (failingCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: 'Operation failed' };
  }

  switch (command) {
    case 'lfs_status':
      return { installed: true, initialized: true, patterns: [], version: '3.0.0' };
    case 'lfs_files':
      return [];
    case 'lfs_pull':
      return null;
    case 'lfs_prune':
      return 'Pruned 5 files';
    case 'lfs_init':
      return null;
    case 'lfs_track':
      return null;
    case 'lfs_untrack':
      return null;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import AFTER setting up the mock
import '../lv-lfs-dialog.ts';
import type { LvLfsDialog } from '../lv-lfs-dialog.ts';
import { resetMaintenanceLocks } from '../../../utils/maintenance-confirms.ts';
import { collectUnhandledRejections } from '../../../test-utils/unhandled-rejections.ts';

describe('lv-lfs-dialog', () => {
  beforeEach(() => {
    failingCommands = new Set();
    confirmResult = true;
    gatedCommands.clear();
    // Release anything a failed test left parked, so its handler unwinds and
    // frees the shared lock instead of poisoning every test after it.
    gateReleases.forEach((resolve) => resolve());
    gateReleases.clear();
    statusReads.length = 0;
    statusOverride = null;
    resetMaintenanceLocks();
  });

  it('renders the empty pattern state, not a rejected render, when the status carries no patterns', async () => {
    // The backend's LfsStatus always carries `patterns` (a Vec). A status
    // without it must still render — a throw inside render() rejects the whole
    // update and is charged to whichever test is running at the time.
    statusOverride = { installed: true, version: '3.0.0', enabled: false };

    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );
    await waitUntil(
      () => (el as unknown as { status: unknown }).status !== null,
      'the status never loaded',
    );

    const rejections = await collectUnhandledRejections(async () => {
      await el.updateComplete;
    });

    expect(rejections, 'the render must not reject').to.deep.equal([]);
    expect(el.shadowRoot!.querySelector('.pattern-list .empty-text')?.textContent).to.contain(
      'No patterns configured',
    );
  });

  it('renders when open', async () => {
    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    expect(el.shadowRoot!.querySelector('.dialog')).to.not.be.null;
  });

  it('dispatches lfs-changed on init', async () => {
    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleInit();

    expect(eventFired).to.be.true;
  });

  it('dispatches lfs-changed on pull', async () => {
    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handlePull();

    expect(eventFired).to.be.true;
  });

  it('dispatches lfs-changed on prune', async () => {
    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handlePrune();

    expect(eventFired).to.be.true;
  });

  it('does not prune when the confirm is declined', async () => {
    // `git lfs prune` deletes local LFS objects; blobs from a commit that was
    // never pushed have no copy anywhere else.
    confirmResult = false;

    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handlePrune();

    expect(eventFired, 'declining must not prune').to.be.false;
  });

  it('does not dispatch lfs-changed on pull failure', async () => {
    failingCommands.add('lfs_pull');

    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handlePull();

    expect(eventFired).to.be.false;
  });

  it('does not dispatch lfs-changed on prune failure', async () => {
    failingCommands.add('lfs_prune');

    const el = await fixture<LvLfsDialog>(
      html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
    );

    let eventFired = false;
    el.addEventListener('lfs-changed', () => { eventFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handlePrune();

    expect(eventFired).to.be.false;
  });

  describe('successful operations tell the user they happened', () => {
    it('Track names the pattern it added', async () => {
      // Init, Pull and Prune in this same dialog all report; Track and Untrack
      // did not, and the pattern list is long enough that a row appearing or
      // vanishing is not by itself a signal.
      const el = await fixture<LvLfsDialog>(
        html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).newPattern = '*.psd';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleTrack();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).success, 'named, and not blanked by the input clear').to.contain('*.psd');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).newPattern, 'the input is still cleared').to.equal('');
    });

    it('Untrack names the pattern it removed', async () => {
      const el = await fixture<LvLfsDialog>(
        html`<lv-lfs-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-lfs-dialog>`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleUntrack('*.bin');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).success).to.contain('*.bin');
    });
  });

  // `git lfs prune` deletes local LFS objects that were never pushed. The
  // dialog is bound to the ACTIVE repository and re-pins on every open, so
  // anything that lets it close (or re-pin) mid-prune points the completion —
  // the banner, the reload and the `lfs-changed` refresh — at a repository the
  // prune never touched.
  describe('a prune in flight owns the dialog', () => {
    const REPO_A = '/repo/a';
    const REPO_B = '/repo/b';

    /** Opens on `path` and drops the initial loads from the read log. */
    async function openOn(path: string): Promise<LvLfsDialog> {
      const el = await fixture<LvLfsDialog>(
        html`<lv-lfs-dialog ?open=${true} .repositoryPath=${path}></lv-lfs-dialog>`,
      );
      // connectedCallback loads before the pin is taken, then the open
      // transition pins and loads again.
      await waitUntil(() => statusReads.includes(path), 'the initial status load');
      expect(
        statusReads.every((p) => p === '' || p === path),
        'nothing but this repo was read while opening',
      ).to.be.true;
      statusReads.length = 0;
      return el;
    }

    function routedRepos(el: LvLfsDialog): string[] {
      const seen: string[] = [];
      el.addEventListener('lfs-changed', (e) => {
        seen.push((e as CustomEvent<{ repositoryPath?: string }>).detail?.repositoryPath ?? '');
      });
      return seen;
    }

    /** Starts a prune and returns once `lfs_prune` is in flight. */
    async function startPrune(el: LvLfsDialog): Promise<{ done: Promise<void> }> {
      gate('lfs_prune');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handlePrune() as Promise<void>;
      await waitForGate('lfs_prune');
      // Wrapped: `await`ing a promise that resolves TO a promise would chain
      // onto the parked prune and hang the test.
      return { done };
    }

    it('Escape does not close the dialog while the prune is running', async () => {
      const el = await openOn(REPO_A);
      let closes = 0;
      el.addEventListener('close', () => { closes++; });

      const { done } = await startPrune(el);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;

      expect(closes, 'objects that were never pushed are still being deleted').to.equal(0);
      expect(
        (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).disabled,
        'and the x says so, instead of looking live and doing nothing',
      ).to.be.true;

      release('lfs_prune');
      await done;
      await el.updateComplete;
      expect(
        (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).disabled,
        'and it comes back once the prune lands',
      ).to.be.false;

      // The control: once nothing is in flight, Escape dismisses as always.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;
      expect(closes, 'Escape still works when idle').to.equal(1);
    });

    it('reloads and routes the finished prune to the repo it ran on, not a repo reopened over it', async () => {
      const el = await openOn(REPO_A);
      const routed = routedRepos(el);
      const { done } = await startPrune(el);

      // The host owns ?open and can clear it without going through
      // handleClose (closing the tab does exactly that), then reopen the
      // dialog over another repository.
      el.open = false;
      await el.updateComplete;
      el.repositoryPath = REPO_B;
      el.open = true;
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      release('lfs_prune');
      await done;

      expect(
        statusReads,
        'the reopen must not re-pin under the prune, and the reload must read the repo that changed',
      ).to.deep.equal([REPO_A]);
      expect(routed, 'the host refreshes the repo whose objects were deleted').to.deep.equal([
        REPO_A,
      ]);
    });

    it('routes a track that lands after the dialog reopened elsewhere to the repo it ran on', async () => {
      // Tracking a pattern is not destructive, so the dialog does close over
      // it and legitimately re-pins on reopen. The completion must still
      // follow the path it captured.
      const el = await openOn(REPO_A);
      const routed = routedRepos(el);

      gate('lfs_track');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).newPattern = '*.psd';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = (el as any).handleTrack() as Promise<void>;
      await waitForGate('lfs_track');

      el.open = false;
      await el.updateComplete;
      el.repositoryPath = REPO_B;
      el.open = true;
      await el.updateComplete;
      await waitUntil(() => statusReads.length === 1, 'the reopened dialog to load repo B');

      release('lfs_track');
      await done;

      expect(
        statusReads,
        'the stale reload is dropped, not painted over the repository now on screen',
      ).to.deep.equal([REPO_B]);
      expect(routed, 'the host refreshes the repo the pattern was added to').to.deep.equal([
        REPO_A,
      ]);
    });
  });
});
