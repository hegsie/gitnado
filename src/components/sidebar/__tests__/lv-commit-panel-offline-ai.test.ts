/**
 * Offline mode has to reach the AI buttons in the commit panel.
 *
 * "Generate commit message" posts the staged diff to whichever provider is
 * configured. With a cloud provider selected that diff left the machine even
 * with offline mode on, and nothing in the panel said so. The gate in
 * ai.service now refuses those calls; this checks the panel turns the refusal
 * into something the user can see, and never leaves the button spinning.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invoked: string[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push(command);
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// Mock the Tauri event plugin internals (used by @tauri-apps/api/event)
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => { void once; void callback; return 0; },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-commit-panel.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO_PATH = '/test/repo';

interface Panel extends HTMLElement {
  updateComplete: Promise<unknown>;
}

let activeProvider: string | null = 'open_ai';

function generateButton(el: Panel): HTMLButtonElement {
  return el.shadowRoot!.querySelector('.generate-btn') as HTMLButtonElement;
}

function errorText(el: Panel): string | null {
  const node = el.shadowRoot!.querySelector('.error');
  return node ? node.textContent!.replace(/\s+/g, ' ').trim() : null;
}

/** A panel that already believes AI is usable — the state a user is in when
 * they turn offline mode on with the panel open. */
async function readyPanel(): Promise<Panel> {
  const el = await fixture<Panel>(html`
    <lv-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${2}></lv-commit-panel>
  `);
  await el.updateComplete;
  (el as any).aiAvailable = true;
  (el as any).aiUnavailableReason = '';
  await el.updateComplete;
  return el;
}

describe('lv-commit-panel offline mode AI', () => {
  beforeEach(() => {
    invoked.length = 0;
    activeProvider = 'open_ai';
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    mockInvoke = async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return false;
      if (command === 'get_status') return { staged: [], unstaged: [], untracked: [] };
      if (command === 'get_active_ai_provider') return activeProvider;
      if (command === 'is_ai_available') return true;
      if (command === 'generate_commit_message') return { summary: 'feat: x', body: null };
      if (command === 'analyze_staged_changes') {
        return { findings: [], summary: 'ok', riskLevel: 'low', aiAnalysisRan: true, aiError: null };
      }
      if (command === 'suggest_commit_splits') {
        return { shouldSplit: false, groups: [], explanation: '' };
      }
      return null;
    };
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  it('shows why Generate was refused and sends no diff', async () => {
    const el = await readyPanel();
    settingsStore.setState({ offlineMode: true });

    invoked.length = 0;
    generateButton(el).click();
    // click() does not await the async handler; wait for it to settle.
    await waitUntil(() => (el as any).generationError !== null, 'the refusal to be shown');
    await el.updateComplete;

    expect(invoked.includes('generate_commit_message'), 'the staged diff must not leave').to.equal(
      false,
    );
    const message = errorText(el);
    expect(message, 'a refused Generate must not be silent').to.not.be.null;
    expect(message!).to.contain('Offline mode');
    expect(message!, 'the refusal names the provider at fault').to.contain('OpenAI');
  });

  it('leaves the Generate button usable again after a refusal', async () => {
    const el = await readyPanel();
    settingsStore.setState({ offlineMode: true });

    await (el as any).handleGenerateMessage();
    await el.updateComplete;

    expect((el as any).isGenerating, 'the spinner must not be left running').to.equal(false);
    expect(generateButton(el).disabled).to.equal(false);
  });

  it('shows why Vibe Check and Suggest Splits were refused', async () => {
    const el = await readyPanel();
    settingsStore.setState({ offlineMode: true });

    invoked.length = 0;
    await (el as any).handleVibeCheck();
    await el.updateComplete;

    expect(invoked.includes('analyze_staged_changes')).to.equal(false);
    expect(errorText(el)).to.contain('Offline mode');
    expect((el as any).isAnalyzing).to.equal(false);

    (el as any).generationError = null;
    invoked.length = 0;
    await (el as any).handleSuggestSplits();
    await el.updateComplete;

    expect(invoked.includes('suggest_commit_splits')).to.equal(false);
    expect(errorText(el)).to.contain('Offline mode');
    expect((el as any).isAnalyzingSplit).to.equal(false);
  });

  it('still generates offline with a local provider selected', async () => {
    activeProvider = 'ollama';
    const el = await readyPanel();
    settingsStore.setState({ offlineMode: true });

    invoked.length = 0;
    await (el as any).handleGenerateMessage();
    await el.updateComplete;

    expect(invoked.includes('generate_commit_message'), 'Ollama is local').to.equal(true);
    expect(errorText(el)).to.equal(null);
  });

  it('reports AI as unavailable, with the reason on the button, once offline', async () => {
    settingsStore.setState({ offlineMode: true });

    const el = await fixture<Panel>(html`
      <lv-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${2}></lv-commit-panel>
    `);
    await el.updateComplete;
    await (el as any).checkAiAvailability();
    await el.updateComplete;

    expect((el as any).aiAvailable).to.equal(false);
    expect(generateButton(el).title).to.contain('Offline mode');
  });
});
