/**
 * The Settings dialog's "Show Avatars" row.
 *
 * Avatars are images fetched from gravatar.com — the only thing on this screen
 * that sends anything to a third party — so the row has to say so, and it has
 * to stop offering a toggle that Offline Mode or the remote allowlist has
 * already taken away.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  switch (command) {
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
  transformCallback: () => 0,
};
(
  globalThis as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import type { LvToggle } from '../../common/lv-toggle.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

/** The `.setting-row` whose `.setting-name` reads exactly "Show Avatars". */
function avatarRow(el: LvSettingsDialog): HTMLElement {
  const rows = [...el.renderRoot.querySelectorAll('.setting-row')] as HTMLElement[];
  const row = rows.find(
    (r) => r.querySelector('.setting-name')?.textContent?.trim() === 'Show Avatars'
  );
  expect(row, 'the Show Avatars row exists').to.not.be.undefined;
  return row!;
}

function avatarToggle(el: LvSettingsDialog): LvToggle {
  return avatarRow(el).querySelector('lv-toggle') as LvToggle;
}

/** Click the switch the way a user would — through its shadow `role="switch"`. */
function clickToggle(toggle: LvToggle): void {
  toggle.shadowRoot!.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
}

function reasonText(el: LvSettingsDialog): string | null {
  return avatarRow(el).querySelector('.setting-unavailable-reason')?.textContent?.trim() ?? null;
}

describe('lv-settings-dialog Show Avatars row', () => {
  let el: LvSettingsDialog;

  async function open(): Promise<void> {
    el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
  }

  beforeEach(() => {
    settingsStore.getState().resetToDefaults();
  });

  afterEach(() => {
    settingsStore.getState().resetToDefaults();
  });

  it('names Gravatar, the third party, and what is sent to it', async () => {
    await open();

    const description = avatarRow(el).querySelector('.setting-description')?.textContent ?? '';
    expect(description).to.match(/gravatar/i);
    expect(description).to.match(/third-party/i);
    expect(description).to.match(/hash/i);
    expect(description).to.match(/email/i);
    expect(description, 'says Offline Mode disables it').to.match(/offline mode/i);

    // The switch itself is named and described, not just the visible text.
    const toggle = avatarToggle(el);
    expect(toggle.label).to.equal('Show Avatars');
    expect(toggle.description).to.match(/gravatar/i);
  });

  it('is off and enabled with the shipped defaults', async () => {
    await open();

    const toggle = avatarToggle(el);
    expect(toggle.checked, 'avatars are opt-in').to.be.false;
    expect(toggle.disabled).to.be.false;
    expect(reasonText(el)).to.equal(null);
    expect(avatarRow(el).classList.contains('setting-unavailable')).to.be.false;
  });

  it('turning it on updates the store', async () => {
    await open();

    const toggle = avatarToggle(el);
    expect(toggle.checked).to.be.false;
    clickToggle(toggle);
    await el.updateComplete;

    expect(settingsStore.getState().showAvatars).to.be.true;
    expect(avatarToggle(el).checked, 'the switch follows the store').to.be.true;
  });

  it('is disabled with the reason shown when offline mode is on', async () => {
    settingsStore.getState().setOfflineMode(true);
    await open();

    const toggle = avatarToggle(el);
    expect(toggle.disabled, 'the toggle is not offered').to.be.true;
    expect(avatarRow(el).classList.contains('setting-unavailable')).to.be.true;
    expect(reasonText(el)).to.match(/offline mode/i);
    expect(reasonText(el)).to.match(/gravatar\.com/i);
  });

  it('is disabled when an allowlist excludes gravatar.com', async () => {
    settingsStore.getState().setRemoteAllowlist(['github.com']);
    await open();

    expect(avatarToggle(el).disabled).to.be.true;
    expect(reasonText(el)).to.match(/allowlist/i);
    expect(reasonText(el)).to.contain('www.gravatar.com');
  });

  it('stays enabled when the allowlist includes gravatar.com', async () => {
    settingsStore.getState().setRemoteAllowlist(['gravatar.com']);
    await open();

    expect(avatarToggle(el).disabled).to.be.false;
    expect(reasonText(el)).to.equal(null);
  });

  it('disables the row as soon as Offline Mode is switched on in the same dialog', async () => {
    await open();
    expect(avatarToggle(el).disabled).to.be.false;

    // Toggle the Offline Mode row the way a user would.
    const rows = [...el.renderRoot.querySelectorAll('.setting-row')] as HTMLElement[];
    const offlineRow = rows.find(
      (r) => r.querySelector('.setting-name')?.textContent?.trim() === 'Offline Mode'
    );
    expect(offlineRow, 'the Offline Mode row exists').to.not.be.undefined;
    clickToggle(offlineRow!.querySelector('lv-toggle') as LvToggle);
    await el.updateComplete;

    expect(settingsStore.getState().offlineMode).to.be.true;
    expect(avatarToggle(el).disabled, 'avatars can no longer be switched on').to.be.true;
    expect(reasonText(el)).to.match(/offline mode/i);
  });

  it('leaves an already-on setting visible but unavailable while offline', async () => {
    // The user's choice is not silently rewritten — it just cannot take
    // effect, and the row says why.
    settingsStore.getState().setShowAvatars(true);
    settingsStore.getState().setOfflineMode(true);
    await open();

    const toggle = avatarToggle(el);
    expect(toggle.checked, 'the stored choice is still shown').to.be.true;
    expect(toggle.disabled).to.be.true;
    expect(settingsStore.getState().showAvatars, 'the store is untouched').to.be.true;
  });
});
