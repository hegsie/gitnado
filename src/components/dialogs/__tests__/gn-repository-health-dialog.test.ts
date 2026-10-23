/**
 * Repository Health Dialog — destructive action gating.
 *
 * `run_gc` and `run_prune` are reachable from BOTH this dialog and the command
 * palette. They remove unreachable objects irreversibly, so both surfaces must
 * gate them behind the same confirmation — a gate on only one surface just
 * moves the unguarded route rather than closing it.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
/** plugin-dialog's confirm() resolves true only for the OK button label. */
let confirmResult = true;

const defaultMockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (
    command === 'plugin:dialog|message' ||
    command === 'plugin:dialog|confirm' ||
    command === 'plugin:dialog|ask'
  ) {
    return confirmResult ? 'Ok' : 'Cancel';
  }
  if (command === 'get_repository_health') {
    return { objectCount: 10, packCount: 1, looseObjectCount: 9, repositorySize: 1024, hasReflog: true };
  }
  return null;
};

let mockInvoke: MockInvoke = defaultMockInvoke;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-repository-health-dialog.ts';
import {
  tryAcquireMaintenance,
  releaseMaintenance,
  resetMaintenanceLocks,
} from '../../../utils/maintenance-confirms.ts';
import type { GnRepositoryHealthDialog } from '../gn-repository-health-dialog.ts';

const REPO_PATH = '/test/repo';

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

async function render(): Promise<GnRepositoryHealthDialog> {
  const el = await fixture<GnRepositoryHealthDialog>(html`
    <gn-repository-health-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-repository-health-dialog>
  `);
  await el.updateComplete;
  return el;
}

interface Internal {
  runGc: (aggressive: boolean) => Promise<void>;
  runPrune: () => Promise<void>;
}

function internalOf(el: GnRepositoryHealthDialog): Internal {
  return el as unknown as Internal;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-repository-health-dialog destructive actions', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    confirmResult = true;
  });

  it('does not run GC when the confirm is declined', async () => {
    confirmResult = false;
    const el = await render();
    invokeHistory.length = 0;

    await internalOf(el).runGc(false);

    expect(findCommands('run_gc')).to.have.length(0);
  });

  it('runs GC once confirmed', async () => {
    const el = await render();
    invokeHistory.length = 0;

    await internalOf(el).runGc(false);

    expect(findCommands('run_gc')).to.have.length(1);
  });

  it('does not run prune when the confirm is declined', async () => {
    confirmResult = false;
    const el = await render();
    invokeHistory.length = 0;

    await internalOf(el).runPrune();

    expect(findCommands('run_prune')).to.have.length(0);
  });

  it('runs prune once confirmed', async () => {
    const el = await render();
    invokeHistory.length = 0;

    await internalOf(el).runPrune();

    expect(findCommands('run_prune')).to.have.length(1);
  });
});

