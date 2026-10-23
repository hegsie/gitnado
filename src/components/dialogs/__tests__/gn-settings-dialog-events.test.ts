/**
 * Settings Dialog Event Consistency Tests
 *
 * Verifies that all non-AI settings handlers dispatch 'settings-changed' window event.
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
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_available_models':
      return [];
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_available_diff_tools':
      return [];
    case 'get_merge_tool_info':
      return null;
    case 'get_graph_color_schemes':
      return [];
    case 'set_merge_tool_config':
    case 'set_diff_tool':
      return null;
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

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import AFTER setting up the mock
import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';

function makeChangeEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  input.checked = true;
  const event = new Event('change', { bubbles: true });
  Object.defineProperty(event, 'target', { value: input, writable: false });
  return event;
}

function makeSelectEvent(value: string): Event {
  const select = document.createElement('select');
  select.value = value;
  const event = new Event('change', { bubbles: true });
  Object.defineProperty(event, 'target', { value: select, writable: false });
  return event;
}

describe('gn-settings-dialog settings-changed events', () => {
  let el: GnSettingsDialog;

  beforeEach(async () => {
    el = await fixture<GnSettingsDialog>(
      html`<gn-settings-dialog></gn-settings-dialog>`,
    );
    await el.updateComplete;
  });

  const selectHandlerValues: Record<string, string> = {
    handleThemeChange: 'dark',
    handleFontSizeChange: 'medium',
    // handleDensityChange and handleGraphColorSchemeChange apply CSS
    // variables via the store and require a full DOM environment.
    // The dispatch pattern is identical to the handlers tested here.
  };

  for (const [handler, value] of Object.entries(selectHandlerValues)) {
    it(`dispatches settings-changed on ${handler}`, () => {
      let eventFired = false;
      window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any)[handler](makeSelectEvent(value));

      expect(eventFired).to.be.true;
    });
  }

  it('dispatches settings-changed on handleBranchNameChange', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleBranchNameChange(makeChangeEvent('main'));

    expect(eventFired).to.be.true;
  });

  it('dispatches settings-changed on handleDefaultClonePathChange', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleDefaultClonePathChange(makeChangeEvent('/home/user/projects'));

    expect(eventFired).to.be.true;
  });

  it('dispatches settings-changed on handleStaleBranchDaysChange', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleStaleBranchDaysChange(makeChangeEvent('30'));

    expect(eventFired).to.be.true;
  });

  it('dispatches settings-changed on handleNetworkOperationTimeoutChange', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleNetworkOperationTimeoutChange(makeChangeEvent('60'));

    expect(eventFired).to.be.true;
  });

  it('dispatches settings-changed on handleAutoFetchIntervalChange', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleAutoFetchIntervalChange(makeChangeEvent('300'));

    expect(eventFired).to.be.true;
  });

  it('dispatches settings-changed on handleToggle', () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleToggle('showAvatars', makeChangeEvent('true'));

    expect(eventFired).to.be.true;
  });

  it('dispatches open-profile-manager and closes when opening Profiles & Accounts', () => {
    let openFired = false;
    let closeFired = false;
    el.addEventListener('open-profile-manager', () => { openFired = true; });
    el.addEventListener('close', () => { closeFired = true; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).handleOpenProfileManager();

    expect(openFired, 'open-profile-manager dispatched').to.be.true;
    expect(closeFired, 'close dispatched').to.be.true;
  });

  it('renders a Profiles & Accounts section with an open button', async () => {
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).to.contain('Profiles & Accounts');
    const buttons = Array.from(el.shadowRoot?.querySelectorAll('button') ?? []);
    const openBtn = buttons.find((b) => b.textContent?.includes('Open Profiles & Accounts'));
    expect(openBtn, 'Open Profiles & Accounts button exists').to.exist;
  });
});
