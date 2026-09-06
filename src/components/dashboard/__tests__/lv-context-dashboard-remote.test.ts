/**
 * The dashboard's Fetch / Pull / Push buttons.
 *
 * These are the only mouse-reachable route to the three operations the
 * shortcuts and the command palette also expose, and they had drifted: no
 * progress row at all, so a slow push showed nothing but a disabled button;
 * an in-flight flag private to this component, so a fetch started anywhere
 * else was invisible here and the two reached IPC together; failures reported
 * without the recovery action the other surface offered.
 *
 * They now call the shared runner in remote-operations.service, which is what
 * these tests are really pinning: the same locks, the same progress row and
 * the same reporting as every other surface.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: Array<{ command: string; args?: unknown }> = [];
let failures = new Map<string, { code?: string; message: string }>();

/** Commands parked until the test releases them, to hold an operation open. */
let parked = new Map<string, Array<(value: unknown) => void>>();

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push({ command, args });
    const failure = failures.get(command);
    if (failure) return Promise.reject(failure);
    const waiting = parked.get(command);
    if (waiting) {
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    }
    if (command === 'get_remote_status') {
      return Promise.resolve({ ahead: 0, behind: 0 });
    }
    return Promise.resolve(null);
  },
  transformCallback: () => 0,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-context-dashboard.ts';
import type { LvContextDashboard } from '../lv-context-dashboard.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { progressService } from '../../../services/progress.service.ts';
import { runFetch } from '../../../services/remote-operations.service.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = {
  path: '/repo/a',
  name: 'repo-a',
  isValid: true,
  isBare: false,
  headRef: 'refs/heads/main',
  state: 'clean',
  isShallow: false,
  isPartialClone: false,
  cloneFilter: null,
};

async function dashboard(): Promise<LvContextDashboard> {
  repositoryStore.setState({
    openRepositories: [
      {
        repository: REPO,
        branches: [],
        currentBranch: null,
        remotes: [],
        tags: [],
        stashes: [],
      },
    ] as any,
    activeIndex: 0,
  } as any);
  const el = await fixture<LvContextDashboard>(
    html`<lv-context-dashboard></lv-context-dashboard>`,
  );
  await el.updateComplete;
  return el;
}

