/**
 * Settings Dialog — automatic high-contrast graph scheme
 *
 * The commit graph is painted into a <canvas>, so the OS cannot recolor it.
 * When forced-colors / prefers-contrast is on, the store auto-selects the
 * high-contrast palette; the Settings row has to say so, and picking a scheme
 * by hand has to pin it and stop the automatic behaviour.
 */

import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    case 'get_system_capabilities':
      return { hasGpu: false, gpuName: null, totalRam: 8 };
    case 'get_downloaded_models':
    case 'get_available_models':
    case 'get_available_diff_tools':
    case 'get_available_merge_tools':
    case 'list_diff_tools':
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    default:
      return null;
  }
};

let nextCallbackId = 1;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  // The dialog subscribes to model-download events on connect; without this the
  // Tauri event shim throws outside the test.
  transformCallback: () => nextCallbackId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// Import AFTER setting up the mock
import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

describe('gn-settings-dialog graph color scheme under forced colors', () => {
  let el: GnSettingsDialog;

  const noteEl = (): Element | null =>
    el.shadowRoot?.querySelector('[data-testid="graph-scheme-auto-note"]') ?? null;

  const schemeSelect = (): HTMLSelectElement => {
    const select = el.shadowRoot?.querySelector<HTMLSelectElement>(
      'select[aria-label="Graph color scheme"]'
    );
    if (!select) throw new Error('graph color scheme select not found');
    return select;
  };

  beforeEach(async () => {
    settingsStore.getState().resetToDefaults();
    settingsStore.getState().applySystemContrast(false);
    el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(() => {
    settingsStore.getState().resetToDefaults();
    settingsStore.getState().applySystemContrast(false);
  });

  it('shows no auto note while the OS is not asking for high contrast', () => {
    expect(noteEl()).to.be.null;
    expect(schemeSelect().value).to.equal('default');
  });

  it('says the scheme is automatic when the OS is in high contrast', async () => {
    settingsStore.getState().applySystemContrast(true);
    await el.updateComplete;

    expect(noteEl(), 'the row explains why the palette changed').to.not.be.null;
    expect(noteEl()?.textContent?.trim()).to.equal('Auto (high contrast)');
    expect(schemeSelect().value).to.equal('high-contrast');
    expect(
      el.shadowRoot?.textContent,
      'the description explains the canvas cannot be recolored by the OS'
    ).to.contain('Following your system high contrast setting');
  });

  it('picking a scheme by hand pins it and drops the auto note', async () => {
    settingsStore.getState().applySystemContrast(true);
    await el.updateComplete;
    expect(noteEl()).to.not.be.null;

    const select = schemeSelect();
    select.value = 'pastel';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    expect(settingsStore.getState().graphColorScheme).to.equal('pastel');
    expect(settingsStore.getState().graphColorSchemeAuto, 'the choice is pinned').to.be.false;
    expect(noteEl(), 'no longer automatic').to.be.null;
  });

  it('keeps the pinned choice when the OS contrast setting changes again', async () => {
    const select = schemeSelect();
    select.value = 'vibrant';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    settingsStore.getState().applySystemContrast(true);
    await el.updateComplete;

    expect(settingsStore.getState().graphColorScheme).to.equal('vibrant');
    expect(schemeSelect().value).to.equal('vibrant');
    expect(noteEl()).to.be.null;
  });

  it('reverts to the default scheme when the OS setting turns off', async () => {
    settingsStore.getState().applySystemContrast(true);
    await el.updateComplete;
    expect(schemeSelect().value).to.equal('high-contrast');

    settingsStore.getState().applySystemContrast(false);
    await el.updateComplete;

    expect(schemeSelect().value).to.equal('default');
    expect(noteEl()).to.be.null;
  });

  it('dispatches settings-changed when the scheme is changed by hand', async () => {
    let fired = false;
    window.addEventListener('settings-changed', () => { fired = true; }, { once: true });

    const select = schemeSelect();
    select.value = 'monochrome';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    expect(fired).to.be.true;
  });

  it('stops mirroring the store once the dialog is disconnected', async () => {
    el.remove();
    await el.updateComplete;

    settingsStore.getState().applySystemContrast(true);

    expect(
      (el as unknown as { graphColorSchemeAuto: boolean; systemHighContrast: boolean })
        .systemHighContrast,
      'the subscription is torn down with the dialog'
    ).to.be.false;
  });
});
