/** Settings → Agent Guardrails (#609): the push guardrail's three settings. */
import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let nextId = 1;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  // The dialog listens for model-download events on connect and unlistens on
  // disconnect; answer both so the event plugin does not throw outside a test.
  if (command === 'plugin:event|listen') return nextId++;
  if (command === 'plugin:event|unlisten') return null;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
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
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    case 'get_available_merge_tools':
      return [];
    case 'list_diff_tools':
      return [];
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
  transformCallback: () => nextId++,
};

// `unlisten()` pokes the event plugin's own internals before the IPC call.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// Import AFTER setting up the mock
import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

describe('gn-settings-dialog Agent Guardrails section', () => {
  let el: GnSettingsDialog;
  const q = <T extends Element>(sel: string) => el.shadowRoot!.querySelector<T>(sel)!;

  beforeEach(async () => {
    settingsStore.getState().setPushGuardrail('warn');
    settingsStore.getState().setPushGuardrailScope('agent');
    settingsStore.getState().setAgentBranchPattern('agent/*');
    el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await el.updateComplete;
  });

  it('shows the stored values, defaulting to warn on agent branches', async () => {
    expect(q('#agent-guardrails').textContent).to.contain('Agent Guardrails');
    expect(q<HTMLSelectElement>('#push-guardrail-select').value).to.equal('warn');
    expect(q<HTMLSelectElement>('#push-guardrail-scope-select').value).to.equal('agent');
    expect(q<HTMLInputElement>('#agent-branch-pattern-input').value).to.equal('agent/*');
  });

  it('writes each change to the store and announces it', async () => {
    let events = 0;
    const onChange = () => { events++; };
    window.addEventListener('settings-changed', onChange);
    try {
      const mode = q<HTMLSelectElement>('#push-guardrail-select');
      mode.value = 'block';
      mode.dispatchEvent(new Event('change'));
      const scope = q<HTMLSelectElement>('#push-guardrail-scope-select');
      scope.value = 'all';
      scope.dispatchEvent(new Event('change'));
      expect(settingsStore.getState().pushGuardrail).to.equal('block');
      expect(settingsStore.getState().pushGuardrailScope).to.equal('all');

      scope.value = 'agent';
      scope.dispatchEvent(new Event('change'));
      await el.updateComplete;
      const pattern = q<HTMLInputElement>('#agent-branch-pattern-input');
      pattern.value = ' agent/*, claude/* ';
      pattern.dispatchEvent(new Event('change'));
      expect(settingsStore.getState().agentBranchPattern).to.equal('agent/*, claude/*');
      expect(events).to.equal(4);
    } finally {
      window.removeEventListener('settings-changed', onChange);
    }
  });

  it('an emptied pattern falls back to the default instead of matching nothing', async () => {
    const pattern = q<HTMLInputElement>('#agent-branch-pattern-input');
    pattern.value = '   ';
    pattern.dispatchEvent(new Event('change'));
    expect(settingsStore.getState().agentBranchPattern).to.equal('agent/*');
  });

  it('disables the dependent fields when they do not apply', async () => {
    const scope = q<HTMLSelectElement>('#push-guardrail-scope-select');
    scope.value = 'all';
    scope.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(q<HTMLInputElement>('#agent-branch-pattern-input').disabled).to.be.true;

    const mode = q<HTMLSelectElement>('#push-guardrail-select');
    mode.value = 'off';
    mode.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(q<HTMLSelectElement>('#push-guardrail-scope-select').disabled).to.be.true;
  });
});
