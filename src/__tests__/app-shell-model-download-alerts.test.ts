/**
 * Background model-download failures must reach the user.
 *
 * `download_model` returns as soon as the download is spawned; a multi-hundred
 * megabyte download then runs for minutes and reports its outcome only over a
 * Tauri event. The only listeners lived in the Settings dialog, which app-shell
 * unmounts on close — so closing Settings during a download meant a later
 * network drop, full disk or refused load produced nothing at all: no toast, no
 * banner, and a user left wondering why they have no AI. The shell owns the
 * listener now, for as long as the app is running.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type EventCallback = (e: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<number, { event: string; cb: EventCallback }>();
const callbacks = new Map<number, EventCallback>();
let nextId = 1;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: (cb: EventCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'plugin:event|listen') {
      const cb = callbacks.get(args?.handler as number);
      const id = nextId++;
      if (cb) listeners.set(id, { event: args?.event as string, cb });
      return Promise.resolve(id);
    }
    if (command === 'plugin:event|unlisten') {
      listeners.delete(args?.eventId as number);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  },
};

// `unlisten()` pokes the event plugin's own internals before the IPC call.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

/** Deliver a backend event exactly as the Tauri event plugin would. */
function emit(event: string, payload: unknown): void {
  for (const listener of [...listeners.values()]) {
    if (listener.event === event) listener.cb({ event, id: 1, payload });
  }
}

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';
import { uiStore } from '../stores/index.ts';

async function shell(): Promise<AppShell> {
  const el = await fixture<AppShell>(html`<lv-app-shell></lv-app-shell>`);
  await el.updateComplete;
  // The listeners are registered over async IPC in connectedCallback.
  await waitForListener('model-download-error');
  await waitForListener('model-download-complete');
  // Registration lands in the mock before the shell records its unlisten, so
  // let the remaining promise jobs run before anyone tears the shell down.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return el;
}

async function waitForListener(event: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ([...listeners.values()].some((l) => l.event === event)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no listener was ever registered for ${event}`);
}

function errorToasts() {
  return uiStore.getState().toasts.filter((t) => t.type === 'error');
}

// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell model download alerts', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
    // Drop listeners left behind by an earlier shell so each test only ever
    // observes the shell it just mounted.
    listeners.clear();
  });

  afterEach(() => {
    uiStore.setState({ toasts: [] });
  });

  it('surfaces a background download failure while Settings is closed', async () => {
    await shell();
    expect(
      dialogs.isOpen('settings'),
      'Settings must be closed for this to be the reported bug'
    ).to.be.false;

    emit('model-download-error', { modelId: 'qwen-2.5-1.5b', error: 'Disk full' });

    const toast = errorToasts()[0];
    expect(toast, 'the failure must be reported by the shell').to.not.be.undefined;
    expect(toast.message).to.contain('Disk full');
    expect(toast.message).to.contain('qwen-2.5-1.5b');
  });

  it('surfaces a model that downloaded but would not load', async () => {
    await shell();

    emit('model-download-complete', {
      modelId: 'qwen-2.5-1.5b',
      loaded: false,
      loadError: 'llama.cpp init failed',
    });

    const toast = errorToasts()[0];
    expect(toast, 'a model that will not load must be reported').to.not.be.undefined;
    expect(toast.message).to.contain('llama.cpp init failed');
  });

  it('says nothing when a download completes and loads', async () => {
    await shell();

    emit('model-download-complete', { modelId: 'qwen-2.5-1.5b', loaded: true });

    expect(errorToasts(), 'a successful download is not an error').to.have.lengthOf(0);
  });

  it('stops listening once the shell is torn down', async () => {
    const el = await shell();
    el.remove();
    // Tauri's unlisten deregisters over IPC, so let those promises settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    uiStore.setState({ toasts: [] });

    emit('model-download-error', { modelId: 'qwen-2.5-1.5b', error: 'Disk full' });

    expect(errorToasts(), 'the listener must be released with the shell').to.have.lengthOf(0);
  });
});
