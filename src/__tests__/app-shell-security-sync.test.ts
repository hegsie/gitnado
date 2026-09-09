/**
 * The security settings have to REACH the backend.
 *
 * Offline mode and the remote allowlist are enforced in Rust as well as in
 * `checkNetworkAllowed` — the frontend gate is only as good as every call site
 * remembering to ask it, and twice now one has not. The backend keeps its own
 * mirror of the two settings so the first operation after launch is guarded,
 * but it cannot read the frontend's persisted values: if this push stops
 * happening, turning offline mode ON in Settings leaves the backend permissive
 * and nothing visible goes wrong until something slips through.
 *
 * So these tests pin the push itself: once at startup, and again on every
 * change, on the same `update-security-settings` event the Rust listener in
 * `src-tauri/src/lib.rs` is registered on.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, waitUntil } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { settingsStore } from '../stores/settings.store.ts';
import { uiStore } from '../stores/ui.store.ts';
import { repositoryStore } from '../stores/repository.store.ts';
import {
  SECURITY_SETTINGS_EVENT,
  emitSecuritySettings,
} from '../services/security-sync.service.ts';

interface SecurityPayload {
  offlineMode: boolean;
  remoteAllowlist: string[];
}

/** Every `update-security-settings` emit seen so far, oldest first. */
function securityPushes(): SecurityPayload[] {
  return invokeCallArgs
    .filter(
      (c) =>
        c.command === 'plugin:event|emit' && c.args.event === SECURITY_SETTINGS_EVENT,
    )
    .map((c) => c.args.payload as SecurityPayload);
}

function lastPush(): SecurityPayload | undefined {
  const pushes = securityPushes();
  return pushes[pushes.length - 1];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('security settings reach the backend', () => {
  let el: AppShell | undefined;

  beforeEach(() => {
    invokeCallArgs.length = 0;
    settingsStore.setState({
      offlineMode: false,
      remoteAllowlist: [],
      autoFetchInterval: 0,
    });
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    // The subscription installed by setupAutoFetch outlives the element unless
    // it is torn down, and a leaked one would push during the next test.
    (el as any)?.autoFetchUnsubscribe?.();
    el = undefined;
    repositoryStore.getState().reset();
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
  });

  it('pushes the current values on startup, before anything can run', async () => {
    settingsStore.setState({ offlineMode: true, remoteAllowlist: ['github.com'] });
    el = document.createElement('lv-app-shell') as AppShell;

    (el as any).setupAutoFetch();

    await waitUntil(() => securityPushes().length > 0, 'the startup push happens');
    expect(lastPush()).to.deep.equal({
      offlineMode: true,
      remoteAllowlist: ['github.com'],
    });
  });

  it('pushes again when offline mode is turned on', async () => {
    el = document.createElement('lv-app-shell') as AppShell;
    (el as any).setupAutoFetch();
    await waitUntil(() => securityPushes().length > 0);
    const before = securityPushes().length;

    settingsStore.getState().setOfflineMode(true);

    await waitUntil(
      () => securityPushes().length > before,
      'a settings change reaches the backend',
    );
    expect(lastPush()?.offlineMode, 'the backend is told about offline mode').to.equal(
      true,
    );
  });

  it('pushes again when the remote allowlist changes', async () => {
    el = document.createElement('lv-app-shell') as AppShell;
    (el as any).setupAutoFetch();
    await waitUntil(() => securityPushes().length > 0);
    const before = securityPushes().length;

    settingsStore.getState().setRemoteAllowlist(['gitlab.example.test']);

    await waitUntil(() => securityPushes().length > before);
    expect(lastPush()?.remoteAllowlist).to.deep.equal(['gitlab.example.test']);
  });

  it('sends a copy of the allowlist, not the store array', async () => {
    const allowlist = ['github.com'];
    await emitSecuritySettings({ offlineMode: false, remoteAllowlist: allowlist });

    const sent = lastPush()!.remoteAllowlist;
    expect(sent).to.deep.equal(['github.com']);
    expect(sent, 'a later mutation must not change what was sent').to.not.equal(
      allowlist,
    );
  });

  it('reports a failed push once, not once per settings write', async () => {
    const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as {
      invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
    };
    const original = internals.invoke;
    uiStore.setState({ toasts: [] });
    internals.invoke = () => Promise.reject(new Error('no backend'));
    try {
      // Must not throw: the callers are a startup hook and a store
      // subscription, neither of which has anywhere to put an exception.
      await emitSecuritySettings({ offlineMode: true, remoteAllowlist: [] });
      await emitSecuritySettings({ offlineMode: true, remoteAllowlist: [] });
    } finally {
      internals.invoke = original;
    }

    const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
    expect(errors.length, 'the outage is reported exactly once').to.equal(1);
    expect(errors[0].message).to.contain('security settings');

    // Recovering re-arms the report, so a second outage is not swallowed.
    uiStore.setState({ toasts: [] });
    await emitSecuritySettings({ offlineMode: false, remoteAllowlist: [] });
    internals.invoke = () => Promise.reject(new Error('no backend'));
    try {
      await emitSecuritySettings({ offlineMode: true, remoteAllowlist: [] });
    } finally {
      internals.invoke = original;
    }
    expect(
      uiStore.getState().toasts.filter((t) => t.type === 'error').length,
      'a fresh outage is reported again',
    ).to.equal(1);
  });
});
