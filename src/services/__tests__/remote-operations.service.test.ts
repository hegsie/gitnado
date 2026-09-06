/**
 * The shared fetch / pull / push runner.
 *
 * There used to be two implementations of these three operations — app-shell's
 * (shortcuts + command palette) and the context dashboard's three buttons —
 * and they disagreed about locking, progress and error reporting. These tests
 * pin the behaviour BOTH surfaces now get, because both call this module: one
 * IPC call per gesture no matter how many surfaces ask, a progress row for the
 * whole duration, a user-visible failure on every error path, and a refresh
 * pinned to the repository the operation ran on.
 */

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
    if (command === 'get_remote_status') return Promise.resolve({ ahead: 0, behind: 0 });
    return Promise.resolve(null);
  },
  transformCallback: () => 0,
};

import { expect, waitUntil } from '@open-wc/testing';
import {
  runFetch,
  runPull,
  runPush,
  runningRemoteOperation,
  isRemoteOperationRunning,
  remoteSlotKey,
} from '../remote-operations.service.ts';
import { progressService } from '../progress.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import { uiStore } from '../../stores/ui.store.ts';
import {
  isRefOpRunning,
  isPushRunning,
  resetRefOpLocks,
  tryAcquirePush,
  releasePush,
  tryAcquireRefOp,
  releaseRefOp,
} from '../../utils/ref-lock.ts';

const REPO = '/repo/a';

/** Park `command` so the operation that calls it stays in flight. */
function hang(command: string): void {
  parked.set(command, []);
}

/** Let every parked call of `command` finish successfully. */
function release(command: string): void {
  for (const resolve of parked.get(command) ?? []) resolve(null);
  parked.delete(command);
}

function counts(command: string): number {
  return invoked.filter((c) => c.command === command).length;
}

/**
 * Wait until `command` has been sent `times` times.
 *
 * git.service resolves the remote, checks the security gate and looks up a
 * credential before it reaches `invoke`, each behind its own await, so "the
 * command has been sent" is several turns away from the call.
 */
function sent(command: string, times = 1): Promise<void> {
  return waitUntil(() => counts(command) >= times, `${command} x${times}`);
}

function errorToasts(): string[] {
  return uiStore
    .getState()
    .toasts.filter((t) => t.type === 'error')
    .map((t) => t.message);
}

function progressMessages(): string[] {
  return progressService.getOperations().map((op) => op.message);
}

