/**
 * Teardown safety of the Tauri event wrappers.
 *
 * The closure `listen()` returns reads `window.__TAURI_EVENT_PLUGIN_INTERNALS__`
 * before its IPC round trip. Outside a real webview that global is absent, so
 * calling the closure rejects — and a disconnectedCallback has nowhere to send
 * that rejection. Both `safeUnlisten` and the unlisten `listenToEvent` hands
 * back must therefore never throw or reject, whatever state the bridge is in.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
// `invoke` answers `plugin:event|listen` with an id so listen() SUCCEEDS; the
// event plugin's own internals are deliberately NOT defined.
let cbId = 0;
const invoked: string[] = [];
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string) => {
    invoked.push(command);
    return Promise.resolve(command === 'plugin:event|listen' ? 7 : null);
  },
  transformCallback: () => cbId++,
};

import { expect } from '@open-wc/testing';
import { listenToEvent, safeUnlisten } from '../tauri-api.ts';
import { collectUnhandledRejections } from '../../test-utils/unhandled-rejections.ts';

describe('tauri-api teardown safety', () => {
  beforeEach(() => {
    invoked.length = 0;
    delete (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  });

  describe('safeUnlisten', () => {
    it('is a no-op for a missing unlisten', async () => {
      const rejections = await collectUnhandledRejections(() => {
        safeUnlisten(undefined);
        safeUnlisten(null);
      });
      expect(rejections).to.deep.equal([]);
    });

    it('calls the unlisten it is given', () => {
      let calls = 0;
      safeUnlisten(() => {
        calls++;
      });
      expect(calls).to.equal(1);
    });

    it('swallows a synchronous throw', async () => {
      const rejections = await collectUnhandledRejections(() => {
        expect(() =>
          safeUnlisten(() => {
            throw new Error('no bridge');
          }),
        ).to.not.throw();
      });
      expect(rejections).to.deep.equal([]);
    });

    it('swallows a rejection from an async unlisten', async () => {
      const rejections = await collectUnhandledRejections(() => {
        safeUnlisten((async () => {
          throw new Error('no bridge');
        }) as unknown as () => void);
      });
      expect(rejections).to.deep.equal([]);
    });

    it('lets a real Tauri unlisten reject without anyone hearing it', async () => {
      // The genuine closure from @tauri-apps/api: with the listen succeeding
      // above and no __TAURI_EVENT_PLUGIN_INTERNALS__, calling it rejects.
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('some-event', () => {});
      const rejections = await collectUnhandledRejections(() => {
        safeUnlisten(unlisten);
      });
      expect(rejections).to.deep.equal([]);
    });
  });

  describe('listenToEvent', () => {
    it('hands back an unlisten that cannot reject without the event plugin internals', async () => {
      const unlisten = await listenToEvent('some-event', () => {});
      expect(invoked).to.include('plugin:event|listen');

      const rejections = await collectUnhandledRejections(() => {
        unlisten();
      });
      expect(rejections).to.deep.equal([]);
    });

    it('still unregisters through the bridge when it is present', async () => {
      let unregistered = 0;
      (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {
          unregistered++;
        },
      };
      const unlisten = await listenToEvent('some-event', () => {});
      const rejections = await collectUnhandledRejections(async () => {
        unlisten();
        // The IPC half of unlisten runs after the synchronous unregister.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unregistered).to.equal(1);
      expect(invoked).to.include('plugin:event|unlisten');
      expect(rejections).to.deep.equal([]);
    });
  });
});