function toastText(): string {
  return uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`).join(' | ');
}

function counts(command: string): number {
  return invoked.filter((c) => c.command === command).length;
}

/** Park `command` so the operation that calls it stays in flight. */
function hang(command: string): void {
  parked.set(command, []);
}

/** Let every parked call of `command` finish successfully. */
function release(command: string): void {
  for (const resolve of parked.get(command) ?? []) resolve(null);
  parked.delete(command);
}

/**
 * Wait until `command` has been sent.
 *
 * git.service resolves the remote, checks the security gate and looks up a
 * credential before it reaches `invoke`, each behind its own await.
 */
function sent(command: string): Promise<void> {
  return waitUntil(() => counts(command) > 0, `Timed out waiting for ${command}`);
}

/**
 * The app-shell element the runner opens the conflict dialog through.
 *
 * `merge-conflict` is bound on that element, not on window, so the runner
 * dispatches it there — the same lookup git.service's late-pull path uses.
 */
function mountShell(): HTMLElement {
  const shell = document.createElement('lv-app-shell');
  document.body.appendChild(shell);
  return shell;
}

describe('dashboard remote operations', () => {
  let shell: HTMLElement;

  beforeEach(() => {
    invoked.length = 0;
    failures = new Map();
    parked = new Map();
    resetRefOpLocks();
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    shell = mountShell();
  });

  afterEach(() => {
    shell.remove();
    resetRefOpLocks();
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  it('leaves the success message to the backend event', async () => {
    // The Rust command emits `remote-operation-completed` and
    // setupRemoteOperationListeners toasts it, naming the remote. These
    // handlers adding their own stacked two messages on one click — the rule
    // the toolbar handlers already follow and document.
    const el = await dashboard();
    uiStore.setState({ toasts: [] });

    await (el as any).handleFetch();

    const successes = uiStore.getState().toasts.filter((t) => t.type === 'success');
    expect(successes.length, 'exactly one owner of the message').to.equal(0);
  });

  it('a rejected push offers the recovery action instead of a raw message', async () => {
    // The toolbar's Push routes through the suggestion service so a rejection
    // becomes a Pull Now button. Reaching the identical operation from the
    // dashboard must not silently drop that.
    const el = await dashboard();
    failures.set('push', {
      code: 'COMMAND_ERROR',
      message: 'Updates were rejected: non-fast-forward',
    });
    uiStore.setState({ toasts: [] });

    await (el as any).handlePush();

    const toast = uiStore.getState().toasts.find((t) => t.type === 'error');
    expect(toast, 'the failure is reported').to.not.be.undefined;
    expect(toast!.action?.label, 'with the action the app already implements').to.equal('Pull Now');
  });

  it('a pull that conflicts opens the conflict dialog rather than dead-ending', async () => {
    const el = await dashboard();
    failures.set('pull', { code: 'MERGE_CONFLICT', message: 'conflicts in 2 files' });
    uiStore.setState({ toasts: [] });

    let detail: { repositoryPath?: string; operationType?: string } | null = null;
    const handler = (e: Event): void => {
      detail = (e as CustomEvent<{ repositoryPath?: string; operationType?: string }>).detail;
    };
    shell.addEventListener('merge-conflict', handler);
    try {
      await (el as any).handlePull();
    } finally {
      shell.removeEventListener('merge-conflict', handler);
    }

    expect(detail, 'the resolution dialog is asked for').to.not.be.null;
    expect(detail!.repositoryPath).to.equal('/repo/a');
    expect(detail!.operationType).to.equal('merge');
    expect(toastText(), 'and it is not reported as a red failure').to.not.contain('error:');
  });

  it('a rebasing pull that conflicts asks for the rebase flavour of the dialog', async () => {
    const el = await dashboard();
    failures.set('pull', { code: 'REBASE_CONFLICT', message: 'conflicts in 1 file' });
    uiStore.setState({ toasts: [] });

    let detail: { operationType?: string } | null = null;
    const handler = (e: Event): void => {
      detail = (e as CustomEvent<{ operationType?: string }>).detail;
    };
    shell.addEventListener('merge-conflict', handler);
    try {
      await (el as any).handlePull();
    } finally {
      shell.removeEventListener('merge-conflict', handler);
    }

    // Continuing a rebase is not committing a merge — the dialog's Complete and
    // Abort actions differ, so the type has to travel with the event.
    expect(detail!.operationType).to.equal('rebase');
  });

  it('a security-gate block is not reported back as an error', async () => {
    const el = await dashboard();
    settingsStore.setState({ offlineMode: true });
    uiStore.setState({ toasts: [] });

    await (el as any).handleFetch();

    expect(
      uiStore.getState().toasts.some((t) => t.type === 'error'),
      "the user's own offline setting is not a failure",
    ).to.equal(false);
    expect(invoked.some((c) => c.command === 'fetch')).to.equal(false);
  });

  it('shows a progress row for the whole operation', async () => {
    // The dashboard never called progressService at all, so a slow push showed
    // nothing but a disabled button while the shortcut's identical push showed
    // a labelled row.
    const el = await dashboard();
    hang('push');
    const running = (el as any).handlePush();
    await sent('push');

    expect(progressService.getOperations().map((op) => op.message)).to.deep.equal([
      'Pushing to remote...',
    ]);

    release('push');
    await running;
    expect(progressService.getOperations(), 'and torn down when it lands').to.have.lengthOf(0);
  });

  it('coalesces with an operation started from another surface', async () => {
    // The old guard was a component-local `isFetching`, which a fetch started
    // by Ctrl+Shift+F or the command palette could not set — so both reached
    // IPC and the backend refused the second with a RemoteOperationInFlight
    // error the user did nothing to deserve.
    const el = await dashboard();
    hang('fetch');
    const fromShortcut = runFetch('/repo/a');
    await sent('fetch');

    await (el as any).handleFetch();
    expect(counts('fetch'), 'no duplicate command').to.equal(1);

    release('fetch');
    await fromShortcut;
  });

  it('disables its three buttons while any surface is fetching, and spins the right one', async () => {
    const el = await dashboard();
    hang('fetch');
    const fromShortcut = runFetch('/repo/a');
    await sent('fetch');
    await el.updateComplete;

    const buttons = Array.from(
      el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.remote-btn'),
    );
    expect(buttons, 'Fetch, Pull and Push').to.have.lengthOf(3);
    expect(
      buttons.every((b) => b.disabled),
      'a dead control that only raises a refusal toast is what this removes',
    ).to.equal(true);
    expect(
      buttons.filter((b) => b.classList.contains('loading')).map((b) => b.textContent?.trim()),
      'the running operation is the one that spins',
    ).to.deep.equal(['Fetch']);

    release('fetch');
    await fromShortcut;
    await el.updateComplete;
    expect(
      Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.remote-btn')).some(
        (b) => b.disabled,
      ),
      'and they come back when it finishes',
    ).to.equal(false);
  });

  it('asks for a refresh of the repo the button was clicked in', async () => {
    // Pinned by path: a fetch is slow, and the user can switch tabs while it
    // runs. app-shell answers this by refreshing that repository — the branch
    // list, the graph, the search index and these badges.
    const el = await dashboard();
    const seen: Array<string | undefined> = [];
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<{ repoPath?: string }>).detail?.repoPath);
    };
    window.addEventListener('remote-operation-refresh', listener);
    try {
      await (el as any).handleFetch();
    } finally {
      window.removeEventListener('remote-operation-refresh', listener);
    }
    expect(seen).to.deep.equal(['/repo/a']);
  });

  // ── cancellation ─────────────────────────────────────────────────────────
  //
  // These are the most visible fetch/pull/push buttons in the app and they
  // showed no progress row at all, so the whole cancellation flow was
  // unreachable from them even once the backend supported it.

  describe('cancellation', () => {
    for (const op of ['fetch', 'pull', 'push'] as const) {
      const handler = `handle${op[0].toUpperCase()}${op.slice(1)}`;

      it(`${op} shows a cancellable row and passes its id to the backend`, async () => {
        const service = progressService;
        const rows: Array<{ id: string; cancellable?: boolean }> = [];
        const unsubscribe = service.subscribe((ops) => {
          for (const o of ops) if (!rows.some((r) => r.id === o.id)) rows.push({ ...o });
        });
        try {
          const el = await dashboard();
          await (el as any)[handler]();

          const call = invoked.find((c) => c.command === op);
          expect(call, `${op} invoked`).to.not.be.undefined;
          const operationId = (call!.args as { operationId?: string }).operationId;
          expect(
            rows.some((r) => r.id === operationId && r.cancellable === true),
            `${op} must run under a cancellable row the backend can find`,
          ).to.equal(true);
        } finally {
          unsubscribe();
        }
      });

      it(`${op} removes its row when it finishes`, async () => {
        const service = progressService;
        const el = await dashboard();

        await (el as any)[handler]();

        expect(
          service.getOperations().length,
          `${op} must not leave a spinner behind`,
        ).to.equal(0);
      });

      it(`a cancelled ${op} says so instead of showing a failure`, async () => {
        failures.set(op, { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' });
        const el = await dashboard();
        uiStore.setState({ toasts: [] });

        await (el as any)[handler]();

        expect(
          uiStore.getState().toasts.some((t) => t.type === 'error'),
          `a cancelled ${op} is not a red failure`,
        ).to.equal(false);
        expect(toastText()).to.match(/cancelled/i);
      });

      it(`a genuine ${op} failure is still reported as one`, async () => {
        failures.set(op, { code: 'COMMAND_ERROR', message: 'remote hung up' });
        const el = await dashboard();
        uiStore.setState({ toasts: [] });

        await (el as any)[handler]();

        expect(toastText()).to.contain('remote hung up');
        expect(
          progressService.getOperations().length,
          'the row is cleared on failure too',
        ).to.equal(0);
      });
    }
  });
});
