/**
 * The footer's "Reset to Defaults" button.
 *
 * It used to call `resetToDefaults()` straight from the click: no confirmation
 * for an action that wipes the remote allowlist, offline mode, the default
 * clone path and every other preference on this screen; no `settings-changed`
 * dispatch, which every other handler in this dialog performs and which
 * app-shell listens to in order to repaint avatars, commit size, graph colours
 * and stale-branch marking; and no feedback that anything happened at all.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

/** The answer `plugin:dialog|message` returns, or an Error it throws. */
let confirmAnswer: string | Error = 'Ok';
let confirmCount = 0;
/** While set, confirms hang until it is called. */
let releaseConfirm: (() => void) | null = null;

const mockInvoke: MockInvoke = async (command: string) => {
  switch (command) {
    case 'plugin:dialog|message': {
      confirmCount++;
      if (releaseConfirm) {
        await new Promise<void>((resolve) => {
          releaseConfirm = resolve;
        });
      }
      if (confirmAnswer instanceof Error) throw confirmAnswer;
      return confirmAnswer;
    }
    case 'plugin:notification|is_permission_granted':
      return false;
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
      return { servers: [], totalTools: 0 };
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    case 'get_available_merge_tools':
      return [{ name: 'meld', displayName: 'Meld' }];
    case 'list_diff_tools':
      return [{ name: 'meld', command: 'meld', available: true }];
    default:
      return null;
  }
};

(
  globalThis as unknown as {
    __TAURI_INTERNALS__: { invoke: MockInvoke; transformCallback: () => number };
  }
).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  // The dialog subscribes to model-download events on connect; without these two
  // the subscribe/unsubscribe throw outside any test and bury real failures in
  // noise.
  transformCallback: () => 0,
};
(globalThis as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ =
  { unregisterListener: () => {} };

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Records whether a window event of `name` reaches window. */
function watchWindowEvent(name: string): { fired: () => boolean; stop: () => void } {
  let seen = false;
  const listener = (): void => {
    seen = true;
  };
  window.addEventListener(name, listener);
  return {
    fired: () => seen,
    stop: () => window.removeEventListener(name, listener),
  };
}

/** Records whether a `settings-changed` event reaches window. */
function watchSettingsChanged(): { fired: () => boolean; stop: () => void } {
  return watchWindowEvent('settings-changed');
}

describe('lv-settings-dialog Reset to Defaults', () => {
  let el: LvSettingsDialog;
  let watcher: { fired: () => boolean; stop: () => void };
  let aiWatcher: { fired: () => boolean; stop: () => void };

  beforeEach(async () => {
    confirmAnswer = 'Ok';
    confirmCount = 0;
    releaseConfirm = null;
    // Non-default values on both a visual setting and the security slice, so a
    // reset is unmistakable in either direction.
    settingsStore.setState({
      theme: 'light',
      staleBranchDays: 99,
      remoteAllowlist: ['evil.example'],
    });
    uiStore.setState({ toasts: [] });
    watcher = watchSettingsChanged();
    aiWatcher = watchWindowEvent('ai-settings-changed');
    el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(() => {
    watcher.stop();
    aiWatcher.stop();
    releaseConfirm = null;
    settingsStore.getState().resetToDefaults();
    uiStore.setState({ toasts: [] });
  });

  it('confirming the reset dispatches settings-changed so the rest of the app repaints', async () => {
    await (el as any).handleReset();

    expect(confirmCount, 'the user was asked once').to.equal(1);
    expect(settingsStore.getState().theme).to.equal('dark');
    expect(settingsStore.getState().staleBranchDays).to.equal(90);
    expect(settingsStore.getState().remoteAllowlist).to.deep.equal([]);
    expect(watcher.fired(), 'settings-changed dispatched').to.equal(true);
  });

  it('announces ai-settings-changed so the AI buttons drop their stale reason', async () => {
    // Offline mode on: the commit panel's Generate / Vibe Check buttons are
    // disabled with "offline mode is on" cached from the last
    // `ai-settings-changed`. Reset turns offline mode off — and those buttons
    // listen to NOTHING ELSE, so without this event they keep refusing on a
    // setting that is no longer set.
    settingsStore.setState({ offlineMode: true });

    await (el as any).handleReset();

    expect(settingsStore.getState().offlineMode, 'offline mode cleared').to.equal(false);
    expect(aiWatcher.fired(), 'ai-settings-changed dispatched').to.equal(true);
  });

  it('declining the reset announces nothing to the AI surfaces either', async () => {
    confirmAnswer = 'Cancel';
    settingsStore.setState({ offlineMode: true });

    await (el as any).handleReset();

    expect(settingsStore.getState().offlineMode, 'untouched').to.equal(true);
    expect(aiWatcher.fired(), 'nothing changed, so nothing announced').to.equal(false);
  });

  it('declining the confirm leaves every setting untouched', async () => {
    confirmAnswer = 'Cancel';

    await (el as any).handleReset();

    expect(confirmCount, 'the user was asked').to.equal(1);
    expect(settingsStore.getState().theme).to.equal('light');
    expect(settingsStore.getState().staleBranchDays).to.equal(99);
    expect(settingsStore.getState().remoteAllowlist).to.deep.equal(['evil.example']);
    expect(watcher.fired(), 'nothing changed, so nothing announced').to.equal(false);
    expect(uiStore.getState().toasts.length).to.equal(0);
  });

  it('shows a success toast so the user knows the reset landed', async () => {
    await (el as any).handleReset();

    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('success');
    expect(toasts[0].message).to.match(/reset/i);
  });

  it('treats a failed confirm prompt as declined, not as approval', async () => {
    confirmAnswer = new Error('ipc down');

    await (el as any).handleReset();

    expect(settingsStore.getState().theme).to.equal('light');
    expect(settingsStore.getState().remoteAllowlist).to.deep.equal(['evil.example']);
    expect(watcher.fired()).to.equal(false);
    expect(uiStore.getState().toasts.length).to.equal(0);
  });

  it('raises one prompt for a double-click, not two', async () => {
    releaseConfirm = () => {};
    const first = (el as any).handleReset() as Promise<void>;
    await new Promise((r) => setTimeout(r, 10));
    const second = (el as any).handleReset() as Promise<void>;
    await new Promise((r) => setTimeout(r, 10));
    const release = releaseConfirm;
    releaseConfirm = null;
    release?.();
    await Promise.all([first, second]);

    expect(confirmCount, 'one prompt for one gesture').to.equal(1);
    expect(uiStore.getState().toasts.length, 'one confirmation, not two').to.equal(1);
  });

  it('disables the reset button while the confirm is open', async () => {
    releaseConfirm = () => {};
    const pending = (el as any).handleReset() as Promise<void>;
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.footer button.danger')!;
    expect(button.textContent?.trim()).to.equal('Reset to Defaults');
    expect(button.disabled, 'disabled while the prompt is up').to.equal(true);

    const release = releaseConfirm;
    releaseConfirm = null;
    release?.();
    await pending;
    await el.updateComplete;

    expect(button.disabled, 're-enabled once the prompt is answered').to.equal(false);
  });
});
