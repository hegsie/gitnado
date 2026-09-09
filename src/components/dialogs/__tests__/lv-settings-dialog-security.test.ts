/**
 * The Security section of Settings.
 *
 * `offlineMode`, `confirmNetworkOps` and `remoteAllowlist` shipped as a complete
 * store slice with setters that had zero callers and no UI anywhere — the gate
 * they drive could never be switched on. Worse, the gate's own block message
 * told the user to "Disable in Settings > Security", a screen that did not
 * exist. These tests hold the section in place.
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

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

function textEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  const event = new Event('change', { bubbles: true });
  Object.defineProperty(event, 'target', { value: input, writable: false });
  return event;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('lv-settings-dialog Security section', () => {
  let el: LvSettingsDialog;

  beforeEach(async () => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  it('renders a Security section', () => {
    const titles = Array.from(el.shadowRoot!.querySelectorAll('.section-title')).map(
      (n) => n.textContent?.trim(),
    );
    expect(titles).to.include('Security');
  });

  it('the Security switches carry an accessible name and reach the store when clicked', async () => {
    // The switches used to be a bare <input type="checkbox"> whose visible
    // label was an unlinked sibling, so a screen reader announced them as
    // unnamed. lv-toggle names them and reports through a `change` event.
    const toggles = Array.from(el.shadowRoot!.querySelectorAll('lv-toggle'));
    const offline = toggles.find((t) => t.label === 'Offline Mode');
    expect(offline, 'the Offline Mode switch is named').to.exist;
    expect(offline!.description).to.contain('Block every operation');

    const button = offline!.shadowRoot!.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(button.getAttribute('aria-checked')).to.equal('false');

    button.click();
    expect(settingsStore.getState().offlineMode).to.equal(true);

    await el.updateComplete;
    await offline!.updateComplete;
    expect(button.getAttribute('aria-checked')).to.equal('true');
  });

  it('the offline-mode toggle writes to the store', () => {
    (el as any).handleToggle('offlineMode', true);
    expect(settingsStore.getState().offlineMode).to.equal(true);

    (el as any).handleToggle('offlineMode', false);
    expect(settingsStore.getState().offlineMode).to.equal(false);
  });

  it('the confirm-network-operations toggle writes to the store', () => {
    (el as any).handleToggle('confirmNetworkOps', true);
    expect(settingsStore.getState().confirmNetworkOps).to.equal(true);
  });

  it('the allowlist field parses a comma-separated list', () => {
    (el as any).handleRemoteAllowlistChange(textEvent('github.com, gitlab.com'));
    expect(settingsStore.getState().remoteAllowlist).to.deep.equal(['github.com', 'gitlab.com']);
  });

  it('an empty allowlist field means "allow all", not "allow nothing named blank"', () => {
    (el as any).handleRemoteAllowlistChange(textEvent('github.com'));
    (el as any).handleRemoteAllowlistChange(textEvent('   ,  '));
    expect(settingsStore.getState().remoteAllowlist).to.deep.equal([]);
  });

  it('each Security control dispatches settings-changed', () => {
    let fired = 0;
    const onChange = (): void => { fired++; };
    window.addEventListener('settings-changed', onChange);
    try {
      (el as any).handleToggle('offlineMode', true);
      (el as any).handleToggle('confirmNetworkOps', true);
      (el as any).handleRemoteAllowlistChange(textEvent('github.com'));
    } finally {
      window.removeEventListener('settings-changed', onChange);
    }
    expect(fired).to.equal(3);
  });

  it('offline mode and the allowlist also dispatch ai-settings-changed', () => {
    // Both decide whether a cloud AI provider may be reached, so the surfaces
    // that cache "is AI available" — the commit panel, the merge editor — have
    // to re-ask rather than keep offering a button the gate will now refuse.
    let fired = 0;
    const onChange = (): void => { fired++; };
    window.addEventListener('ai-settings-changed', onChange);
    try {
      (el as any).handleToggle('offlineMode', true);
      expect(fired, 'the offline toggle invalidates AI availability').to.equal(1);

      (el as any).handleRemoteAllowlistChange(textEvent('github.com'));
      expect(fired, 'the allowlist invalidates AI availability').to.equal(2);

      (el as any).handleToggle('confirmNetworkOps', true);
      expect(fired, 'the confirm prompt has no say over AI').to.equal(2);
    } finally {
      window.removeEventListener('ai-settings-changed', onChange);
    }
  });

  it('says offline mode covers cloud AI providers and spares local ones', () => {
    const descriptions = Array.from(el.shadowRoot!.querySelectorAll('.setting-description')).map(
      (n) => n.textContent ?? '',
    );
    const offline = descriptions.find((d) => d.includes('Block every operation'));
    expect(offline, 'the offline-mode description must be findable').to.not.be.undefined;
    // The setting now blocks them, so the description has to say so.
    expect(offline!).to.contain('cloud AI');
    expect(offline!, 'local AI keeps working and users need to know').to.contain('Ollama');
  });

  it('Test provider reports the security setting that refused it', async () => {
    // "Check your API key" sent the user to fix a key that was never the
    // problem when it was offline mode blocking the call.
    settingsStore.setState({ offlineMode: true });

    await (el as any).handleTestProvider('open_ai');
    await el.updateComplete;

    expect((el as any).testingProvider, 'the Test button must not stay spinning').to.equal(null);
    expect((el as any).providerTestStatus.open_ai).to.equal('failed');
    expect((el as any).aiError).to.contain('Offline mode');
    expect((el as any).aiError).to.not.contain('API key');
  });

  it('Test provider still blames the API key when nothing is blocking', async () => {
    await (el as any).handleTestProvider('open_ai');
    await el.updateComplete;

    expect((el as any).aiError).to.contain('API key');
  });

  it('loads the persisted values so the toggles reflect reality when reopened', async () => {
    settingsStore.setState({
      offlineMode: true,
      confirmNetworkOps: true,
      remoteAllowlist: ['example.com'],
    });

    const reopened = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );
    await reopened.updateComplete;

    expect((reopened as any).offlineMode).to.equal(true);
    expect((reopened as any).confirmNetworkOps).to.equal(true);
    expect((reopened as any).remoteAllowlist).to.deep.equal(['example.com']);
  });
});
