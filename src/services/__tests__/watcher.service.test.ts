/**
 * Watcher Service Tests
 *
 * Tests for file watcher service using invokeCommand wrapper.
 */

import { expect, waitUntil } from '@open-wc/testing';

const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
let shouldFail = false;
// Per-command failures, so a test can fail `start_watching` alone
let failCommands: Record<string, string> = {};

let callbackId = 0;

const mockInvoke = (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  invokeCallArgs.push({ command, args: args || {} });

  if (shouldFail) {
    return Promise.reject('Backend error');
  }

  if (failCommands[command]) {
    return Promise.reject(failCommands[command]);
  }

  switch (command) {
    case 'start_watching':
    case 'stop_watching':
      return Promise.resolve(null);
    case 'plugin:event|listen':
      return Promise.resolve(null);
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: (_callback: unknown, _once?: boolean) => {
    return callbackId++;
  },
};

import { startWatching, stopWatching, onFileChange, cleanup } from '../watcher.service.ts';
import { uiStore } from '../../stores/index.ts';

describe('watcher.service', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    shouldFail = false;
    failCommands = {};
  });

  afterEach(async () => {
    // Note: cleanup calls stopWatching which invokes the backend
    // Don't clean up here to avoid double-invoke issues in tests
  });

  // NOTE: this block must run FIRST — the module registers its (single)
  // Tauri listener on the first successful startWatching, so listener-count
  // assertions are only meaningful before other tests trigger it.
  describe('shared listener registration', () => {
    function listenRegistrations(): number {
      return invokeCallArgs.filter(
        (c) => c.command === 'plugin:event|listen' && c.args.event === 'file-change'
      ).length;
    }

    it('registers exactly ONE file-change listener across concurrent startWatching calls', async () => {
      // Regression: startup restore watches N repos back-to-back; a
      // non-atomic `if (!unlisten)` check let every call register its own
      // listener, leaking N-1 of them and dispatching every event N times.
      await Promise.all([
        startWatching('/repo/one'),
        startWatching('/repo/two'),
        startWatching('/repo/three'),
      ]);

      expect(listenRegistrations()).to.equal(1);

      // Each repo still gets its own backend watcher
      const watched = invokeCallArgs
        .filter((c) => c.command === 'start_watching')
        .map((c) => c.args.path);
      expect(watched).to.have.members(['/repo/one', '/repo/two', '/repo/three']);
    });

    it('does not register another listener on later startWatching calls', async () => {
      await startWatching('/repo/four');
      expect(listenRegistrations()).to.equal(0); // registered in the previous test
    });
  });

  describe('startWatching', () => {
    it('should invoke start_watching with the path', async () => {
      await startWatching('/path/to/repo');

      const call = invokeCallArgs.find((c) => c.command === 'start_watching');
      expect(call).to.not.be.undefined;
      expect(call!.args.path).to.equal('/path/to/repo');
    });

    it('should throw on backend error', async () => {
      shouldFail = true;

      try {
        await startWatching('/path/to/repo');
        expect.fail('Should have thrown');
      } catch (e) {
        // invokeCommand wraps the rejection message
        expect((e as Error).message).to.be.a('string');
      }
    });
  });

  // A watch that cannot be registered (an exhausted inotify budget is the
  // usual cause on Linux) used to be logged and nothing else, leaving the user
  // with an app that silently stopped noticing outside changes.
  describe('watch failure feedback', () => {
    const LIMIT_ERROR =
      'the system file-watch limit was reached while watching /repos/huge-monorepo. ' +
      'Raise the inotify limit to restore it, e.g. `sudo sysctl fs.inotify.max_user_watches=524288`.';

    function warnings(): Array<{ message: string }> {
      return uiStore.getState().toasts.filter((t) => t.type === 'warning');
    }

    beforeEach(() => {
      uiStore.setState({ toasts: [] });
    });

    afterEach(() => {
      uiStore.setState({ toasts: [] });
    });

    it('warns the user, naming the repository and the actionable cause', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;

      await startWatching('/repos/huge-monorepo').catch(() => undefined);

      const warning = warnings()[0];
      expect(warning, 'a warning toast is surfaced to the user').to.exist;
      expect(warning.message).to.contain('Auto-refresh is unavailable for "huge-monorepo"');
      expect(warning.message).to.contain('fs.inotify.max_user_watches');
      expect(warning.message).to.contain('refresh manually');
    });

    it('still rejects so callers can log the failure', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;

      let rejected = false;
      await startWatching('/repos/rejects').catch(() => {
        rejected = true;
      });

      expect(rejected).to.be.true;
    });

    it('warns only once per repository, however often watching is retried', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;

      await startWatching('/repos/once-only').catch(() => undefined);
      await startWatching('/repos/once-only').catch(() => undefined);
      await startWatching('/repos/once-only').catch(() => undefined);

      expect(warnings()).to.have.lengthOf(1);
    });

    it('warns separately for each repository that cannot be watched', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;

      await startWatching('/repos/one').catch(() => undefined);
      await startWatching('/repos/two').catch(() => undefined);

      expect(warnings()).to.have.lengthOf(2);
    });

    it('offers a Retry that watches again and stays quiet when it works', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;
      await startWatching('/repos/retryable').catch(() => undefined);

      const toast = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(toast?.action?.label).to.equal('Retry');

      failCommands = {};
      invokeCallArgs.length = 0;
      toast!.action!.callback();
      await waitUntil(
        () => invokeCallArgs.some((c) => c.command === 'start_watching'),
        'the retry to reach the backend',
      );

      const retry = invokeCallArgs.find((c) => c.command === 'start_watching');
      expect(retry, 'Retry re-attempts the watch').to.not.be.undefined;
      expect(retry!.args.path).to.equal('/repos/retryable');
      // The retry succeeded, so no NEW warning was raised
      expect(warnings()).to.have.lengthOf(1);
    });

    it('warns again after the repository is closed and reopened', async () => {
      failCommands['start_watching'] = LIMIT_ERROR;
      await startWatching('/repos/reopened').catch(() => undefined);
      expect(warnings()).to.have.lengthOf(1);

      await stopWatching('/repos/reopened');
      await startWatching('/repos/reopened').catch(() => undefined);

      expect(warnings()).to.have.lengthOf(2);
    });

    it('does not warn when watching succeeds', async () => {
      await startWatching('/repos/fine');

      expect(warnings()).to.have.lengthOf(0);
    });
  });

  describe('stopWatching', () => {
    it('should invoke stop_watching', async () => {
      await stopWatching();

      const call = invokeCallArgs.find((c) => c.command === 'stop_watching');
      expect(call).to.not.be.undefined;
    });

    it('should pass the specific path when given one', async () => {
      await stopWatching('/repo/one');

      const call = invokeCallArgs.find((c) => c.command === 'stop_watching');
      expect(call!.args.path).to.equal('/repo/one');
    });

    it('should pass null (stop all) when called without a path', async () => {
      await stopWatching();

      const call = invokeCallArgs.find((c) => c.command === 'stop_watching');
      expect(call!.args.path).to.equal(null);
    });

    it('should throw on backend error', async () => {
      shouldFail = true;

      try {
        await stopWatching();
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.be.a('string');
      }
    });
  });

  describe('onFileChange', () => {
    it('should register and unregister handlers', () => {
      let callCount = 0;
      const unsubscribe = onFileChange(() => {
        callCount++;
      });

      expect(typeof unsubscribe).to.equal('function');
      unsubscribe();
      // Handler was removed, callCount should stay 0
      expect(callCount).to.equal(0);
    });
  });
});