describe('gn-repository-health-dialog deferred close', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    invokeHistory.length = 0;
    confirmResult = true;
    mockInvoke = defaultMockInvoke;
  });

  afterEach(() => {
    resetMaintenanceLocks();
    mockInvoke = defaultMockInvoke;
  });

  // Closing this dialog DESTROYS the element, so the host refuses while gc is
  // in flight. Refusing alone left it open and pinned to a repo whose tab was
  // gone — and its own guard (!pinnedRepoPath || runningAction) then allowed a
  // SECOND gc against that repo once the first finished.
  it('closes immediately when idle', async () => {
    const el = await render();
    let closed = 0;
    el.addEventListener('close', () => { closed++; });

    el.closeWhenIdle();

    expect(closed).to.equal(1);
  });

  it('defers the close until the running action lands, and blocks new ones', async () => {
    let resolveGc!: (v: unknown) => void;
    mockInvoke = async (command: string) => {
      if (command === 'run_gc') return new Promise((r) => { resolveGc = r; });
      if (command === 'plugin:dialog|message') return 'Ok';
      return null;
    };

    const el = await render();
    let closed = 0;
    el.addEventListener('close', () => { closed++; });

    const gc = internalOf(el).runGc(true);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(el.isRunning, 'gc in flight').to.be.true;

    el.closeWhenIdle();
    await el.updateComplete;
    expect(closed, 'not closed while gc runs').to.equal(0);

    // A second action must be refused while the close is pending.
    invokeHistory.length = 0;
    await internalOf(el).runPrune();
    expect(findCommands('run_prune'), 'no new action once closing').to.have.length(0);

    resolveGc(null);
    await gc;
    await el.updateComplete;

    expect(closed, 'closed once the gc landed').to.equal(1);
  });

  // gc and prune claim `runningAction` BEFORE the confirm, so a double-click
  // cannot stack two "permanently deletes unreachable objects" warnings. That
  // makes the declined confirm — and a lost claim race — two more ways out of
  // "running", and settleClosePending was wired only into the `finally`. A tab
  // closed during the confirm therefore left closePending stuck true with
  // nothing running: the dialog stayed open pinned to a repo with no tab,
  // having just promised in a toast that it would close.
  it('closes when the confirm that was up during the tab close is declined', async () => {
    let answerConfirm!: (v: unknown) => void;
    mockInvoke = async (command: string) => {
      if (command === 'plugin:dialog|message') {
        return new Promise((r) => { answerConfirm = r; });
      }
      return null;
    };

    const el = await render();
    let closed = 0;
    el.addEventListener('close', () => { closed++; });

    const gc = internalOf(el).runGc(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.isRunning, 'claimed before the confirm').to.be.true;

    // The pinned repo's tab closes while the confirm is still up.
    el.closeWhenIdle();
    await el.updateComplete;
    expect(closed, 'cannot close with an action claimed').to.equal(0);

    answerConfirm('Cancel');
    await gc;
    await el.updateComplete;

    expect(findCommands('run_gc'), 'declined, so nothing ran').to.have.length(0);
    expect(closed, 'the deferred close must still be honoured').to.equal(1);
  });

  it('closes when prune loses the maintenance claim after the tab closed', async () => {
    let answerConfirm!: (v: unknown) => void;
    mockInvoke = async (command: string) => {
      if (command === 'plugin:dialog|message') {
        return new Promise((r) => { answerConfirm = r; });
      }
      return null;
    };

    const el = await render();
    let closed = 0;
    el.addEventListener('close', () => { closed++; });

    const prune = internalOf(el).runPrune();
    await new Promise((r) => setTimeout(r, 0));

    el.closeWhenIdle();
    await el.updateComplete;
    expect(closed, 'cannot close with an action claimed').to.equal(0);

    // Another surface takes the maintenance slot while the confirm is up.
    expect(tryAcquireMaintenance(REPO_PATH), 'other surface wins the slot').to.be.true;

    answerConfirm('Ok');
    await prune;
    await el.updateComplete;

    expect(findCommands('run_prune'), 'refused, so nothing ran').to.have.length(0);
    expect(closed, 'the deferred close must still be honoured').to.equal(1);

    releaseMaintenance(REPO_PATH);
  });
});

describe('gn-repository-health-dialog maintenance lock', () => {
  beforeEach(() => {
    resetMaintenanceLocks();
    // An earlier suite swaps in a hanging gc mock; restore the default so
    // these tests are not left waiting on it.
    mockInvoke = defaultMockInvoke;
  });

  // gc/prune/fsck have two implementations — this dialog and the command
  // palette — and only this one tracked concurrency, so a palette run could
  // start a second maintenance command against the same repo. git's pid lock
  // catches gc-vs-gc with a raw error; it does not serialise gc-vs-prune.
  it('refuses to start when the palette already holds the repo', async () => {
    const el = await render();
    invokeHistory.length = 0;

    // The palette claims the slot first.
    expect(tryAcquireMaintenance(REPO_PATH)).to.be.true;

    await internalOf(el).runGc(true);

    expect(findCommands('run_gc'), 'no second gc while one is running').to.have.length(0);
  });

  it('releases the slot so the next run is allowed', async () => {
    const el = await render();
    invokeHistory.length = 0;

    await internalOf(el).runGc(false);
    expect(findCommands('run_gc')).to.have.length(1);

    // Slot released in the finally, so the palette can claim it afterwards.
    expect(tryAcquireMaintenance(REPO_PATH), 'slot free after the run').to.be.true;
    releaseMaintenance(REPO_PATH);
  });
});
