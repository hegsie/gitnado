/**
 * Unit tests for `<gn-ai-explain-drawer>` and AI Explain / Branch Naming integrations (#621, #622)
 */

import { expect, fixture, html } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import type { AiExplanation, BranchNameSuggestion } from '../../../services/ai-explain.service.ts';

const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let shouldFailExplain = false;
let activeProvider: string | null = 'ollama';
const mockExplanation: AiExplanation = {
  title: 'Validate OAuth PKCE state parameter',
  intent: 'Prevent cross-site request forgery during OAuth login callbacks.',
  summary: 'Compares the callback state token against the stored PKCE session before token exchange.',
  keyChanges: [
    'Added state token verification in OAuth callback handler',
    'Returned HTTP 403 when state parameter is missing or mismatched',
  ],
  risks: [
    'In-flight OAuth sessions started before upgrade will need to re-authenticate',
  ],
  providerUsed: 'Ollama',
  isLocal: true,
};

const mockBranchSuggestion: BranchNameSuggestion = {
  name: 'feat/oauth-pkce-state-check',
  alternatives: ['fix/oauth-csrf-state', 'refactor/oauth-callback-guard'],
  rationale: 'Reflects the new OAuth PKCE state validation in the working tree.',
};

let cbId = 0;

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => {
    void once;
    void callback;
    return 0;
  },
  unregisterListener: (_event: string, _eventId: number) => {},
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    if (command === 'plugin:notification|is_permission_granted') return false;
    if (command === 'get_active_ai_provider') return activeProvider;
    if (command === 'get_ai_providers') {
      return [
        {
          providerType: 'ollama',
          name: 'Ollama',
          available: true,
          probed: true,
          requiresApiKey: false,
          hasApiKey: false,
          endpoint: 'http://localhost:11434',
          models: ['llama3.2'],
          selectedModel: 'llama3.2',
        },
        {
          providerType: 'open_ai',
          name: 'OpenAI',
          available: true,
          probed: true,
          requiresApiKey: true,
          hasApiKey: true,
          endpoint: 'https://api.openai.com/v1',
          models: ['gpt-4o-mini'],
          selectedModel: 'gpt-4o-mini',
        },
      ];
    }
    if (command === 'explain_git_target_stream' || command === 'explain_git_target') {
      if (shouldFailExplain) {
        throw { code: 'OPERATION_FAILED', message: 'Model inference failed' };
      }
      return mockExplanation;
    }
    if (command === 'suggest_branch_name') {
      return mockBranchSuggestion;
    }
    return null;
  },
  transformCallback: () => cbId++,
};

let copiedText = '';
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: async (text: string) => {
      copiedText = text;
    },
    readText: async () => copiedText,
  },
  configurable: true,
  writable: true,
});

import '../gn-ai-explain-drawer.ts';
import type { GnAiExplainDrawer } from '../gn-ai-explain-drawer.ts';
import '../../dialogs/gn-create-branch-dialog.ts';
import type { GnCreateBranchDialog } from '../../dialogs/gn-create-branch-dialog.ts';

