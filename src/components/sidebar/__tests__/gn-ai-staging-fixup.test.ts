/**
 * Tests for Hunk-Level AI Staging (#619) and AI Fixup Targeting (#620):
 * - gn-ai-staging-modal ('hunk-split' and 'fixup' modes)
 * - ai-staging.service network policy gating
 * - gn-commit-panel integration triggers & message population
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: () => 0,
  unregisterListener: () => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { settingsStore } from '../../../stores/settings.store.ts';
import {
  suggestHunkSplits,
  suggestFixupTargets,
  type AiHunkSplitGroup,
  type FixupTargetSuggestion,
} from '../../../services/ai-staging.service.ts';
import type { GnAiStagingModal } from '../gn-ai-staging-modal.ts';
import type { GnCommitPanel } from '../gn-commit-panel.ts';
import '../gn-ai-staging-modal.ts';
import '../gn-commit-panel.ts';

const REPO_PATH = '/test/repo';

const SAMPLE_HUNK_GROUPS: AiHunkSplitGroup[] = [
  {
    commitMessage: 'fix(parser): handle empty token stream',
    description: 'Guard against empty input before reading first token',
    hunks: [
      {
        filePath: 'src/parser.ts',
        hunkIndex: 0,
        header: '@@ -12,4 +12,7 @@ function parseTokens',
        summary: '+3/-0 in `function parseTokens`: if (tokens.length === 0) return [];',
      },
    ],
  },
  {
    commitMessage: 'feat(parser): support trailing commas',
    description: 'Allow trailing comma in array literals within the same file',
    hunks: [
      {
        filePath: 'src/parser.ts',
        hunkIndex: 1,
        header: '@@ -88,5 +91,9 @@ function parseArray',
        summary: '+4/-1 in `function parseArray`: allowTrailingComma = true',
      },
    ],
  },
];

const SAMPLE_FIXUP_TARGETS: FixupTargetSuggestion[] = [
  {
    commitOid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shortOid: 'a1b2c3d',
    commitSummary: 'feat(parser): add array literal parser',
    author: 'Alice Dev',
    confidence: 0.91,
    overlappingFiles: ['src/parser.ts'],
    overlappingHunks: 2,
    rationale: 'Modifies 2 overlapping hunks in src/parser.ts introduced by `a1b2c3d`',
  },
  {
    commitOid: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
    shortOid: 'f6e5d4c',
    commitSummary: 'refactor(parser): extract token helpers',
    author: 'Bob Dev',
    confidence: 0.42,
    overlappingFiles: ['src/parser.ts'],
    overlappingHunks: 0,
    rationale: 'Touches the same file (src/parser.ts) in non-overlapping line ranges',
  },
];

describe('gn-ai-staging-modal & ai-staging.service (#619, #620)', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    settingsStore.setState({
      offlineMode: false,
      remoteAllowlist: [],
    });
    mockInvoke = async (command: string) => {
      switch (command) {
        case 'suggest_hunk_splits':
          return SAMPLE_HUNK_GROUPS;
        case 'stage_hunk_group':
          return 1;
        case 'suggest_fixup_targets':
          return SAMPLE_FIXUP_TARGETS;
        case 'create_commit':
          return {
            oid: '9999999',
            shortId: '9999999',
            summary: 'fixup! feat(parser): add array literal parser',
          };
        case 'list_templates':
        case 'get_conventional_types':
          return [];
        case 'get_user_identity':
          return { name: 'Test User', email: 'test@example.com' };
        case 'is_ai_available':
          return true;
        case 'plugin:notification|is_permission_granted':
          return false;
        default:
          return null;
      }
    };
  });

  it('renders hunk split groups and stages a group on button click', async () => {
    const el = await fixture<GnAiStagingModal>(html`
      <gn-ai-staging-modal
        .open=${true}
        .repositoryPath=${REPO_PATH}
        .mode=${'hunk-split'}
      ></gn-ai-staging-modal>
    `);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const cards = el.shadowRoot!.querySelectorAll('.hunk-group-card');
    expect(cards.length).to.equal(2);
    expect(cards[0].textContent).to.include('fix(parser): handle empty token stream');
    expect(cards[0].textContent).to.include('@@ -12,4 +12,7 @@ function parseTokens');

    let stagedEventDetail: Record<string, unknown> | null = null;
    el.addEventListener('staging-changed', (e: Event) => {
      stagedEventDetail = (e as CustomEvent).detail;
    });

    const stageBtn = cards[0].querySelector('.stage-hunk-group-btn') as HTMLButtonElement;
    expect(stageBtn).to.exist;
    stageBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const stageCall = invokeHistory.find((c) => c.command === 'stage_hunk_group');
    expect(stageCall).to.exist;
    expect((stageCall!.args as Record<string, unknown>).path).to.equal(REPO_PATH);
    expect(stagedEventDetail).to.not.be.null;
    expect(stagedEventDetail!.commitMessage).to.equal(
      'fix(parser): handle empty token stream',
    );
  });

  it('renders ranked fixup targets and creates a fixup! commit on click', async () => {
    const el = await fixture<GnAiStagingModal>(html`
      <gn-ai-staging-modal
        .open=${true}
        .repositoryPath=${REPO_PATH}
        .mode=${'fixup'}
      ></gn-ai-staging-modal>
    `);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const cards = el.shadowRoot!.querySelectorAll('.fixup-target-card');
    expect(cards.length).to.equal(2);
    expect(cards[0].textContent).to.include('feat(parser): add array literal parser');
    expect(cards[0].textContent).to.include('91% confidence');
    expect(cards[0].textContent).to.include('2 overlapping hunks');

    let commitCreatedDetail: Record<string, unknown> | null = null;
    el.addEventListener('commit-created', (e: Event) => {
      commitCreatedDetail = (e as CustomEvent).detail;
    });

    const fixupBtn = cards[0].querySelector('.create-fixup-btn') as HTMLButtonElement;
    expect(fixupBtn).to.exist;
    fixupBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const commitCall = invokeHistory.find((c) => c.command === 'create_commit');
    expect(commitCall).to.exist;
    expect((commitCall!.args as Record<string, unknown>).message).to.equal(
      'fixup! feat(parser): add array literal parser',
    );
    expect(commitCreatedDetail).to.not.be.null;
  });

  it('enforces network policy gating when offlineMode is enabled with a cloud AI provider', async () => {
    settingsStore.setState({
      offlineMode: true,
      remoteAllowlist: [],
    });

    mockInvoke = async (command: string) => {
      if (command === 'get_active_ai_provider') return 'open_ai';
      if (command === 'get_ai_providers') {
        return [
          {
            providerType: 'open_ai',
            name: 'OpenAI',
            available: true,
            probed: false,
            requiresApiKey: true,
            hasApiKey: true,
            endpoint: 'https://api.openai.com/v1',
            models: [],
            selectedModel: null,
          },
        ];
      }
      return [];
    };

    const splitResult = await suggestHunkSplits(REPO_PATH);
    expect(splitResult.success).to.be.false;
    expect(splitResult.error?.code).to.equal('BLOCKED');

    const fixupResult = await suggestFixupTargets(REPO_PATH);
    expect(fixupResult.success).to.be.false;
    expect(fixupResult.error?.code).to.equal('BLOCKED');

    // Neither backend command may be invoked when blocked by offline mode.
    expect(
      invokeHistory.some(
        (c) =>
          c.command === 'suggest_hunk_splits' ||
          c.command === 'suggest_fixup_targets',
      ),
    ).to.be.false;
  });

  it('opens gn-ai-staging-modal from gn-commit-panel triggers and populates message on staging-changed', async () => {
    const panel = await fixture<GnCommitPanel>(html`
      <gn-commit-panel
        .repositoryPath=${REPO_PATH}
        .stagedCount=${1}
      ></gn-commit-panel>
    `);
    await new Promise((r) => setTimeout(r, 50));
    await panel.updateComplete;

    const hunkSplitBtn = panel.shadowRoot!.querySelector(
      '.hunk-split-btn',
    ) as HTMLButtonElement;
    const fixupTargetBtn = panel.shadowRoot!.querySelector(
      '.fixup-target-btn',
    ) as HTMLButtonElement;
    expect(hunkSplitBtn).to.exist;
    expect(fixupTargetBtn).to.exist;

    hunkSplitBtn.click();
    await panel.updateComplete;

    const modal = panel.shadowRoot!.querySelector(
      'gn-ai-staging-modal',
    ) as GnAiStagingModal;
    expect(modal).to.exist;
    expect(modal.open).to.be.true;
    expect(modal.mode).to.equal('hunk-split');

    modal.dispatchEvent(
      new CustomEvent('staging-changed', {
        detail: {
          commitMessage: 'fix(parser): handle empty token stream',
          description: 'Guard against empty input before reading first token',
        },
        bubbles: true,
        composed: true,
      }),
    );
    await panel.updateComplete;

    const summaryInput = panel.shadowRoot!.querySelector(
      '.summary-input',
    ) as HTMLTextAreaElement;
    const descriptionInput = panel.shadowRoot!.querySelector(
      '.description-input',
    ) as HTMLTextAreaElement;
    expect(summaryInput.value).to.equal('fix(parser): handle empty token stream');
    expect(descriptionInput.value).to.equal(
      'Guard against empty input before reading first token',
    );
  });
});
