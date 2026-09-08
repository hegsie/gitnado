/**
 * Feedback for the toolbar's network operations.
 *
 * The three toolbar handlers were the only callers of fetch/pull/push that
 * didn't pass `silent`, so the service toasted and then the handler toasted
 * again: two messages per operation. A conflicting pull was the worst of it —
 * the service's red "Pull failed" fired while the handler opened the conflict
 * dialog, telling the user nothing happened when in fact the merge had landed
 * and needed resolving.
 *
 * Auto-fetch had the opposite problem: every failure returned early, so a
 * background loop that could never authenticate froze the ahead/behind badge
 * with no indication at all.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};
/** Commands that should reject, and with what. */
const failures: Record<string, { code?: string; message: string }> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    if (failures[command]) return Promise.reject(failures[command]);
    const handler = mockResponses[command];
    return Promise.resolve(handler ? handler(args || {}) : null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, waitUntil } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';
import { tryAcquireRefOp, resetRefOpLocks } from '../utils/ref-lock.ts';

function createAppShell(): AppShell {
  return document.createElement('lv-app-shell') as AppShell;
}

function mockRepo(path: string, name: string): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('app-shell remote-operation feedback', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    for (const k of Object.keys(failures)) delete failures[k];
    mockResponses['get_push_remote'] = (args) => args.remote ?? 'origin';
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  function shellOnRepo(): AppShell {
    const el = createAppShell();
    (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };
    return el;
  }

  describe('one message per operation', () => {
    for (const op of ['fetch', 'pull', 'push'] as const) {
      it(`${op} passes silent so the service does not toast on top of the handler`, async () => {
        const el = shellOnRepo();
        const handler = `handle${op[0].toUpperCase()}${op.slice(1)}` as
          | 'handleFetch'
          | 'handlePull'
          | 'handlePush';

        await (el as any)[handler]();

        const call = invokeCallArgs.find((c) => c.command === op);
        expect(call, `${op} invoked`).to.not.be.undefined;
        expect(call!.args.silent, `${op} suppresses the service toast`).to.equal(true);
      });

      it(`a failed ${op} produces exactly one error toast`, async () => {
        failures[op] = { code: 'COMMAND_ERROR', message: 'remote hung up' };
        const el = shellOnRepo();
        const handler = `handle${op[0].toUpperCase()}${op.slice(1)}` as
          | 'handleFetch'
          | 'handlePull'
          | 'handlePush';

        await (el as any)[handler]();

        const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
        expect(errors.length, `one error toast for a failed ${op}`).to.equal(1);
        expect(errors[0].message).to.contain('remote hung up');
      });
    }
  });

  describe('a conflicting pull is not reported as a failure', () => {
    it('says conflicts need resolving, not that the pull failed', async () => {
      failures['pull'] = { code: 'MERGE_CONFLICT', message: 'CONFLICT in a.txt' };
      const el = shellOnRepo();

      await (el as any).handlePull();

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'error' && /failed/i.test(t.message)),
        'no red "Pull failed" for a conflict',
      ).to.equal(false);
      expect(
        toasts.some((t) => /conflict/i.test(t.message)),
        'the user is told there are conflicts to resolve',
      ).to.equal(true);
    });
  });

  describe('auto-fetch failures are not swallowed', () => {
    it('reports a failure once, naming the repo', () => {
      const el = createAppShell();

      (el as any).handleAutoFetchCompleted({
        repoPath: '/home/user/projects/api-server',
        success: false,
        behind: 0,
        ahead: 0,
        message: 'No valid credentials found',
      });

      const toasts = uiStore.getState().toasts;
      expect(toasts.length, 'the failure is surfaced').to.equal(1);
      expect(toasts[0].message).to.contain('api-server');
      expect(toasts[0].message).to.contain('No valid credentials found');
    });

    it('does not repeat the same repo failure every cycle', () => {
      const el = createAppShell();
      const event = {
        repoPath: '/repo/one',
        success: false,
        behind: 0,
        ahead: 0,
        message: 'boom',
      };

      (el as any).handleAutoFetchCompleted(event);
      (el as any).handleAutoFetchCompleted(event);
      (el as any).handleAutoFetchCompleted(event);

      expect(uiStore.getState().toasts.length, 'reported once, not per cycle').to.equal(1);
    });

    it('speaks again after a recovery', () => {
      const el = createAppShell();

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/one', success: false, behind: 0, ahead: 0, message: 'boom',
      });
      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/one', success: true, behind: 0, ahead: 0,
      });
      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/one', success: false, behind: 0, ahead: 0, message: 'boom again',
      });

      const toasts = uiStore.getState().toasts;
      expect(toasts.length).to.equal(2);
      expect(toasts[1].message).to.contain('boom again');
    });

    it('reports each repo separately', () => {
      const el = createAppShell();

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/one', success: false, behind: 0, ahead: 0, message: 'boom',
      });
      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/two', success: false, behind: 0, ahead: 0, message: 'boom',
      });

      expect(uiStore.getState().toasts.length).to.equal(2);
    });
  });

  describe('the security gate does not report itself as a failure', () => {
    it('a declined confirm produces no error toast', async () => {
      const { settingsStore } = await import('../stores/index.ts');
      settingsStore.setState({ confirmNetworkOps: true });
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      try {
        const el = shellOnRepo();
        await (el as any).handleFetch();

        expect(
          uiStore.getState().toasts.filter((t) => t.type === 'error').length,
          "the user's own Cancel is not an error",
        ).to.equal(0);
      } finally {
        settingsStore.setState({ confirmNetworkOps: false });
      }
    });

    it('an offline block is announced once by the gate, not twice', async () => {
      const { settingsStore } = await import('../stores/index.ts');
      settingsStore.setState({ offlineMode: true });
      try {
        const el = shellOnRepo();
        await (el as any).handlePush();

        const toasts = uiStore.getState().toasts;
        expect(toasts.length, 'one message, from the gate').to.equal(1);
        expect(toasts[0].message).to.contain('Offline mode');
      } finally {
        settingsStore.setState({ offlineMode: false });
      }
    });
  });

  describe('commands that need a repository say so', () => {
    it('palette network and staging entries are guarded', () => {
      const el = createAppShell();
      (el as any).activeRepository = null;
      const commands = (el as any).getPaletteCommands() as Array<{
        id: string;
        action: () => void;
      }>;

      uiStore.setState({ toasts: [] });
      for (const id of ['fetch', 'pull', 'push', 'stash', 'stage-all', 'unstage-all']) {
        const cmd = commands.find((c) => c.id === id);
        expect(cmd, `${id} present in the palette`).to.not.be.undefined;
        uiStore.setState({ toasts: [] });
        cmd!.action();
        expect(
          uiStore.getState().toasts.length,
          `${id} tells the user a repository is needed`,
        ).to.equal(1);
      }
    });
  });

  // ── cancelling a remote operation ────────────────────────────────────────
  //
  // Fetch/pull/push advertised cancellation that did not exist: no call site
  // passed `{cancellable: true}`, so the indicator's Cancel button never
  // rendered, and no `operationId` reached the backend, so `cancel_operation`
  // could never find the operation to stop.

  describe('cancellable remote operations', () => {
    async function progress() {
      return (await import('../services/progress.service.ts')).progressService;
    }

    const handlerFor = (op: 'fetch' | 'pull' | 'push') =>
      `handle${op[0].toUpperCase()}${op.slice(1)}` as 'handleFetch' | 'handlePull' | 'handlePush';

    for (const op of ['fetch', 'pull', 'push'] as const) {
      it(`${op} runs under a cancellable progress row`, async () => {
        const service = await progress();
        const rows: Array<{ id: string; cancellable?: boolean }> = [];
        const unsubscribe = service.subscribe((ops) => {
          for (const o of ops) if (!rows.some((r) => r.id === o.id)) rows.push({ ...o });
        });
        try {
          const el = shellOnRepo();
          await (el as any)[handlerFor(op)]();

          expect(rows.length, `${op} shows a progress row`).to.be.greaterThan(0);
          expect(
            rows.every((r) => r.cancellable === true),
            `${op}'s row must render the Cancel button`,
          ).to.equal(true);
        } finally {
          unsubscribe();
        }
      });

      it(`${op} hands the backend the id its Cancel button will use`, async () => {
        const service = await progress();
        const ids: string[] = [];
        const unsubscribe = service.subscribe((ops) => {
          for (const o of ops) if (!ids.includes(o.id)) ids.push(o.id);
        });
        try {
          const el = shellOnRepo();
          await (el as any)[handlerFor(op)]();

          const call = invokeCallArgs.find((c) => c.command === op);
          expect(call, `${op} invoked`).to.not.be.undefined;
          expect(
            ids,
            `${op} must pass the very id the progress row was started with`,
          ).to.contain(call!.args.operationId);
        } finally {
          unsubscribe();
        }
      });

      it(`a cancelled ${op} reports "cancelled", not an error`, async () => {
        failures[op] = { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' };
        const el = shellOnRepo();

        await (el as any)[handlerFor(op)]();

        const toasts = uiStore.getState().toasts;
        expect(
          toasts.filter((t) => t.type === 'error').length,
          `a cancel the user asked for is not a red ${op} failure`,
        ).to.equal(0);
        expect(
          toasts.some((t) => /cancelled/i.test(t.message)),
          'the user is told the cancel took effect',
        ).to.equal(true);
      });

      it(`a real ${op} failure still shows its error after the cancel path exists`, async () => {
        failures[op] = { code: 'COMMAND_ERROR', message: 'remote hung up' };
        const el = shellOnRepo();

        await (el as any)[handlerFor(op)]();

        const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
        expect(errors.length, `a genuine ${op} failure is still an error`).to.equal(1);
        expect(errors[0].message).to.contain('remote hung up');
      });

      it(`a cancelled ${op} releases the per-repo lock`, async () => {
        // The lock is what stops a second fetch/pull/push on the same repo.
        // Leaking it on a cancellation would wedge the repository until the
        // app restarted, which is worse than not being able to cancel at all.
        failures[op] = { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' };
        const el = shellOnRepo();

        await (el as any)[handlerFor(op)]();

        invokeCallArgs.length = 0;
        delete failures[op];
        await (el as any)[handlerFor(op)]();

        expect(
          invokeCallArgs.some((c) => c.command === op),
          `a retry after a cancelled ${op} must not be refused by a stale lock`,
        ).to.equal(true);
      });
    }

    it('the indicator cancel event reaches the backend cancel command', async () => {
      const service = await progress();
      const el = shellOnRepo();
      const id = service.startOperation('fetch', 'Fetching...', { cancellable: true });
      invokeCallArgs.length = 0;

      (el as any).handleCancelOperation(new CustomEvent('cancel-operation', { detail: { id } }));

      const cancel = invokeCallArgs.find((c) => c.command === 'cancel_operation');
      expect(cancel, 'clicking Cancel must reach the backend').to.not.be.undefined;
      expect(cancel!.args.operationId).to.equal(id);
      expect(
        service.getOperations().some((o) => o.id === id),
        'the row is dismissed immediately',
      ).to.equal(false);
    });
  });

  describe('a rejected push offers the recovery the app already implements', () => {
    it('being behind the remote carries a Pull Now action', async () => {
      failures['push'] = {
        code: 'COMMAND_ERROR',
        message: 'the remote contains commits that are not present locally',
      };
      const el = shellOnRepo();

      await (el as any).handlePush();

      const toasts = uiStore.getState().toasts;
      expect(toasts.length, 'the failure is reported').to.be.greaterThan(0);
      expect(
        toasts.some((t) => t.action?.label === 'Pull Now'),
        'the Pull Now recovery is reachable from the only push surface',
      ).to.equal(true);
    });

    it('an amended history carries a Force Push action instead', async () => {
      // libgit2's "non-fastforwardable" means YOU rewrote history. Pulling
      // merges the pre-amend commits back in and undoes the amend, so the only
      // correct recovery is a force push — which had no affordance anywhere.
      failures['push'] = {
        code: 'COMMAND_ERROR',
        message: 'cannot push non-fastforwardable reference',
      };
      const el = shellOnRepo();

      await (el as any).handlePush();

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.action?.label === 'Force Push')).to.equal(true);
      expect(
        toasts.some((t) => /pull/i.test(t.message)),
        'and does not tell the user to do the thing that undoes their amend',
      ).to.equal(false);
    });
  });

  describe('force push', () => {
    function shellWithStoreRepo(): AppShell {
      const el = shellOnRepo();
      repositoryStore.setState({
        openRepositories: [{ repository: mockRepo('/repo/one', 'one') }],
        activeIndex: 0,
      } as any);
      return el;
    }

    it('asks before replacing the remote branch', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellWithStoreRepo();

      await (el as any).forcePush('/repo/one');

      expect(
        invokeCallArgs.some((c) => c.command === 'push'),
        'declining the confirm blocks the push',
      ).to.equal(false);
    });

    it('uses force-with-lease, not a bare force', async () => {
      // If someone else pushed while the suggestion toast was up, a bare force
      // would silently discard their commits. With-lease refuses instead.
      // confirm() resolves to (message-dialog result === okLabel), and the
      // default ok label is 'Ok'.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();

      await (el as any).forcePush('/repo/one');

      const push = invokeCallArgs.find((c) => c.command === 'push');
      expect(push, 'the push runs once confirmed').to.not.be.undefined;
      expect(push!.args.forceWithLease).to.equal(true);
      expect(push!.args.force).to.not.equal(true);
    });

    it('leaves the success message to the backend event', async () => {
      // The Rust push command emits `remote-operation-completed` and
      // setupRemoteOperationListeners toasts it, naming the branch and remote —
      // which this handler could not. Adding one here stacked two success
      // toasts on a single click, the exact rule handleFetch documents.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();
      uiStore.setState({ toasts: [] });

      await (el as any).forcePush('/repo/one');

      expect(
        uiStore.getState().toasts.filter((t) => t.type === 'success').length,
        'exactly one owner of the success message',
      ).to.equal(0);
    });

    it('the confirm names the branch it is about to overwrite', async () => {
      // This is the one operation in the app that can discard commits belonging
      // to someone else; naming only the repository was not enough.
      let prompt = '';
      mockResponses['plugin:dialog|message'] = (args) => {
        prompt = String(args.message ?? '');
        return 'Cancel';
      };
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      const el = shellOnRepo();
      repositoryStore.setState({
        openRepositories: [
          {
            repository: mockRepo('/repo/one', 'one'),
            currentBranch: { shorthand: 'feature/x', name: 'refs/heads/feature/x' },
          },
        ],
        activeIndex: 0,
      } as any);

      await (el as any).forcePush('/repo/one');

      expect(prompt).to.contain('feature/x');
    });

    it('a force push that is itself rejected does not offer Force Push again', async () => {
      // Routing this through the suggestion service would match the same branch
      // that produced the toast and loop the user back onto the one action that
      // discards remote commits.
      // confirm() resolves to (message-dialog result === okLabel), and the
      // default ok label is 'Ok'.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      failures['push'] = {
        code: 'COMMAND_ERROR',
        message: 'cannot push non-fastforwardable reference',
      };
      const el = shellWithStoreRepo();

      await (el as any).forcePush('/repo/one');

      expect(
        uiStore.getState().toasts.some((t) => t.action?.label === 'Force Push'),
        'no unbounded loop through the destructive action',
      ).to.equal(false);
    });

    it('is cancellable and passes its progress row id to the backend', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const { progressService } = await import('../services/progress.service.ts');
      const rows: Array<{ id: string; cancellable?: boolean }> = [];
      const unsubscribe = progressService.subscribe((ops) => {
        for (const o of ops) if (!rows.some((r) => r.id === o.id)) rows.push({ ...o });
      });
      try {
        const el = shellWithStoreRepo();

        await (el as any).forcePush('/repo/one');

        const push = invokeCallArgs.find((c) => c.command === 'push');
        expect(push, 'the push runs once confirmed').to.not.be.undefined;
        expect(
          rows.some((r) => r.id === push!.args.operationId && r.cancellable === true),
          'force push must be cancellable through the same row it reports on',
        ).to.equal(true);
      } finally {
        unsubscribe();
      }
    });

    it('a cancelled force push is not reported as a failure', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      failures['push'] = { code: 'OPERATION_CANCELLED', message: 'Operation cancelled' };
      const el = shellWithStoreRepo();
      uiStore.setState({ toasts: [] });

      await (el as any).forcePush('/repo/one');

      const toasts = uiStore.getState().toasts;
      expect(toasts.filter((t) => t.type === 'error').length).to.equal(0);
      expect(toasts.some((t) => /cancelled/i.test(t.message))).to.equal(true);
    });

    it('force pushing a tag asks first and sends the force flag', async () => {
      // confirm() resolves to (message-dialog result === okLabel), and the
      // default ok label is 'Ok'.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();

      await (el as any).forcePushTag('v1.2.0', '/repo/one');

      const confirm = invokeCallArgs.find(
        (c) => c.command === 'plugin:dialog|confirm' || c.command === 'plugin:dialog|message',
      );
      expect(confirm, 'the force push asks for confirmation').to.not.be.undefined;
      expect(String(confirm!.args.message)).to.contain('"origin"');
      const pushTag = invokeCallArgs.find((c) => c.command === 'push_tag');
      expect(pushTag).to.not.be.undefined;
      expect(pushTag!.args.name).to.equal('v1.2.0');
      expect(pushTag!.args.force).to.equal(true);
    });

    it('the tag force push goes to the remote the rejected push was aimed at', async () => {
      // The rejected push was sent to a remote the user picked in the tag
      // menu. Leaving the retry's destination to the backend resolver
      // force-moves the tag on `origin` in a fork checkout — a destructive
      // write to a remote the user never aimed at, reported as success.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();

      await (el as any).forcePushTag('v1.2.0', '/repo/one', 'upstream');

      const pushTag = invokeCallArgs.find((c) => c.command === 'push_tag');
      expect(pushTag).to.not.be.undefined;
      expect(pushTag!.args.remote).to.equal('upstream');
      expect(
        uiStore.getState().toasts.some((t) => t.message === 'Force pushed tag v1.2.0 to upstream'),
        'the confirmation names where the tag actually went',
      ).to.equal(true);
    });

    it('a tag force push resolves and names the destination when none was chosen', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();

      await (el as any).forcePushTag('v1.2.0', '/repo/one');

      const pushTag = invokeCallArgs.find((c) => c.command === 'push_tag');
      expect(pushTag!.args.remote).to.equal('origin');
      expect(
        uiStore.getState().toasts.some((t) => t.message === 'Force pushed tag v1.2.0 to origin'),
      ).to.equal(true);
    });

    it('an unresolvable destination stops the force push before the confirm', async () => {
      // Without the destination there is nothing honest to name in the "this
      // moves the remote tag" confirm, and pushing anyway force-moves the tag
      // on whatever the backend picks — a destructive write to a remote the
      // user never aimed at.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      failures['get_push_remote'] = {
        code: 'REMOTE_NOT_FOUND',
        message: 'Remote not found: origin',
      };
      const el = shellWithStoreRepo();

      await (el as any).forcePushTag('v1.2.0', '/repo/one');

      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length, 'the user is told why nothing happened').to.equal(1);
      expect(errors[0].message).to.contain('Could not determine the tag destination');
      expect(errors[0].message).to.contain('Remote not found: origin');
      expect(
        invokeCallArgs.some(
          (c) => c.command === 'plugin:dialog|confirm' || c.command === 'plugin:dialog|message',
        ),
        'no confirm for a push that cannot happen',
      ).to.equal(false);
      expect(
        invokeCallArgs.some((c) => c.command === 'push_tag'),
        'and nothing is pushed',
      ).to.equal(false);
    });

    it('the force-push-tag event carries the remote through to the push', async () => {
      // The suggestion service dispatches on `window`; the remote has to
      // survive the hop or the retry re-resolves the destination anyway.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellWithStoreRepo();
      document.body.appendChild(el);
      await (el as any).updateComplete;
      try {
        let seen: string | undefined = 'unset';
        (el as any).forcePushTag = (
          _tag: string,
          _repo: string,
          remote?: string,
        ): Promise<void> => {
          seen = remote;
          return Promise.resolve();
        };
        window.dispatchEvent(
          new CustomEvent('force-push-tag', {
            detail: { tagName: 'v1.2.0', repoPath: '/repo/one', remote: 'upstream' },
          }),
        );
        await new Promise((r) => setTimeout(r, 0));
        expect(seen).to.equal('upstream');
      } finally {
        el.remove();
      }
    });

    it('declining blocks the tag force push', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellWithStoreRepo();

      await (el as any).forcePushTag('v1.2.0', '/repo/one');

      expect(invokeCallArgs.some((c) => c.command === 'push_tag')).to.equal(false);
    });

    it('the suggestion action reaches the handler through the window event', async () => {
      // The suggestion service dispatches on `window`; app-shell has to be
      // listening, or the button is dead.
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellWithStoreRepo();
      document.body.appendChild(el);
      await (el as any).updateComplete;
      try {
        let reached: string | null = null;
        (el as any).forcePush = (p: string): Promise<void> => {
          reached = p;
          return Promise.resolve();
        };
        window.dispatchEvent(
          new CustomEvent('force-push', { detail: { repoPath: '/repo/one' } }),
        );
        expect(reached, 'the Force Push button is wired to something').to.equal('/repo/one');
      } finally {
        el.remove();
      }
    });
  });

  describe('checking out a tag from the graph warns about detached HEAD', () => {
    it('declining the warning blocks the checkout', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellOnRepo();
      (el as any).refContextMenu = { visible: true, x: 0, y: 0, refName: 'v1.0.0', refType: 'tag' };

      await (el as any).handleRefCheckout();

      expect(
        invokeCallArgs.some((c) => c.command === 'checkout_with_autostash'),
        'HEAD is not detached behind the user',
      ).to.equal(false);
    });

    it('a branch checkout is not gated by the tag warning', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true,
        x: 0,
        y: 0,
        refName: 'feature',
        refType: 'localBranch',
      };

      await (el as any).handleRefCheckout();

      expect(invokeCallArgs.some((c) => c.command === 'checkout_with_autostash')).to.equal(true);
    });
  });

  describe('the graph ref menu confirms before rewriting history', () => {
    async function refMenuShell(): Promise<AppShell> {
      const el = shellOnRepo();
      (el as any).refContextMenu = { visible: true, x: 0, y: 0, refName: 'feature' };
      return el;
    }

    it('merge asks first, and declining blocks it', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = await refMenuShell();

      await (el as any).handleRefMerge();

      expect(invokeCallArgs.some((c) => c.command === 'merge'), 'declined merge blocked').to.equal(
        false,
      );
    });

    it('rebase asks first, and declining blocks it', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = await refMenuShell();

      await (el as any).handleRefRebase();

      expect(invokeCallArgs.some((c) => c.command === 'rebase'), 'declined rebase blocked').to.equal(
        false,
      );
    });

    it('accepting the confirm runs the merge', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = await refMenuShell();

      await (el as any).handleRefMerge();

      expect(invokeCallArgs.some((c) => c.command === 'merge')).to.equal(true);
    });

    it('a second rebase cannot start while the first is running', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = await refMenuShell();
      tryAcquireRefOp((el as any).activeRepository.repository.path);

      await (el as any).handleRefRebase();

      expect(
        invokeCallArgs.some((c) => c.command === 'rebase'),
        'no second history rewrite on the same worktree',
      ).to.equal(false);
    });
  });

  describe('shortcuts with no repository open', () => {
    it('Ctrl+Z and Ctrl+Shift+N explain, like their palette twins', async () => {
      const { keyboardService } = await import('../services/keyboard.service.ts');
      const el = createAppShell();
      (el as any).activeRepository = null;
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        for (const description of ['Open reflog', 'Create new branch']) {
          const sc = keyboardService
            .getAllShortcuts()
            .find((s) => s.description === description);
          if (!sc) continue;
          uiStore.setState({ toasts: [] });
          sc.action();
          expect(
            uiStore.getState().toasts.length,
            `${description} tells the user a repository is needed`,
          ).to.equal(1);
        }
      } finally {
        el.remove();
      }
    });
  });

  describe('staging works with the right panel hidden', () => {
    it('reveals the panel that owns the listener before dispatching', async () => {
      // `stage-all` is heard only by lv-file-status, which lives inside the
      // right panel. With Ctrl+J pressed the panel is unmounted, its listener
      // gone, and both the `s` shortcut and the palette entry silently did
      // nothing — with no other way to stage.
      const { uiStore: ui } = await import('../stores/index.ts');
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        if ((el as any).rightPanelVisible) {
          ui.getState().togglePanel('right');
          await (el as any).updateComplete;
        }
        expect((el as any).rightPanelVisible, 'panel starts hidden').to.equal(false);

        let heard = 0;
        const onStage = (): void => { heard++; };
        window.addEventListener('stage-all', onStage);
        try {
          await (el as any).dispatchToFileStatus('stage-all');
        } finally {
          window.removeEventListener('stage-all', onStage);
        }

        expect((el as any).rightPanelVisible, 'panel revealed').to.equal(true);
        expect(heard, 'event still dispatched').to.equal(1);
      } finally {
        el.remove();
      }
    });

    it('leaves an already-visible panel alone', async () => {
      const { uiStore: ui } = await import('../stores/index.ts');
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        if (!(el as any).rightPanelVisible) {
          ui.getState().togglePanel('right');
          await (el as any).updateComplete;
        }

        let heard = 0;
        const onUnstage = (): void => { heard++; };
        window.addEventListener('unstage-all', onUnstage);
        try {
          await (el as any).dispatchToFileStatus('unstage-all');
        } finally {
          window.removeEventListener('unstage-all', onUnstage);
        }

        expect((el as any).rightPanelVisible).to.equal(true);
        expect(heard).to.equal(1);
      } finally {
        el.remove();
      }
    });
  });


  /**
   * The status bar's ahead/behind badge used to render a private
   * `remoteStatus` field that only the tab switch, the fetch-on-focus handler
   * and auto-fetch ever wrote. push/pull/fetch end at handleRefresh, which
   * refreshes the repository, the graph and the indexes — never that field —
   * so a pushed-away "↑3" sat there until the next auto-fetch tick, tab switch
   * or refocus, contradicting the tab badge a few pixels away. The badge now
   * renders the store's `currentBranch.aheadBehind`, the same field the tab
   * badge reads.
   */
  describe('the status-bar ahead/behind badge', () => {
    const ORIGIN = { name: 'origin', url: 'https://example.com/test/repo.git', pushUrl: null };

    function branch(aheadBehind?: { ahead: number; behind: number }) {
      return {
        name: 'main',
        shorthand: 'main',
        isHead: true,
        isRemote: false,
        upstream: 'origin/main',
        targetOid: 'abc',
        isStale: false,
        ...(aheadBehind ? { aheadBehind } : {}),
      };
    }

    function footerOf(el: AppShell): Element | null {
      return el.shadowRoot!.querySelector('footer.status-bar');
    }
    const aheadOf = (el: AppShell) => footerOf(el)?.querySelector('.status-ahead') ?? null;
    const behindOf = (el: AppShell) => footerOf(el)?.querySelector('.status-behind') ?? null;

    /** Mount a shell on an open repo whose branch data is already known. */
    async function mountOnRepo(
      aheadBehind?: { ahead: number; behind: number } | 'no-branch',
    ): Promise<AppShell> {
      // Quiet the sidebar lists that mount with the shell — an unmocked
      // command resolves to null and each list toasts its own load failure.
      for (const cmd of ['get_stashes', 'get_tags', 'get_status']) {
        if (!mockResponses[cmd]) mockResponses[cmd] = () => [];
      }
      // A remote, like `mountWithRemote` below: this branch tracks
      // origin/main, and fetch/pull/push are refused on a repository with
      // nowhere to send them — wherever they were asked for.
      if (!mockResponses['get_remotes']) mockResponses['get_remotes'] = () => [ORIGIN];
      const el = createAppShell();
      document.body.appendChild(el);
      await (el as any).updateComplete;
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', { remotes: [ORIGIN] } as any);
      if (aheadBehind !== 'no-branch') {
        repositoryStore
          .getState()
          .updateRepoData('/repo/one', { currentBranch: branch(aheadBehind) as any });
      }
      await (el as any).updateComplete;
      return el;
    }

    it('shows the unpushed count as soon as the branch is known', async () => {
      const el = await mountOnRepo({ ahead: 3, behind: 0 });
      try {
        await waitUntil(() => aheadOf(el) !== null, 'the ahead badge is rendered');
        expect(aheadOf(el)!.textContent).to.contain('3');
        expect(behindOf(el), 'nothing to pull').to.be.null;
      } finally {
        el.remove();
      }
    });

    it('a successful push clears it', async () => {
      // The whole reported chain: push → refreshConflictDialogRepo →
      // handleRefresh → repository-refresh → the branch list re-reads
      // get_branches → store → this badge.
      let pushed = false;
      mockResponses['open_repository'] = () => mockRepo('/repo/one', 'one');
      mockResponses['get_status'] = () => [];
      mockResponses['get_remotes'] = () => [ORIGIN];
      mockResponses['get_cleanup_candidates'] = () => [];
      mockResponses['get_branches'] = () => [
        branch(pushed ? { ahead: 0, behind: 0 } : { ahead: 3, behind: 0 }),
      ];
      mockResponses['push'] = () => {
        pushed = true;
        return null;
      };

      const el = await mountOnRepo({ ahead: 3, behind: 0 });
      try {
        await waitUntil(() => aheadOf(el)?.textContent?.includes('3') === true, 'starts at 3');

        await (el as any).handlePush();

        await waitUntil(() => aheadOf(el) === null, 'the pushed commits stop being advertised');
      } finally {
        el.remove();
      }
    });

    it('a push that fails leaves the unpushed count on screen', async () => {
      failures['push'] = { code: 'COMMAND_ERROR', message: 'Updates were rejected' };
      mockResponses['open_repository'] = () => mockRepo('/repo/one', 'one');
      mockResponses['get_status'] = () => [];
      mockResponses['get_remotes'] = () => [ORIGIN];
      mockResponses['get_cleanup_candidates'] = () => [];
      mockResponses['get_branches'] = () => [branch({ ahead: 3, behind: 0 })];

      const el = await mountOnRepo({ ahead: 3, behind: 0 });
      try {
        await waitUntil(() => aheadOf(el)?.textContent?.includes('3') === true, 'starts at 3');
        uiStore.setState({ toasts: [] });

        await (el as any).handlePush();
        await (el as any).updateComplete;

        expect(aheadOf(el), 'the commits are still unpushed, so still shown').to.not.be.null;
        expect(aheadOf(el)!.textContent).to.contain('3');
        expect(
          uiStore
            .getState()
            .toasts.some((t) => t.type === 'error' && t.action?.label === 'Pull Now'),
          'and the rejection is reported, with its recovery',
        ).to.equal(true);
      } finally {
        el.remove();
      }
    });

    it('renders a behind-only repo with the down arrow alone', async () => {
      const el = await mountOnRepo({ ahead: 0, behind: 2 });
      try {
        await waitUntil(() => behindOf(el) !== null, 'the behind badge is rendered');
        expect(aheadOf(el)).to.be.null;
        expect(behindOf(el)!.textContent).to.contain('2');
        // No ahead badge before it, so it keeps the full gap from the path
        expect(behindOf(el)!.getAttribute('style')).to.contain('margin-left: 12px');
      } finally {
        el.remove();
      }
    });

    it('renders no badge for a branch with no upstream', async () => {
      const el = await mountOnRepo();
      try {
        await (el as any).updateComplete;
        expect(aheadOf(el), 'never prints an undefined count').to.be.null;
        expect(behindOf(el)).to.be.null;
        expect(footerOf(el)!.textContent, 'the path is still shown').to.contain('/repo/one');
      } finally {
        el.remove();
      }
    });

    it('the fetch-on-focus result reaches both badges, not just this one', async () => {
      const { settingsStore } = await import('../stores/index.ts');
      settingsStore.setState({ fetchOnFocus: true });
      mockResponses['get_remote_status'] = () => ({
        ahead: 0,
        behind: 4,
        hasUpstream: true,
        upstreamName: 'origin/main',
      });
      const el = await mountOnRepo({ ahead: 0, behind: 0 });
      try {
        window.dispatchEvent(new Event('focus'));

        await waitUntil(
          () => behindOf(el)?.textContent?.includes('4') === true,
          'the status bar picks up the fetched counts',
        );
        // The tab badge reads the store — on the old code this stayed stale.
        expect(
          repositoryStore.getState().openRepositories[0].currentBranch?.aheadBehind,
        ).to.deep.equal({ ahead: 0, behind: 4 });
      } finally {
        settingsStore.setState({ fetchOnFocus: false });
        el.remove();
      }
    });
  });

  describe('create branch is reachable without a mouse', () => {
    it('the command palette offers Create branch, like Create tag', () => {
      const el = shellOnRepo();

      const ids = (el as any)
        .getPaletteCommands()
        .map((c: { id: string }) => c.id);

      expect(ids, 'Create tag was there all along').to.include('create-tag');
      expect(ids, 'Create branch was mouse-only').to.include('create-branch');
    });

    it('registers the Ctrl+Shift+N shortcut', async () => {
      // registerDefaultShortcuts only registers new-branch `if
      // (actions.createBranch)`, and app-shell never passed one — so the
      // shortcut was never registered, did nothing when pressed, and never
      // appeared in the shortcuts-help dialog.
      const { keyboardService } = await import('../services/keyboard.service.ts');
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        // getAllShortcuts() returns bindings, not ids — match on the
        // description registerDefaultShortcuts gives this one.
        const newBranch = keyboardService
          .getAllShortcuts()
          .find((sc) => sc.description === 'Create new branch');
        expect(newBranch, 'Ctrl+Shift+N registered').to.not.be.undefined;
        expect(newBranch!.ctrl).to.equal(true);
        expect(newBranch!.shift).to.equal(true);
        expect(newBranch!.key).to.equal('n');
      } finally {
        el.remove();
      }
    });
  });
  describe('the toolbar Fetch/Pull/Push buttons run the shared handlers', () => {
    /** Mount a shell on a repo that has a remote, so the buttons are live. */
    async function mountWithRemote(): Promise<AppShell> {
      for (const cmd of ['get_stashes', 'get_tags', 'get_status', 'get_branches']) {
        if (!mockResponses[cmd]) mockResponses[cmd] = () => [];
      }
      mockResponses['get_remotes'] = () => [
        { name: 'origin', url: 'https://example.com/test/repo.git', pushUrl: null },
      ];
      mockResponses['open_repository'] = () => mockRepo('/repo/one', 'one');
      const el = createAppShell();
      document.body.appendChild(el);
      await (el as any).updateComplete;
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', {
        remotes: [{ name: 'origin', url: 'https://example.com/test/repo.git', pushUrl: null }],
        currentBranch: {
          name: 'main',
          shorthand: 'main',
          isHead: true,
          isRemote: false,
          upstream: 'origin/main',
          targetOid: 'abc123',
          aheadBehind: { ahead: 2, behind: 3 },
          isStale: false,
        } as any,
      });
      await (el as any).updateComplete;
      return el;
    }

    function toolbarButton(el: AppShell, op: string): HTMLButtonElement {
      const toolbar = el.shadowRoot!.querySelector('lv-toolbar');
      expect(toolbar, 'the toolbar is rendered').to.not.be.null;
      const btn = toolbar!.shadowRoot!.querySelector(`.remote-btn.${op}`);
      expect(btn, `the toolbar ${op} button`).to.not.be.null;
      return btn as HTMLButtonElement;
    }

    for (const op of ['fetch', 'pull', 'push'] as const) {
      it(`the toolbar ${op} button invokes ${op} through app-shell`, async () => {
        const el = await mountWithRemote();
        try {
          await (el.shadowRoot!.querySelector('lv-toolbar') as any).updateComplete;
          const btn = toolbarButton(el, op);
          expect(btn.disabled, `${op} is enabled on a repo with a remote`).to.be.false;
          btn.click();

          await waitUntil(
            () => invokeCallArgs.some((c) => c.command === op),
            `the toolbar ${op} button reaches the ${op} command`,
          );
          // Through the shared handler, which passes silent so the service
          // does not toast on top of it.
          const call = invokeCallArgs.find((c) => c.command === op)!;
          expect(call.args.silent).to.equal(true);
        } finally {
          el.remove();
        }
      });

      it(`a failed ${op} from the toolbar is reported, not swallowed`, async () => {
        failures[op] = { code: 'COMMAND_ERROR', message: 'remote hung up' };
        const el = await mountWithRemote();
        try {
          toolbarButton(el, op).click();

          await waitUntil(
            () => uiStore.getState().toasts.some((t) => t.type === 'error'),
            `a failed ${op} from the toolbar surfaces an error`,
          );
        } finally {
          el.remove();
        }
      });
    }

    it('explains itself when the event arrives with no repository open', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        uiStore.setState({ toasts: [] });
        el.shadowRoot!
          .querySelector('lv-toolbar')!
          .dispatchEvent(new CustomEvent('remote-fetch', { bubbles: true, composed: true }));

        await waitUntil(
          () => uiStore.getState().toasts.length > 0,
          'the no-repository case is explained',
        );
        expect(uiStore.getState().toasts[0].message).to.contain('open a repository');
        expect(invokeCallArgs.some((c) => c.command === 'fetch')).to.be.false;
      } finally {
        el.remove();
      }
    });
  });

  /**
   * A remote added — or removed — while the repository is open.
   *
   * The store's `remotes` is what greys out Fetch/Pull/Push on both surfaces
   * and what the runner refuses on, and it used to be written only when a tab
   * was activated or a session restored. So the user could do exactly what the
   * refusal told them to — add a remote in the Remotes dialog — and every
   * remote surface went on insisting the repository had none until they closed
   * and reopened the tab. The mirror was worse: removing the last remote left
   * the buttons bright and the operation ended in git's own
   * "remote 'origin' does not exist".
   *
   * The dialog raises `remotes-changed` and app-shell answers with
   * handleRefresh(), so that refresh is where the remotes are re-read.
   */
  describe('remotes changing while the repository is open', () => {
    const ORIGIN = { name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null };
    let remotesOnDisk: Array<Record<string, unknown>> = [];

    async function mountOnRepo(): Promise<AppShell> {
      for (const cmd of ['get_stashes', 'get_tags', 'get_status', 'get_branches']) {
        if (!mockResponses[cmd]) mockResponses[cmd] = () => [];
      }
      mockResponses['get_remotes'] = () => remotesOnDisk;
      mockResponses['open_repository'] = () => mockRepo('/repo/one', 'one');
      const el = createAppShell();
      document.body.appendChild(el);
      await (el as any).updateComplete;
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      await (el as any).updateComplete;
      return el;
    }

    /** The dialog's own event, dispatched from the element that listens for it. */
    async function remotesChanged(el: AppShell): Promise<void> {
      const dialog = el.shadowRoot!.querySelector('lv-remote-dialog');
      expect(dialog, 'the Remotes dialog is mounted for the open repository').to.exist;
      dialog!.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
    }

    function fetchButton(el: AppShell): HTMLButtonElement | null {
      return (
        el.shadowRoot!
          .querySelector('lv-toolbar')!
          .shadowRoot!.querySelector('.remote-btn.fetch') as HTMLButtonElement | null
      );
    }

    function storedRemotes(): unknown[] {
      return (
        repositoryStore
          .getState()
          .openRepositories.find((r) => r.repository.path === '/repo/one')?.remotes ?? []
      );
    }

    it('adding the first remote makes Fetch available, without reopening the tab', async () => {
      remotesOnDisk = [];
      const el = await mountOnRepo();
      try {
        await waitUntil(() => fetchButton(el)?.disabled === true, 'Fetch starts unavailable');
        expect(fetchButton(el)!.title).to.contain('no remote configured');

        // The user does exactly what the refusal told them to.
        remotesOnDisk = [ORIGIN];
        await remotesChanged(el);

        await waitUntil(() => storedRemotes().length === 1, 'the store learns about the remote');
        await waitUntil(() => fetchButton(el)?.disabled === false, 'and Fetch becomes available');
        expect(fetchButton(el)!.title, 'the refusal is gone from the tooltip too').to.not.contain(
          'no remote configured',
        );
      } finally {
        el.remove();
      }
    });

    it('the shortcut works too, instead of still being refused', async () => {
      remotesOnDisk = [];
      const el = await mountOnRepo();
      try {
        await waitUntil(() => fetchButton(el)?.disabled === true, 'Fetch starts unavailable');
        remotesOnDisk = [ORIGIN];
        await remotesChanged(el);
        await waitUntil(() => storedRemotes().length === 1, 'the store learns about the remote');

        uiStore.setState({ toasts: [] });
        invokeCallArgs.length = 0;
        await (el as any).handleFetch();

        expect(
          invokeCallArgs.some((c) => c.command === 'fetch'),
          'the fetch reaches git',
        ).to.equal(true);
        expect(
          uiStore.getState().toasts.map((t) => t.message).join(' | '),
        ).to.not.contain('No remote configured');
      } finally {
        el.remove();
      }
    });

    it('removing the last remote puts the refusal back', async () => {
      remotesOnDisk = [ORIGIN];
      const el = await mountOnRepo();
      try {
        await waitUntil(() => fetchButton(el)?.disabled === false, 'Fetch starts available');

        remotesOnDisk = [];
        await remotesChanged(el);

        await waitUntil(() => storedRemotes().length === 0, 'the store learns the remote is gone');
        await waitUntil(() => fetchButton(el)?.disabled === true, 'and Fetch goes unavailable');
        expect(fetchButton(el)!.title).to.contain('no remote configured');
      } finally {
        el.remove();
      }
    });

    it('the refresh itself re-reads them, with no panel mounted to do it', async () => {
      // The branch list also mirrors the remotes it loads, so a mounted shell
      // would pass this whichever writer did the work. handleRefresh is the
      // one every state-modifying operation goes through — including the one
      // the Remotes dialog asks for — so it must not depend on which panels
      // happen to be on screen.
      remotesOnDisk = [ORIGIN];
      mockResponses['get_remotes'] = () => remotesOnDisk;
      mockResponses['open_repository'] = () => mockRepo('/repo/one', 'one');
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      const el = createAppShell();
      (el as any).activeRepository = repositoryStore.getState().getActiveRepository();

      await (el as any).handleRefresh();

      expect(storedRemotes(), 'the refresh wrote what git answered').to.have.lengthOf(1);
    });

    it('a repository whose remotes cannot be read keeps its buttons', async () => {
      // "Could not read" is not "has none": the operation goes ahead and
      // reports git's own error rather than being refused on an absence.
      remotesOnDisk = [ORIGIN];
      const el = await mountOnRepo();
      try {
        await waitUntil(() => fetchButton(el)?.disabled === false, 'Fetch starts available');
        failures['get_remotes'] = { code: 'COMMAND_ERROR', message: 'cannot read config' };

        await remotesChanged(el);
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchButton(el)!.disabled, 'still available').to.equal(false);
        expect(storedRemotes(), 'and the last known answer is untouched').to.have.lengthOf(1);
      } finally {
        delete failures['get_remotes'];
        el.remove();
      }
    });
  });
});
