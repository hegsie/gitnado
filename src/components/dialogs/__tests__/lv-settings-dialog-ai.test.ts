/**
 * Settings Dialog AI Tests
 *
 * Tests that handleModelChange dispatches ai-settings-changed event, and that
 * handleTestProvider reports the tested provider by name.
 */

import { expect, fixture, html, waitUntil } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

/** Result returned by the mocked `test_ai_provider` command. */
let testProviderResult: unknown = null;

/**
 * Result returned by the mocked `get_ai_providers` command.
 *
 * Mutable so a test can change what the BACKEND says between two loads, which
 * is the only way to drive the real "flip the setting, watch the label" path:
 * `probed` is the backend's answer and the dialog re-asks for it.
 */
let aiProvidersResult: unknown[] = [];

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    case 'get_ai_providers':
      return aiProvidersResult;
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
import { settingsStore } from '../../../stores/settings.store.ts';
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
 *
 * `probed: false` also comes back when offline mode is OFF and the provider's
 * host is simply not in the remote allowlist (`provider_network_allowed` ->
 * `security::endpoint_allowed` is false for either policy), so the label has to
 * name the policy that actually refused rather than always blaming offline
 * mode — otherwise it sends the user to a switch they never turned on.
 *
 * And it must name it from ONE evaluation of the live policy. `probed` is a
 * backend answer fetched when the dialog opens; offline mode is a switch in the
 * section directly above. Pairing the cached verdict with the live flag made
 * the label blame a remote allowlist that did not exist the instant offline
 * mode was switched off — the same complaint inverted.
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

  /** Every policy that is not the one under test, switched off. */
  const nothingBlocking = { offlineMode: false, remoteAllowlist: [] as string[] };

  it('says a provider was not checked rather than calling it unavailable', () => {
    expect(
      providerStatusLabel(provider({ probed: false }), {
        offlineMode: true,
        remoteAllowlist: [],
      }),
    ).to.equal('(Not checked - offline)');
  });

  it('blames the remote allowlist, not offline mode, when offline mode is off', () => {
    expect(
      providerStatusLabel(provider({ probed: false }), {
        offlineMode: false,
        remoteAllowlist: ['github.com'],
      }),
    ).to.equal('(Not checked - not in your remote allowlist)');
  });

  // The state between flipping a policy off and the fresh backend verdict
  // arriving. Naming either policy here is the bug: neither is in force.
  it('blames neither policy when neither is in force', () => {
    expect(providerStatusLabel(provider({ probed: false }), nothingBlocking)).to.equal(
      '(Not checked)',
    );
  });

  // An allowlist the provider's host IS on cannot be what refused it either.
  it('does not blame an allowlist that names the provider host', () => {
    expect(
      providerStatusLabel(provider({ probed: false }), {
        offlineMode: false,
        remoteAllowlist: ['api.openai.com'],
      }),
    ).to.equal('(Not checked)');
  });

  // `endpoint_allowed` waves loopback through, so a locally hosted model is
  // never unprobed BECAUSE of these settings — blaming them would send the user
  // to a switch that would not have changed anything.
  it('never blames a policy for a provider that never leaves the machine', () => {
    const local = provider({
      providerType: 'ollama',
      name: 'Ollama',
      requiresApiKey: false,
      hasApiKey: false,
      probed: false,
      endpoint: 'http://localhost:11434',
    });
    expect(providerStatusLabel(local, { offlineMode: true, remoteAllowlist: ['github.com'] })).to.equal(
      '(Not checked)',
    );
  });

  it('reads the policy from the settings store when none is passed', () => {
    const store = settingsStore.getState();
    const originalOffline = store.offlineMode;
    const originalAllowlist = store.remoteAllowlist;
    try {
      settingsStore.getState().setOfflineMode(true);
      expect(providerStatusLabel(provider({ probed: false }))).to.equal(
        '(Not checked - offline)',
      );
      settingsStore.getState().setOfflineMode(false);
      settingsStore.getState().setRemoteAllowlist(['github.com']);
      expect(providerStatusLabel(provider({ probed: false }))).to.equal(
        '(Not checked - not in your remote allowlist)',
      );
      settingsStore.getState().setRemoteAllowlist([]);
      expect(providerStatusLabel(provider({ probed: false }))).to.equal('(Not checked)');
    } finally {
      settingsStore.getState().setOfflineMode(originalOffline);
      settingsStore.getState().setRemoteAllowlist(originalAllowlist);
    }
  });

  it('still reports a probed provider as unavailable', () => {
    for (const offlineMode of [true, false]) {
      expect(
        providerStatusLabel(provider({ probed: true }), { offlineMode, remoteAllowlist: [] }),
      ).to.equal('(Unavailable)');
    }
  });

  it('reads as unavailable when the payload has no probed field at all', () => {
    const legacy = provider({}) as Partial<AiProviderInfo>;
    delete legacy.probed;
    for (const offlineMode of [true, false]) {
      expect(
        providerStatusLabel(legacy as AiProviderInfo, { offlineMode, remoteAllowlist: [] }),
      ).to.equal('(Unavailable)');
    }
  });

  it('reports an available provider as available', () => {
    for (const offlineMode of [true, false]) {
      expect(
        providerStatusLabel(provider({ available: true }), { offlineMode, remoteAllowlist: [] }),
      ).to.equal('(Available)');
    }
  });

  it('still asks for a missing API key before anything else', () => {
    for (const offlineMode of [true, false]) {
      expect(
        providerStatusLabel(provider({ hasApiKey: false, probed: false }), {
          offlineMode,
          remoteAllowlist: [],
        }),
      ).to.equal('(API key required)');
    }
  });
});

