/**
 * Settings Dialog — lifecycle safety without a Tauri event bridge.
 *
 * The dialog subscribes to three model-download events on connect and drops
 * them on disconnect. Outside a real webview (unit tests, a browser preview)
 * either half can fail: `listen()` rejects when the IPC layer has no
 * `transformCallback`, and the unlisten closure rejects when the event
 * plugin's own internals are absent. Neither may surface as an unhandled
 * rejection — the runner charges those to whichever test is running at the
 * time, so a teardown that rejects fails unrelated tests under load.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = async (command: string) => {
  switch (command) {
    case 'plugin:notification|is_permission_granted':
      return false;
    case 'plugin:event|listen':
      return ++cbId;
    case 'get_ai_providers':
    case 'get_downloaded_models':
    case 'get_available_models':
    case 'get_available_diff_tools':
    case 'get_graph_color_schemes':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    case 'get_system_capabilities':
      return { hasGpu: false, gpuName: null, totalRam: 8 };
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_mcp_status':
      return { running: false, port: 3001, url: null, lastError: null };
    default:
      return null;
  }
};

const tauriInternals: Record<string, unknown> = { invoke: mockInvoke };
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = tauriInternals;

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { collectUnhandledRejections } from '../../../test-utils/unhandled-rejections.ts';

describe('lv-settings-dialog lifecycle without a Tauri event bridge', () => {
  beforeEach(() => {
    delete tauriInternals.transformCallback;
    delete (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  });

  it('connects and disconnects cleanly when listen() itself fails', async () => {
    // No transformCallback: every listen() rejects before the IPC call.
    const rejections = await collectUnhandledRejections(async () => {
      const el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
      await el.updateComplete;
      el.remove();
    });
    expect(rejections, 'no rejection may escape connect or disconnect').to.deep.equal([]);
  });

  it('disconnects cleanly when the listeners attached but the event plugin internals are absent', async () => {
    // listen() succeeds (the mock answers with an id) so the dialog holds
    // three real unlisten closures; each of those reaches for
    // __TAURI_EVENT_PLUGIN_INTERNALS__, which does not exist here.
    tauriInternals.transformCallback = () => ++cbId;

    const el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
    // The three listen() calls are sequential; the last one to land is the
    // error listener.
    await waitUntil(
      () => (el as unknown as { downloadErrorUnlisten: unknown }).downloadErrorUnlisten !== null,
      'the download listeners never attached',
    );

    const rejections = await collectUnhandledRejections(() => {
      el.remove();
    });
    expect(rejections, 'teardown must not reject').to.deep.equal([]);
  });
});