describe('gn-ai-explain-drawer', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    shouldFailExplain = false;
    activeProvider = 'ollama';
    copiedText = '';
    uiStore.setState({ toasts: [] });
    settingsStore.getState().resetToDefaults();
  });

  afterEach(() => {
    settingsStore.getState().resetToDefaults();
  });

  it('loads and renders a structured AI explanation when opened', async () => {
    const el = await fixture<GnAiExplainDrawer>(html`
      <gn-ai-explain-drawer
        .repositoryPath=${'/test/repo'}
        .targetType=${'commit'}
        .targetId=${'abc1234567890'}
        .open=${true}
      ></gn-ai-explain-drawer>
    `);

    await el.updateComplete;
    // Allow async loadExplanation to settle
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const pill = el.shadowRoot!.querySelector('[data-testid="provider-pill"]');
    expect(pill).to.not.be.null;
    expect(pill!.textContent).to.contain('Local · Ollama');

    const title = el.shadowRoot!.querySelector('[data-testid="explanation-title"]');
    expect(title!.textContent).to.equal('Validate OAuth PKCE state parameter');

    const intent = el.shadowRoot!.querySelector('[data-testid="explanation-intent"]');
    expect(intent!.textContent).to.contain('Prevent cross-site request forgery');

    const keyChanges = el.shadowRoot!.querySelectorAll('[data-testid="explanation-key-changes"] li');
    expect(keyChanges.length).to.equal(2);

    const risks = el.shadowRoot!.querySelectorAll('[data-testid="explanation-risks"] li');
    expect(risks.length).to.equal(1);
  });

  it('copies formatted Markdown to the clipboard', async () => {
    const el = await fixture<GnAiExplainDrawer>(html`
      <gn-ai-explain-drawer
        .repositoryPath=${'/test/repo'}
        .targetType=${'commit'}
        .targetId=${'abc1234567890'}
        .open=${true}
      ></gn-ai-explain-drawer>
    `);

    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const copyBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-testid="copy-markdown-btn"]');
    expect(copyBtn).to.not.be.null;
    copyBtn!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(copiedText).to.contain('## Validate OAuth PKCE state parameter');
    expect(copiedText).to.contain('### Key Changes');
    expect(copiedText).to.contain('### Potential Risks');
  });

  it('shows error state and retries when Regenerate/Retry is clicked', async () => {
    shouldFailExplain = true;

    const el = await fixture<GnAiExplainDrawer>(html`
      <gn-ai-explain-drawer
        .repositoryPath=${'/test/repo'}
        .targetType=${'commit'}
        .targetId=${'abc1234567890'}
        .open=${true}
      ></gn-ai-explain-drawer>
    `);

    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const errBox = el.shadowRoot!.querySelector('[data-testid="explain-error"]');
    expect(errBox).to.not.be.null;
    expect(errBox!.textContent).to.contain('Model inference failed');

    shouldFailExplain = false;
    const regenBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-testid="regenerate-btn"]');
    regenBtn!.click();

    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const body = el.shadowRoot!.querySelector('[data-testid="explanation-body"]');
    expect(body).to.not.be.null;
  });

  it('blocks cloud AI provider explanations when offlineMode is enabled', async () => {
    activeProvider = 'open_ai';
    settingsStore.getState().setOfflineMode(true);

    const el = await fixture<GnAiExplainDrawer>(html`
      <gn-ai-explain-drawer
        .repositoryPath=${'/test/repo'}
        .targetType=${'commit'}
        .targetId=${'abc1234567890'}
        .open=${true}
      ></gn-ai-explain-drawer>
    `);

    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const errBox = el.shadowRoot!.querySelector('[data-testid="explain-error"]');
    expect(errBox).to.not.be.null;
    expect(errBox!.textContent).to.contain('Offline mode is enabled');
    expect(
      invokeHistory.some(
        (c) => c.command === 'explain_git_target_stream' || c.command === 'explain_git_target',
      ),
    ).to.be.false;
  });

  it('populates branch name and alternatives via Suggest with AI in gn-create-branch-dialog', async () => {
    const dialog = await fixture<GnCreateBranchDialog>(html`
      <gn-create-branch-dialog .repositoryPath=${'/test/repo'}></gn-create-branch-dialog>
    `);

    dialog.open();
    await dialog.updateComplete;

    const suggestBtn = dialog.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-testid="suggest-branch-ai-btn"]',
    );
    expect(suggestBtn).to.not.be.null;
    suggestBtn!.click();

    await new Promise((r) => setTimeout(r, 10));
    await dialog.updateComplete;

    const input = dialog.shadowRoot!.querySelector<HTMLInputElement>('#branch-name-input');
    expect(input!.value).to.equal('feat/oauth-pkce-state-check');

    const altChips = dialog.shadowRoot!.querySelectorAll<HTMLButtonElement>('.alt-chip');
    expect(altChips.length).to.equal(2);
    altChips[0].click();
    await dialog.updateComplete;

    expect(input!.value).to.equal('fix/oauth-csrf-state');
  });
});
