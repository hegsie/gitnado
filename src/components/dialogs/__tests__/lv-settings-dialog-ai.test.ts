/**
 * Settings Dialog AI Tests
 *
 * Tests that handleModelChange dispatches ai-settings-changed event, and that
 * handleTestProvider reports the tested provider by name.
 */

import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

/** Result returned by the mocked `test_ai_provider` command. */
let testProviderResult: unknown = null;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'test_ai_provider':
      return testProviderResult;
    case 'set_ai_model':
      return null;
    case 'set_ai_provider':
      return null;
    case 'set_ai_api_key':
      return null;
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
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import AFTER setting up the mock
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { providerStatusLabel } from '../lv-settings-dialog.ts';
import type { AiProviderInfo } from '../../../services/ai.service.ts';

describe('lv-settings-dialog AI events', () => {
  it('dispatches ai-settings-changed on model change', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    let eventFired = false;
    window.addEventListener('ai-settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleModelChange('ollama', 'llama3');

    expect(eventFired).to.be.true;
  });

  it('dispatches ai-settings-changed on provider select', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    let eventFired = false;
    window.addEventListener('ai-settings-changed', () => { eventFired = true; }, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleProviderSelect('ollama');

    expect(eventFired).to.be.true;
  });

  // localAiService.loadModel / unloadModel announce `ai-settings-changed`
  // themselves; deleteModel does not, so the dialog has to. Without it the
  // commit panel's Generate / Vibe Check buttons keep the availability answer
  // they cached before the model was deleted.
  it('dispatches ai-settings-changed when a local model is deleted', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    let eventFired = false;
    const listener = (): void => {
      eventFired = true;
    };
    window.addEventListener('ai-settings-changed', listener);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleDeleteModel('qwen-1_5b');
    } finally {
      window.removeEventListener('ai-settings-changed', listener);
    }

    expect(eventFired).to.be.true;
  });
});

describe('lv-settings-dialog provider test feedback', () => {
  beforeEach(() => {
    testProviderResult = null;
  });

  it('names the provider in the failure message', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    testProviderResult = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleTestProvider('open_ai');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiError = (el as any).aiError as string | null;
    expect(aiError).to.equal('OpenAI is not available. Check your API key and try again.');
    expect(aiError).to.not.contain('undefined');
  });

  it('records a failed status for the tested provider', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    testProviderResult = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleTestProvider('open_ai');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).providerTestStatus['open_ai']).to.equal('failed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).testingProvider).to.be.null;
  });

  it('clears the error and records success when the test passes', async () => {
    const el = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`,
    );

    testProviderResult = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).aiError = 'stale error';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleTestProvider('open_ai');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).aiError).to.be.null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).providerTestStatus['open_ai']).to.equal('success');
  });
});

/**
 * With offline mode on, the backend deliberately does NOT probe a cloud
 * provider — listing providers is what Settings renders in order to offer the
 * switch that turns that provider off, and probing it would be an outbound
 * request from the very screen the user opened to stop them. `probed: false`
 * says "not checked", which must not read as "your provider is broken".
 */
describe('lv-settings-dialog provider status label', () => {
  function provider(overrides: Partial<AiProviderInfo>): AiProviderInfo {
    return {
      providerType: 'open_ai',
      name: 'OpenAI',
      available: false,
      probed: true,
      requiresApiKey: true,
      hasApiKey: true,
      endpoint: 'https://api.openai.com/v1',
      models: [],
      selectedModel: null,
      ...overrides,
    };
  }

  it('says a provider was not checked rather than calling it unavailable', () => {
    expect(providerStatusLabel(provider({ probed: false }))).to.equal(
      '(Not checked - offline)',
    );
  });

  it('still reports a probed provider as unavailable', () => {
    expect(providerStatusLabel(provider({ probed: true }))).to.equal('(Unavailable)');
  });

  it('reads as unavailable when the payload has no probed field at all', () => {
    const legacy = provider({}) as Partial<AiProviderInfo>;
    delete legacy.probed;
    expect(providerStatusLabel(legacy as AiProviderInfo)).to.equal('(Unavailable)');
  });

  it('reports an available provider as available', () => {
    expect(providerStatusLabel(provider({ available: true }))).to.equal('(Available)');
  });

  it('still asks for a missing API key before anything else', () => {
    expect(
      providerStatusLabel(provider({ hasApiKey: false, probed: false })),
    ).to.equal('(API key required)');
  });
});
