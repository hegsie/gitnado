/**
 * gn-branch-list store-subscription lifetime.
 *
 * connectedCallback() is async and awaits the branch load (three IPC round
 * trips, one of them walking every branch's ahead/behind). Registering the
 * repository-store subscription AFTER that await meant closing the last tab
 * inside the window ran disconnectedCallback() while `storeUnsubscribe` was
 * still undefined: the subscription was then registered on a detached element
 * that nothing could ever unsubscribe, leaking once per open/close cycle.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
/** Order of the things this test cares about, as they happened. */
const timeline: string[] = [];
/** Commands parked mid-flight until the test releases them. */
const gatedCommands = new Set<string>();
/** Every parked call, in order — the branch load fires more than one. */
const gateReleases = new Map<string, Array<() => void>>();

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string): Promise<unknown> => {
    if (command === 'get_branches') {
      timeline.push('get_branches');
    }
    if (gatedCommands.has(command)) {
      await new Promise<void>((resolve) => {
        const parked = gateReleases.get(command) ?? [];
        parked.push(resolve);
        gateReleases.set(command, parked);
      });
    }
    switch (command) {
      case 'get_branches':
      case 'get_remotes':
      case 'get_hidden_branches':
        return [];
      case 'get_branch_sort_mode':
        return 'name';
      default:
        return null;
    }
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { GnBranchList } from '../gn-branch-list.ts';
import '../gn-branch-list.ts';
import { repositoryStore } from '../../../stores/index.ts';

const REPO_PATH = '/test/repo';

async function waitForGate(command: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (gateReleases.has(command)) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`${command} never reached its gate`);
}

function release(command: string): void {
  const parked = gateReleases.get(command) ?? [];
  gatedCommands.delete(command);
  gateReleases.delete(command);
  parked.forEach((resolve) => resolve());
}

describe('gn-branch-list store subscription', () => {
  const realSubscribe = repositoryStore.subscribe;
  /** Subscriptions currently registered (any component, ours included). */
  let live = 0;

  beforeEach(() => {
    timeline.length = 0;
    gatedCommands.clear();
    gateReleases.forEach((parked) => parked.forEach((resolve) => resolve()));
    gateReleases.clear();
    live = 0;
    (repositoryStore as unknown as { subscribe: unknown }).subscribe = ((
      listener: Parameters<typeof realSubscribe>[0],
    ) => {
      live++;
      timeline.push('subscribe');
      const unsubscribe = realSubscribe.call(repositoryStore, listener);
      return () => {
        live--;
        unsubscribe();
      };
    }) as typeof realSubscribe;
  });

  afterEach(() => {
    (repositoryStore as unknown as { subscribe: unknown }).subscribe = realSubscribe;
    gateReleases.forEach((parked) => parked.forEach((resolve) => resolve()));
    gateReleases.clear();
    gatedCommands.clear();
  });

  it('subscribes before the branch load, and unsubscribes when detached mid-load', async () => {
    gatedCommands.add('get_branches');

    const el = document.createElement('gn-branch-list') as GnBranchList;
    el.repositoryPath = REPO_PATH;
    document.body.appendChild(el);

    // The load is parked: this is the window in which the last tab closes.
    await waitForGate('get_branches');
    expect(
      timeline.indexOf('subscribe'),
      'the subscription is registered before the load is awaited',
    ).to.be.greaterThan(-1);
    expect(
      timeline.indexOf('subscribe'),
      'subscribe runs before the first branch query, not after it',
    ).to.be.lessThan(timeline.indexOf('get_branches'));

    el.remove();
    release('get_branches');
    // Let the parked connectedCallback finish unwinding.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    expect(live, 'nothing stays subscribed on a detached element').to.equal(0);
  });

  it('still unsubscribes on a normal mount/unmount', async () => {
    const el = document.createElement('gn-branch-list') as GnBranchList;
    el.repositoryPath = REPO_PATH;
    document.body.appendChild(el);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(live, 'subscribed while mounted').to.be.greaterThan(0);

    el.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(live, 'released on disconnect').to.equal(0);
  });
});