/**
 * The label as the user actually meets it: rendered inside the open dialog,
 * with the Security section one scroll above it on the SAME page.
 *
 * Calling the exported helper with both arguments supplied consistently is what
 * hid the defect — the component paired a `probed` fetched once on open with an
 * `offlineMode` the switch above rewrites immediately, so the moment the user
 * did what the label told them, it started blaming a remote allowlist they had
 * never configured. These drive the real path: open, toggle, read the label.
 */
describe('lv-settings-dialog provider status label, driven through the dialog', () => {
  const OPEN_AI_OPTION = 'option[value="open_ai"]';

  function unprobedOpenAi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      providerType: 'open_ai',
      name: 'OpenAI',
      available: false,
      probed: false,
      requiresApiKey: true,
      hasApiKey: true,
      endpoint: 'https://api.openai.com/v1',
      models: [],
      selectedModel: null,
      ...overrides,
    };
  }

  let originalOffline: boolean;
  let originalAllowlist: string[];

  beforeEach(() => {
    const store = settingsStore.getState();
    originalOffline = store.offlineMode;
    originalAllowlist = store.remoteAllowlist;
  });

  afterEach(() => {
    aiProvidersResult = [];
    settingsStore.getState().setOfflineMode(originalOffline);
    settingsStore.getState().setRemoteAllowlist(originalAllowlist);
  });

  /** The rendered text of the OpenAI entry in the provider picker. */
  async function openAiOptionText(el: LvSettingsDialog): Promise<string> {
    await el.updateComplete;
    return el.shadowRoot?.querySelector(OPEN_AI_OPTION)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  /** Click the switch in the row whose visible name is `name`, as a user does. */
  async function clickToggle(el: LvSettingsDialog, name: string): Promise<void> {
    const row = Array.from(el.shadowRoot?.querySelectorAll('.setting-row') ?? []).find(
      (candidate) => candidate.querySelector('.setting-name')?.textContent?.trim() === name,
    );
    expect(row, `no setting row named ${name}`).to.exist;
    const toggle = row!.querySelector('lv-toggle') as (HTMLElement & {
      updateComplete: Promise<unknown>;
    }) | null;
    expect(toggle, `no switch in the ${name} row`).to.exist;
    await toggle!.updateComplete;
    const button = toggle!.shadowRoot?.querySelector('button');
    expect(button, `no button in the ${name} switch`).to.exist;
    button!.click();
    await el.updateComplete;
  }

  async function openDialog(): Promise<LvSettingsDialog> {
    const el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await waitUntil(
      () => el.shadowRoot?.querySelector(OPEN_AI_OPTION) !== null,
      'the provider picker never listed OpenAI',
    );
    return el;
  }

  it('stops blaming offline mode the moment the user turns it off — and blames nothing else', async () => {
    settingsStore.getState().setOfflineMode(true);
    settingsStore.getState().setRemoteAllowlist([]);
    aiProvidersResult = [unprobedOpenAi()];

    const el = await openDialog();
    expect(await openAiOptionText(el)).to.contain('(Not checked - offline)');

    // The backend has not answered again yet, so `probed` is still false. What
    // must NOT happen is the label inventing a policy to blame.
    await clickToggle(el, 'Offline Mode');

    const label = await openAiOptionText(el);
    expect(label).to.not.contain('remote allowlist');
    expect(label).to.contain('(Not checked)');
  });

  it('re-asks the backend after the switch, so the label stops saying "not checked"', async () => {
    settingsStore.getState().setOfflineMode(true);
    settingsStore.getState().setRemoteAllowlist([]);
    aiProvidersResult = [unprobedOpenAi()];

    const el = await openDialog();
    expect(await openAiOptionText(el)).to.contain('(Not checked - offline)');

    // With the policy lifted the backend probes the provider for real.
    aiProvidersResult = [unprobedOpenAi({ probed: true, available: true })];
    await clickToggle(el, 'Offline Mode');

    await waitUntil(
      async () => (await openAiOptionText(el)).includes('(Available)'),
      'the provider label never picked up the fresh backend verdict',
    );
  });

  it('names the allowlist, and only while it is the policy in force', async () => {
    settingsStore.getState().setOfflineMode(false);
    settingsStore.getState().setRemoteAllowlist(['github.com']);
    aiProvidersResult = [unprobedOpenAi()];

    const el = await openDialog();
    expect(await openAiOptionText(el)).to.contain('(Not checked - not in your remote allowlist)');

    // Clearing the field is the other way out of this state, and it goes
    // through the same handler the Security row is bound to.
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(
      'input[placeholder="github.com, gitlab.com"]',
    );
    expect(input, 'no remote allowlist field').to.exist;
    input!.value = '';
    input!.dispatchEvent(new Event('change'));

    const label = await openAiOptionText(el);
    expect(label).to.not.contain('remote allowlist');
    expect(label).to.not.contain('offline');
    expect(label).to.contain('(Not checked)');
  });
});
