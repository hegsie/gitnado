import { expect, fixture, html } from '@open-wc/testing';
import '../gn-ai-routing-ledger.ts';
import type { GnAiRoutingLedger } from '../gn-ai-routing-ledger.ts';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let invokedCommands: Array<{ command: string; args?: unknown }> = [];
let mockResponses: Record<string, unknown> = {};

(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: ((command: string, args?: unknown) => {
    invokedCommands.push({ command, args });
    if (command in mockResponses) {
      return Promise.resolve(mockResponses[command]);
    }
    return Promise.resolve(null);
  }) as MockInvoke,
  transformCallback: () => 0,
};

describe('gn-ai-routing-ledger', () => {
  beforeEach(() => {
    invokedCommands = [];
    mockResponses = {
      get_ai_providers: [
        {
          providerType: 'local_inference',
          name: 'Local AI (Embedded)',
          available: true,
          probed: true,
          requiresApiKey: false,
          hasApiKey: false,
          endpoint: '',
          models: ['qwen-2.5-coder-7b-q4km'],
          selectedModel: 'qwen-2.5-coder-7b-q4km',
        },
        {
          providerType: 'anthropic',
          name: 'Anthropic Claude',
          available: true,
          probed: true,
          requiresApiKey: true,
          hasApiKey: true,
          endpoint: 'https://api.anthropic.com',
          models: ['claude-haiku-4-5'],
          selectedModel: 'claude-haiku-4-5',
        },
      ],
      get_active_ai_provider: 'local_inference',
      get_ai_task_routes: {},
      get_ai_ledger: [
        {
          id: 1,
          timestamp: 1710000000,
          feature: 'commit_message',
          taskTier: 'fast_text',
          providerType: 'local_inference',
          model: 'qwen-2.5-coder-7b-q4km',
          isLocal: true,
          promptBytes: 400,
          responseBytes: 80,
          estimatedTokens: 120,
          durationMs: 245,
          success: true,
          errorMessage: null,
          promptPreview: 'diff --git a/src/main.rs b/src/main.rs',
        },
      ],
      get_ai_privacy_summary: {
        totalCalls: 1,
        localCalls: 1,
        cloudCalls: 0,
        totalEstimatedTokens: 120,
        localPercentage: 100,
      },
    };
  });

  it('renders 100% Local privacy badge and ledger entry when all calls are local', async () => {
    const el = await fixture<GnAiRoutingLedger>(
      html`<gn-ai-routing-ledger></gn-ai-routing-ledger>`,
    );
    await el.refreshAll();
    await el.updateComplete;

    const badge = el.shadowRoot!.querySelector('#privacy-guarantee-badge');
    expect(badge).to.exist;
    expect(badge!.textContent!.trim()).to.equal('100% Local');

    const rows = el.shadowRoot!.querySelectorAll('.ledger-row');
    expect(rows.length).to.equal(1);
    expect(rows[0].textContent).to.include('commit_message');
    expect(rows[0].textContent).to.include('~120');
  });

  it('updates task route when user selects a provider for a tier', async () => {
    const el = await fixture<GnAiRoutingLedger>(
      html`<gn-ai-routing-ledger></gn-ai-routing-ledger>`,
    );
    await el.refreshAll();
    await el.updateComplete;

    await el.handleTierProviderChange('reasoning_merge', 'anthropic');
    await el.updateComplete;

    const setRouteCall = invokedCommands.find((c) => c.command === 'set_ai_task_route');
    expect(setRouteCall).to.exist;
    expect(setRouteCall!.args).to.deep.equal({
      tier: 'reasoning_merge',
      route: { provider: 'anthropic', model: null },
    });
  });

  it('clears the ledger when Clear Ledger button is clicked', async () => {
    const el = await fixture<GnAiRoutingLedger>(
      html`<gn-ai-routing-ledger></gn-ai-routing-ledger>`,
    );
    await el.refreshAll();
    await el.updateComplete;

    const clearBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('#clear-ledger-btn');
    expect(clearBtn).to.exist;
    await el.handleClearLedger();
    await el.updateComplete;

    const clearCall = invokedCommands.find((c) => c.command === 'clear_ai_ledger');
    expect(clearCall).to.exist;
    expect(el.ledgerEntries.length).to.equal(0);
  });
});