describe('remote operations runner', () => {
  beforeEach(() => {
    invoked.length = 0;
    failures = new Map();
    parked = new Map();
    resetRefOpLocks();
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    resetRefOpLocks();
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  describe('coalescing across surfaces', () => {
    it('refuses a second fetch while one is in flight, instead of a second IPC call', async () => {
      // The dashboard's Fetch guarded on a component-local `isFetching` flag no
      // other surface could see, so a palette fetch and a dashboard fetch both
      // reached IPC — where the backend's per-repo registry refused the second
      // with "A fetch is already running for this repository".
      hang('fetch');
      const first = runFetch(REPO);
      await sent('fetch');

      // The awaited call is the whole story: a refused operation returns
      // before anything is scheduled, and one that slipped past the lock
      // would block here on the parked fetch.
      await runFetch(REPO);
      expect(counts('fetch'), 'the second is coalesced, not duplicated').to.equal(1);

      release('fetch');
      await first;
    });

    it('refuses a pull and a push while a fetch is in flight', async () => {
      // ONE slot for all three, mirroring the backend registry: a pull moves
      // HEAD under a push that is reading refs, and a pruning fetch rewrites
      // the refs a pull just resolved.
      hang('fetch');
      const first = runFetch(REPO);
      await sent('fetch');

      // As above: refused, both return with nothing in flight.
      await runPull(REPO);
      await runPush(REPO);

      expect(counts('pull'), 'no pull behind the fetch').to.equal(0);
      expect(counts('push'), 'no push behind the fetch').to.equal(0);

      release('fetch');
      await first;
    });

    it('runs the same operation again once the first one finishes', async () => {
      await runFetch(REPO);
      await runFetch(REPO);
      expect(counts('fetch')).to.equal(2);
      expect(isRemoteOperationRunning(REPO), 'the slot is free again').to.equal(false);
    });

    it('serializes per repository, not globally', async () => {
      hang('fetch');
      const first = runFetch(REPO);
      await sent('fetch');

      // A second repository has its own working tree and its own backend slot.
      const second = runFetch('/repo/b');
      await sent('fetch', 2);

      release('fetch');
      await Promise.all([first, second]);
    });

    it('says so when a pull is refused, and stays silent for a repeated fetch', async () => {
      // Ctrl+Shift+F has no e.repeat guard, so HOLDING it fires many times a
      // second — one refusal toast per repeat is the noise the lock exists to
      // remove. A pull is a deliberate single gesture, so its refusal speaks.
      hang('fetch');
      const first = runFetch(REPO);
      await sent('fetch');
      uiStore.setState({ toasts: [] });

      await runFetch(REPO);
      expect(uiStore.getState().toasts, 'a repeated fetch is silent').to.have.lengthOf(0);

      await runPull(REPO);
      expect(
        uiStore.getState().toasts.map((t) => t.message).join(' '),
        'a refused pull says why',
      ).to.contain('Another operation is already running');

      release('fetch');
      await first;
    });
  });

  describe('the locks each operation holds', () => {
    it('a pull holds the working-tree lock, so a checkout cannot run beside it', async () => {
      // Its fast-forward runs checkout_tree and its merge and rebase paths
      // rewrite the tree outright.
      hang('pull');
      const running = runPull(REPO);
      await sent('pull');
      expect(isRefOpRunning(REPO), 'the sidebar lists are gated too').to.equal(true);

      release('pull');
      await running;
      expect(isRefOpRunning(REPO), 'and released when it lands').to.equal(false);
    });

    it('a fetch does NOT hold the working-tree lock', async () => {
      // It touches no working tree, so it must not grey out every checkout.
      hang('fetch');
      const running = runFetch(REPO);
      await sent('fetch');
      expect(isRefOpRunning(REPO)).to.equal(false);
      expect(isRemoteOperationRunning(REPO), 'but it does hold the remote slot').to.equal(true);

      release('fetch');
      await running;
    });

    it('a push holds the push slot, so Force Push cannot race it', async () => {
      // app-shell holds this same slot across the "this replaces <branch> on
      // the remote" confirm.
      hang('push');
      const running = runPush(REPO);
      await sent('push');
      expect(isPushRunning(REPO)).to.equal(true);

      release('push');
      await running;
      expect(isPushRunning(REPO)).to.equal(false);
    });

    it('releases every lock when the operation fails', async () => {
      failures.set('pull', { code: 'COMMAND_ERROR', message: 'host unreachable' });
      await runPull(REPO);

      expect(isRefOpRunning(REPO), 'working-tree lock released').to.equal(false);
      expect(isPushRunning(remoteSlotKey(REPO)), 'remote slot released').to.equal(false);
      expect(isRemoteOperationRunning(REPO)).to.equal(false);
    });

    it('gives up the remote slot when the push slot is already taken', async () => {
      // A force push raised from a suggestion toast holds the push slot across
      // its confirm — it is not routed through this runner, so it holds only
      // that slot. A push refused behind it must not strand the shared remote
      // slot, or the repository would be wedged for the rest of the session.
      expect(tryAcquirePush(REPO), 'stand in for the force push').to.equal(true);
      try {
        await runPush(REPO);
        expect(counts('push'), 'the plain push never reached IPC').to.equal(0);
        expect(
          isRemoteOperationRunning(REPO),
          'and it left nothing holding the repository',
        ).to.equal(false);
      } finally {
        releasePush(REPO);
      }

      // Proof the repo is usable again the moment the force push finishes.
      await runFetch(REPO);
      expect(counts('fetch')).to.equal(1);
    });

    it('a working-tree operation elsewhere blocks a pull, not a fetch', async () => {
      // A sidebar checkout holds the working-tree lock. A pull rewrites that
      // same tree; a fetch does not touch it.
      expect(tryAcquireRefOp(REPO), 'stand in for a sidebar checkout').to.equal(true);
      try {
        await runPull(REPO);
        expect(counts('pull'), 'the pull waits for the checkout').to.equal(0);

        await runFetch(REPO);
        expect(counts('fetch'), 'the fetch does not').to.equal(1);
      } finally {
        releaseRefOp(REPO);
      }
    });
  });

  describe('the progress row', () => {
    it('shows a row for the whole operation and clears it on success', async () => {
      // The dashboard's buttons never called progressService at all, so a slow
      // push showed nothing but a disabled button.
      hang('push');
      const running = runPush(REPO);
      await sent('push');
      expect(progressMessages()).to.deep.equal(['Pushing to remote...']);

      release('push');
      await running;
      expect(progressMessages(), 'and it is torn down when the push lands').to.deep.equal([]);
    });

    it('clears the row on failure too', async () => {
      failures.set('fetch', { code: 'COMMAND_ERROR', message: 'host unreachable' });
      await runFetch(REPO);
      expect(progressMessages(), 'no row is left spinning forever').to.deep.equal([]);
    });

    it('names the operation that is running', async () => {
      hang('fetch');
      const running = runFetch(REPO);
      await sent('fetch');
      expect(progressService.getOperations()[0].type).to.equal('fetch');
      // Same value the dashboard button reads for its spinner, so both
      // surfaces show the same operation.
      expect(runningRemoteOperation(REPO)).to.equal('fetch');

      release('fetch');
      await running;
      expect(runningRemoteOperation(REPO)).to.equal(undefined);
    });
  });

  /**
   * The runner is the ONLY thing that starts these three rows, so it is the
   * only thing that can make them cancellable. A row without
   * `{cancellable: true}` renders no Cancel button, and a command without the
   * row's `operationId` is not registered with the backend's cancellation
   * registry — so `cancel_operation` has nothing to stop. Both surfaces get
   * these because both go through here.
   */
  describe('cancellation', () => {
    for (const [kind, run] of [
      ['fetch', runFetch],
      ['pull', runPull],
      ['push', runPush],
    ] as const) {
      it(`${kind} runs under a cancellable row whose id reaches the backend`, async () => {
        hang(kind);
        const ids: string[] = [];
        const unsubscribe = progressService.subscribe((ops) => {
          for (const op of ops) if (!ids.includes(op.id)) ids.push(op.id);
        });
        try {
          const running = run(REPO);
          await sent(kind);

          const row = progressService.getOperations()[0];
          expect(row?.cancellable, `${kind}'s row must render the Cancel button`).to.equal(true);

          const args = invoked.find((c) => c.command === kind)?.args as
            | { operationId?: string }
            | undefined;
          expect(
            args?.operationId,
            `${kind} must hand the backend the very id the row was started with`,
          ).to.equal(row.id);
          expect(ids).to.contain(row.id);

          release(kind);
          await running;
        } finally {
          unsubscribe();
        }
      });

      it(`a cancelled ${kind} says the cancel took effect instead of failing`, async () => {
        failures.set(kind, { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' });
        await run(REPO);

        expect(errorToasts(), `a cancel the user asked for is not a red ${kind} failure`)
          .to.deep.equal([]);
        expect(
          uiStore.getState().toasts.map((t) => t.message),
          'the row vanishing needs an explanation',
        ).to.deep.equal([`${kind[0].toUpperCase()}${kind.slice(1)} cancelled`]);
        expect(progressMessages(), 'and no row is left behind').to.deep.equal([]);
      });

      it(`a cancelled ${kind} releases every lock it held`, async () => {
        // Leaking a lock on cancellation wedges the repository until the app
        // restarts — worse than not being able to cancel at all.
        failures.set(kind, { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' });
        await run(REPO);
        expect(isRemoteOperationRunning(REPO), 'the shared slot').to.equal(false);
        expect(isRefOpRunning(REPO), 'the working-tree lock').to.equal(false);
        expect(isPushRunning(REPO), 'the push slot').to.equal(false);

        failures.delete(kind);
        invoked.length = 0;
        await run(REPO);
        expect(counts(kind), `a retry after a cancelled ${kind} is not refused`).to.equal(1);
      });
    }

    it('a genuine failure is still a failure now that OPERATION_CANCELLED exists', async () => {
      failures.set('fetch', { code: 'COMMAND_ERROR', message: 'host unreachable' });
      await runFetch(REPO);
      expect(errorToasts().join(' ')).to.contain('host unreachable');
    });
  });

  describe('reporting', () => {
    it('reports a failure with the recovery action the app implements', async () => {
      failures.set('push', {
        code: 'COMMAND_ERROR',
        message: 'Updates were rejected: non-fast-forward',
      });
      await runPush(REPO);

      const toast = uiStore.getState().toasts.find((t) => t.type === 'error');
      expect(toast, 'the failure is reported').to.not.be.undefined;
      expect(toast!.action?.label).to.equal('Pull Now');
    });

    it('reports a failure with no suggestion as a plain error, never silently', async () => {
      failures.set('fetch', { code: 'COMMAND_ERROR', message: 'something went wrong' });
      await runFetch(REPO);
      expect(errorToasts()).to.deep.equal(['something went wrong']);
    });

    it('does not report a security-gate refusal back as an error', async () => {
      // The gate toasts its own reason, and a declined confirm is the user's
      // own decision.
      settingsStore.setState({ offlineMode: true });
      await runFetch(REPO);

      expect(errorToasts(), "the user's own setting is not a failure").to.deep.equal([]);
      expect(counts('fetch'), 'and nothing reached the backend').to.equal(0);
    });

    it('leaves the success message to the backend event', async () => {
      await runFetch(REPO);
      expect(
        uiStore.getState().toasts.filter((t) => t.type === 'success'),
        'remote-operation-completed already toasts it, naming the remote',
      ).to.have.lengthOf(0);
    });

    it('asks for a refresh of the repo the operation ran on', async () => {
      const seen: Array<string | undefined> = [];
      const listener = (e: Event): void => {
        seen.push((e as CustomEvent<{ repoPath?: string }>).detail?.repoPath);
      };
      window.addEventListener('remote-operation-refresh', listener);
      try {
        await runFetch(REPO);
      } finally {
        window.removeEventListener('remote-operation-refresh', listener);
      }
      // Pinned by path, not "the active tab": a fetch is slow and the user can
      // switch tabs while it runs.
      expect(seen).to.deep.equal([REPO]);
    });

    it('does not ask for a refresh when the operation failed', async () => {
      let refreshes = 0;
      const listener = (): void => {
        refreshes += 1;
      };
      window.addEventListener('remote-operation-refresh', listener);
      try {
        failures.set('push', { code: 'COMMAND_ERROR', message: 'rejected' });
        await runPush(REPO);
      } finally {
        window.removeEventListener('remote-operation-refresh', listener);
      }
      expect(refreshes).to.equal(0);
    });
  });

  describe('a pull that produced conflicts', () => {
    let shell: HTMLElement;

    beforeEach(() => {
      // `merge-conflict` is bound on the app-shell ELEMENT, not on window.
      shell = document.createElement('lv-app-shell');
      document.body.appendChild(shell);
    });

    afterEach(() => {
      shell.remove();
    });

    it('opens the resolution dialog instead of reporting a red failure', async () => {
      // The pull LANDED: MERGE_HEAD is on disk and the only way out is the
      // dialog's Complete/Abort. "Pull failed" reads as "nothing happened".
      failures.set('pull', { code: 'MERGE_CONFLICT', message: 'conflicts in 2 files' });
      let detail: { repositoryPath?: string; operationType?: string } | undefined;
      const listener = (e: Event): void => {
        detail = (e as CustomEvent<{ repositoryPath?: string; operationType?: string }>).detail;
      };
      shell.addEventListener('merge-conflict', listener);
      try {
        await runPull(REPO);
      } finally {
        shell.removeEventListener('merge-conflict', listener);
      }

      expect(detail?.repositoryPath).to.equal(REPO);
      expect(detail?.operationType).to.equal('merge');
      expect(errorToasts(), 'and it is not a red error').to.deep.equal([]);
      expect(
        uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`).join(' '),
        'the user is told what to do next',
      ).to.contain('warning:Pull produced conflicts');
    });

    it('asks for the rebase flavour of the dialog when the pull rebases', async () => {
      // Continuing a rebase is not committing a merge — the dialog's Complete
      // and Abort actions differ, so the type has to travel with the event.
      failures.set('pull', { code: 'REBASE_CONFLICT', message: 'conflicts in 1 file' });
      let detail: { operationType?: string } | undefined;
      const listener = (e: Event): void => {
        detail = (e as CustomEvent<{ operationType?: string }>).detail;
      };
      shell.addEventListener('merge-conflict', listener);
      try {
        await runPull(REPO);
      } finally {
        shell.removeEventListener('merge-conflict', listener);
      }
      expect(detail?.operationType).to.equal('rebase');
    });

    it('releases the working-tree lock so the conflict can be resolved', async () => {
      failures.set('pull', { code: 'MERGE_CONFLICT', message: 'conflicts in 2 files' });
      await runPull(REPO);
      expect(isRefOpRunning(REPO)).to.equal(false);
    });
  });
});
