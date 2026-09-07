/**
 * Tests for lv-commit-panel component
 *
 * Tests core commit behavior: form state, validation, conventional commits,
 * commit message building, history, amend toggle, draft caching, and events.
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

// Mock the Tauri event plugin internals (used by @tauri-apps/api/event)
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => { void once; void callback; return 0; },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { LvCommitPanel } from '../lv-commit-panel.ts';
import '../lv-commit-panel.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function setupDefaultMocks(): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'list_templates':
        return [];
      case 'get_conventional_types':
        return [
          { typeName: 'feat', description: 'A new feature', emoji: '✨' },
          { typeName: 'fix', description: 'A bug fix', emoji: '🐛' },
          { typeName: 'docs', description: 'Documentation changes', emoji: '📝' },
          { typeName: 'refactor', description: 'Code refactoring', emoji: '♻️' },
        ];
      case 'get_commit_template':
        return null;
      case 'get_user_identity':
        return { name: 'Test User', email: 'test@example.com' };
      case 'is_ai_available':
        return false;
      case 'get_commit_history':
        return [
          {
            oid: 'abc123def456',
            shortId: 'abc123d',
            message: 'Last commit message',
            summary: 'Last commit message',
            body: 'Some body text',
            author: { name: 'Test', email: 'test@test.com', timestamp: 0 },
            committer: { name: 'Test', email: 'test@test.com', timestamp: 0 },
            parentIds: [],
            timestamp: 0,
          },
        ];
      case 'create_commit':
        return { shortId: 'new123', oid: 'new123456', summary: 'test commit' };
      default:
        return null;
    }
  };
}

function setupStore(): void {
  repositoryStore.getState().addRepository({
    path: REPO_PATH,
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: null,
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  });
  repositoryStore.getState().setCurrentBranch({
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
  });
}

async function renderCommitPanel(stagedCount = 1): Promise<LvCommitPanel> {
  const el = await fixture<LvCommitPanel>(
    html`<lv-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${stagedCount}></lv-commit-panel>`
  );
  await new Promise(r => setTimeout(r, 100));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-commit-panel', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    localStorage.removeItem('gitnado-commit-history');
    setupDefaultMocks();
    setupStore();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders without errors', async () => {
      const el = await renderCommitPanel();
      expect(el).to.exist;
      expect(el.tagName.toLowerCase()).to.equal('lv-commit-panel');
    });

    it('renders summary textarea', async () => {
      const el = await renderCommitPanel();
      const summary = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summary).to.exist;
      expect(summary.tagName.toLowerCase()).to.equal('textarea');
    });

    it('renders description textarea', async () => {
      const el = await renderCommitPanel();
      const desc = el.shadowRoot!.querySelector('.description-input') as HTMLTextAreaElement;
      expect(desc).to.exist;
    });

    it('renders commit button', async () => {
      const el = await renderCommitPanel();
      const commitBtn = el.shadowRoot!.querySelector('.commit-btn');
      expect(commitBtn).to.exist;
      expect(commitBtn!.textContent).to.include('Commit');
    });

    it('shows staged file count', async () => {
      const el = await renderCommitPanel(3);
      const stagedCount = el.shadowRoot!.querySelector('.staged-count');
      expect(stagedCount).to.exist;
      expect(stagedCount!.textContent).to.include('3');
      expect(stagedCount!.textContent).to.include('files');
    });

    it('shows "1 staged file" for single file', async () => {
      const el = await renderCommitPanel(1);
      const stagedCount = el.shadowRoot!.querySelector('.staged-count');
      expect(stagedCount!.textContent).to.include('1');
      expect(stagedCount!.textContent).to.include('file');
    });

    it('renders amend checkbox', async () => {
      const el = await renderCommitPanel();
      const amendCheckbox = el.shadowRoot!.querySelector('.amend-toggle input') as HTMLInputElement;
      expect(amendCheckbox).to.exist;
      expect(amendCheckbox.type).to.equal('checkbox');
    });

    it('renders conventional commit checkbox', async () => {
      const el = await renderCommitPanel();
      const conventionalCheckbox = el.shadowRoot!.querySelector('.conventional-toggle input') as HTMLInputElement;
      expect(conventionalCheckbox).to.exist;
    });

    it('shows character count', async () => {
      const el = await renderCommitPanel();
      const charCount = el.shadowRoot!.querySelector('.char-count');
      expect(charCount).to.exist;
      expect(charCount!.textContent).to.include('/72');
    });
  });

  // ── Form validation (canCommit) ────────────────────────────────────────
  describe('validation', () => {
    it('disables commit when summary is empty', async () => {
      const el = await renderCommitPanel();
      const commitBtn = el.shadowRoot!.querySelector('.commit-btn') as HTMLButtonElement;
      expect(commitBtn.disabled).to.be.true;
    });

    it('disables commit when no staged files and not amending', async () => {
      const el = await renderCommitPanel(0);
      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit';
      await el.updateComplete;

      const commitBtn = el.shadowRoot!.querySelector('.commit-btn') as HTMLButtonElement;
      expect(commitBtn.disabled).to.be.true;
    });

    it('enables commit when summary and staged files exist', async () => {
      const el = await renderCommitPanel(2);
      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit';
      await el.updateComplete;

      const commitBtn = el.shadowRoot!.querySelector('.commit-btn') as HTMLButtonElement;
      expect(commitBtn.disabled).to.be.false;
    });

    it('enables commit in amend mode even with 0 staged files', async () => {
      const el = await renderCommitPanel(0);
      const internal = el as unknown as { summary: string; amend: boolean };
      internal.summary = 'test commit';
      internal.amend = true;
      await el.updateComplete;

      const commitBtn = el.shadowRoot!.querySelector('.commit-btn') as HTMLButtonElement;
      expect(commitBtn.disabled).to.be.false;
    });

    it('shows over-limit warning when summary exceeds 72 chars', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { summary: string };
      internal.summary = 'A'.repeat(80);
      await el.updateComplete;

      const summaryInput = el.shadowRoot!.querySelector('.summary-input');
      expect(summaryInput!.classList.contains('over-limit')).to.be.true;

      const charCount = el.shadowRoot!.querySelector('.char-count');
      expect(charCount!.classList.contains('over-limit')).to.be.true;
    });
  });

  // ── Summary/description input ──────────────────────────────────────────
  describe('input handling', () => {
    it('updates summary on input', async () => {
      const el = await renderCommitPanel();
      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      summaryInput.value = 'My commit message';
      summaryInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const internal = el as unknown as { summary: string };
      expect(internal.summary).to.equal('My commit message');
    });

    it('updates description on input', async () => {
      const el = await renderCommitPanel();
      const descInput = el.shadowRoot!.querySelector('.description-input') as HTMLTextAreaElement;
      descInput.value = 'Detailed description';
      descInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const internal = el as unknown as { description: string };
      expect(internal.description).to.equal('Detailed description');
    });

    it('clears error state on summary input', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { error: string | null };
      internal.error = 'Some error';
      await el.updateComplete;

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      summaryInput.value = 'new text';
      summaryInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      expect(internal.error).to.be.null;
    });
  });

  // ── Conventional commits ───────────────────────────────────────────────
  describe('conventional commits', () => {
    it('shows type select and scope when conventional mode is enabled', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { conventionalMode: boolean };
      internal.conventionalMode = true;
      await el.updateComplete;

      const typeSelect = el.shadowRoot!.querySelector('.type-select');
      expect(typeSelect).to.exist;

      const scopeInput = el.shadowRoot!.querySelector('.scope-input');
      expect(scopeInput).to.exist;
    });

    it('hides type select when conventional mode is off', async () => {
      const el = await renderCommitPanel();

      const typeSelect = el.shadowRoot!.querySelector('.type-select');
      expect(typeSelect).to.be.null;
    });

    it('builds message with type prefix in conventional mode', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        conventionalMode: boolean;
        selectedType: string;
        scope: string;
        summary: string;
        description: string;
      };

      internal.conventionalMode = true;
      internal.selectedType = 'feat';
      internal.scope = '';
      internal.summary = 'add login page';
      internal.description = '';

      const buildCommitMessage = (el as unknown as {
        buildCommitMessage: () => string;
      }).buildCommitMessage.bind(el);

      expect(buildCommitMessage()).to.equal('feat: add login page');
    });

    it('builds message with scope in conventional mode', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        conventionalMode: boolean;
        selectedType: string;
        scope: string;
        summary: string;
        description: string;
      };

      internal.conventionalMode = true;
      internal.selectedType = 'fix';
      internal.scope = 'auth';
      internal.summary = 'resolve token refresh';
      internal.description = '';

      const buildCommitMessage = (el as unknown as {
        buildCommitMessage: () => string;
      }).buildCommitMessage.bind(el);

      expect(buildCommitMessage()).to.equal('fix(auth): resolve token refresh');
    });

    it('builds message with body when description is provided', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        conventionalMode: boolean;
        selectedType: string;
        scope: string;
        summary: string;
        description: string;
      };

      internal.conventionalMode = false;
      internal.summary = 'Fix bug';
      internal.description = 'Detailed explanation';

      const buildCommitMessage = (el as unknown as {
        buildCommitMessage: () => string;
      }).buildCommitMessage.bind(el);

      expect(buildCommitMessage()).to.equal('Fix bug\n\nDetailed explanation');
    });

    it('builds message without body when description is empty', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        conventionalMode: boolean;
        summary: string;
        description: string;
      };

      internal.conventionalMode = false;
      internal.summary = 'Simple commit';
      internal.description = '';

      const buildCommitMessage = (el as unknown as {
        buildCommitMessage: () => string;
      }).buildCommitMessage.bind(el);

      expect(buildCommitMessage()).to.equal('Simple commit');
    });
  });

  // ── Commit history ─────────────────────────────────────────────────────
  describe('commit history', () => {
    it('loads history from localStorage', async () => {
      localStorage.setItem('gitnado-commit-history', JSON.stringify(['msg1', 'msg2']));
      const el = await renderCommitPanel();

      const internal = el as unknown as { commitHistory: string[] };
      expect(internal.commitHistory).to.deep.equal(['msg1', 'msg2']);
    });

    it('saves commit message to history on successful commit', async () => {
      const el = await renderCommitPanel();
      const saveToHistory = (el as unknown as {
        saveToHistory: (message: string) => void;
      }).saveToHistory.bind(el);

      saveToHistory('feat: new feature');

      const stored = JSON.parse(localStorage.getItem('gitnado-commit-history')!);
      expect(stored).to.include('feat: new feature');
    });

    it('deduplicates history entries', async () => {
      const el = await renderCommitPanel();
      const saveToHistory = (el as unknown as {
        saveToHistory: (message: string) => void;
      }).saveToHistory.bind(el);

      saveToHistory('message A');
      saveToHistory('message B');
      saveToHistory('message A'); // duplicate

      const stored = JSON.parse(localStorage.getItem('gitnado-commit-history')!);
      const countA = stored.filter((m: string) => m === 'message A').length;
      expect(countA).to.equal(1);
      expect(stored[0]).to.equal('message A');
    });

    it('limits history to 20 entries', async () => {
      const el = await renderCommitPanel();
      const saveToHistory = (el as unknown as {
        saveToHistory: (message: string) => void;
      }).saveToHistory.bind(el);

      for (let i = 0; i < 25; i++) {
        saveToHistory(`commit ${i}`);
      }

      const stored = JSON.parse(localStorage.getItem('gitnado-commit-history')!);
      expect(stored.length).to.be.at.most(20);
    });

    it('does not save empty or whitespace-only messages', async () => {
      const el = await renderCommitPanel();
      const saveToHistory = (el as unknown as {
        saveToHistory: (message: string) => void;
      }).saveToHistory.bind(el);

      saveToHistory('');
      saveToHistory('   ');

      const stored = localStorage.getItem('gitnado-commit-history');
      expect(stored).to.be.null;
    });

    it('selects history message and parses summary/description', async () => {
      const el = await renderCommitPanel();
      const handleHistorySelect = (el as unknown as {
        handleHistorySelect: (message: string) => void;
      }).handleHistorySelect.bind(el);

      handleHistorySelect('Summary line\n\nDescription body');

      const internal = el as unknown as { summary: string; description: string };
      expect(internal.summary).to.equal('Summary line');
      expect(internal.description).to.equal('Description body');
    });

    it('clears history', async () => {
      localStorage.setItem('gitnado-commit-history', JSON.stringify(['msg1']));
      const el = await renderCommitPanel();

      const handleClearHistory = (el as unknown as {
        handleClearHistory: () => void;
      }).handleClearHistory.bind(el);

      handleClearHistory();

      const internal = el as unknown as { commitHistory: string[] };
      expect(internal.commitHistory).to.deep.equal([]);
      expect(localStorage.getItem('gitnado-commit-history')).to.be.null;
    });
  });

  // ── Commit execution ───────────────────────────────────────────────────
  describe('commit execution', () => {
    it('calls create_commit with correct message', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit message';
      await el.updateComplete;

      invokeHistory.length = 0;

      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();

      const commitCall = invokeHistory.find(h => h.command === 'create_commit');
      expect(commitCall).to.exist;
      const args = commitCall!.args as { message: string };
      expect(args.message).to.equal('test commit message');
    });

    it('dispatches commit-created event on success', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit';
      await el.updateComplete;

      let eventFired = false;
      el.addEventListener('commit-created', () => { eventFired = true; });

      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();

      expect(eventFired).to.be.true;
    });

    it('clears form after successful commit', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        summary: string;
        description: string;
        amend: boolean;
      };
      internal.summary = 'test commit';
      internal.description = 'some body';

      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();

      expect(internal.summary).to.equal('');
      expect(internal.description).to.equal('');
      expect(internal.amend).to.be.false;
    });

    it('names the unavailable provider in the generate tooltip', async () => {
      // The chosen provider is unreachable, not missing. "Configure an AI
      // provider in Settings" would be wrong — one is configured.
      mockInvoke = async (command: string) => {
        if (command === 'is_ai_available') return false;
        if (command === 'ai_unavailable_reason') {
          return {
            reason:
              'Anthropic Claude is not available. Please check its API key in Settings, or select a different provider.',
            providerSelected: true,
          };
        }
        if (command === 'list_templates') return [];
        if (command === 'get_conventional_types') return [];
        if (command === 'get_commit_template') return null;
        if (command === 'get_user_identity') return null;
        return null;
      };

      const el = await renderCommitPanel();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.generate-btn');
      expect(btn, 'generate button rendered').to.not.be.null;
      expect(btn!.title).to.include('Anthropic Claude');
      expect(btn!.title).to.not.include('Configure an AI provider');
    });

    it('falls back to the generic generate tooltip when no reason is available', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'is_ai_available') return false;
        if (command === 'ai_unavailable_reason') return null;
        if (command === 'list_templates') return [];
        if (command === 'get_conventional_types') return [];
        if (command === 'get_commit_template') return null;
        if (command === 'get_user_identity') return null;
        return null;
      };

      const el = await renderCommitPanel();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.generate-btn');
      expect(btn!.title).to.include('Configure an AI provider in Settings');
    });

      it('shows error on failed commit', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'create_commit') {
          return { success: false, error: { message: 'Commit failed' } };
        }
        // Keep other defaults
        if (command === 'is_ai_available') return false;
        if (command === 'list_templates') return [];
        if (command === 'get_conventional_types') return [];
        if (command === 'get_commit_template') return null;
        if (command === 'get_user_identity') return null;
        return null;
      };

      const el = await renderCommitPanel();
      // Need to wait for async initialization
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Override the invoke to fail only for commit
      mockInvoke = async (command: string) => {
        if (command === 'create_commit') {
          throw new Error('Network error');
        }
        return null;
      };

      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit';
      await el.updateComplete;

      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();
      await el.updateComplete;

      expect((el as unknown as { error: string | null }).error).to.not.be.null;
    });

    it('shows success message after commit', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { summary: string };
      internal.summary = 'test commit';

      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();
      await el.updateComplete;

      const success = el.shadowRoot!.querySelector('.success');
      expect(success).to.exist;
      expect(success!.textContent).to.include('new123');
    });

    it('does not commit when canCommit is false', async () => {
      const el = await renderCommitPanel();
      invokeHistory.length = 0;

      // Summary is empty, canCommit should be false
      const handleCommit = (el as unknown as {
        handleCommit: () => Promise<void>;
      }).handleCommit.bind(el);

      await handleCommit();

      const commitCall = invokeHistory.find(h => h.command === 'create_commit');
      expect(commitCall).to.be.undefined;
    });
  });

  // ── Template variable expansion ────────────────────────────────────────
  describe('template variable expansion', () => {
    it('expands ${branch} variable', async () => {
      const el = await renderCommitPanel();
      const result = el.expandTemplateVariables('Fix on ${branch}');
      expect(result).to.equal('Fix on main');
    });

    it('expands ${date} to YYYY-MM-DD', async () => {
      const el = await renderCommitPanel();
      const result = el.expandTemplateVariables('Release ${date}');
      const today = new Date().toISOString().slice(0, 10);
      expect(result).to.equal(`Release ${today}`);
    });

    it('expands ${datetime} to YYYY-MM-DD HH:MM', async () => {
      const el = await renderCommitPanel();
      const result = el.expandTemplateVariables('Snapshot ${datetime}');
      expect(result).to.match(/^Snapshot \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('expands ${author} to git user name', async () => {
      const el = await renderCommitPanel();
      const result = el.expandTemplateVariables('By ${author}');
      expect(result).to.equal('By Test User');
    });

    it('leaves unknown variables unchanged', async () => {
      const el = await renderCommitPanel();
      const result = el.expandTemplateVariables('Has ${unknown} var');
      expect(result).to.equal('Has ${unknown} var');
    });
  });

  // ── Draft caching ──────────────────────────────────────────────────────
  describe('draft caching', () => {
    it('saves draft when repo path changes', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        summary: string;
        description: string;
        draftCache: Map<string, unknown>;
      };

      internal.summary = 'Draft message';
      internal.description = 'Draft body';

      // Trigger repositoryPath change
      el.repositoryPath = '/other/repo';
      await el.updateComplete;

      expect(internal.draftCache.has(REPO_PATH)).to.be.true;
    });

    it('restores draft when switching back to a repo', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        summary: string;
        description: string;
        draftCache: Map<string, { summary: string; description: string; conventionalMode: boolean; selectedType: string; scope: string }>;
      };

      // Pre-populate cache
      internal.draftCache.set('/other/repo', {
        summary: 'Cached summary',
        description: 'Cached desc',
        conventionalMode: false,
        selectedType: 'feat',
        scope: '',
      });

      el.repositoryPath = '/other/repo';
      await el.updateComplete;

      expect(internal.summary).to.equal('Cached summary');
      expect(internal.description).to.equal('Cached desc');
    });

    it('resets form when switching to repo with no cache', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { summary: string; description: string };
      internal.summary = 'some text';

      el.repositoryPath = '/brand-new/repo';
      await el.updateComplete;

      expect(internal.summary).to.equal('');
      expect(internal.description).to.equal('');
    });
  });

  // ── Events ─────────────────────────────────────────────────────────────
  describe('events', () => {
    it('dispatches open-settings when AI button is clicked without AI', async () => {
      const el = await renderCommitPanel();
      let settingsOpened = false;
      el.addEventListener('open-settings', () => { settingsOpened = true; });

      const generateBtn = el.shadowRoot!.querySelector('.generate-btn') as HTMLButtonElement;
      if (generateBtn) {
        generateBtn.click();
        expect(settingsOpened).to.be.true;
      }
    });
  });

  // ── AI vibe-check / split analysis feedback ─────────────────────────────
  describe('AI analysis feedback', () => {
    it('handleVibeCheck surfaces an error and resets loading on failure', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        handleVibeCheck: () => Promise<void>;
        isAnalyzing: boolean;
        generationError: string | null;
      };
      mockInvoke = async (command: string) => {
        if (command === 'analyze_staged_changes') throw new Error('vibe boom');
        return null;
      };

      await internal.handleVibeCheck();

      expect(internal.isAnalyzing).to.be.false; // not stuck
      expect(internal.generationError).to.contain('vibe boom');
    });

    it('handleSuggestSplits surfaces an error and resets loading on failure', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        handleSuggestSplits: () => Promise<void>;
        isAnalyzingSplit: boolean;
        generationError: string | null;
      };
      mockInvoke = async (command: string) => {
        if (command === 'suggest_commit_splits') throw new Error('split boom');
        return null;
      };

      await internal.handleSuggestSplits();

      expect(internal.isAnalyzingSplit).to.be.false; // not stuck
      expect(internal.generationError).to.contain('split boom');
    });

    it('handleSuggestSplits gives feedback when no split is needed', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        handleSuggestSplits: () => Promise<void>;
        isAnalyzingSplit: boolean;
        generationError: string | null;
      };
      mockInvoke = async (command: string) => {
        if (command === 'suggest_commit_splits') {
          return { shouldSplit: false, groups: [], explanation: 'cohesive' };
        }
        return null;
      };

      await internal.handleSuggestSplits();

      // Success path: no error, loading cleared. (Toast feedback is emitted for
      // the "no split needed" case.)
      expect(internal.isAnalyzingSplit).to.be.false;
      expect(internal.generationError).to.be.null;
    });

    it('reloads the author identity on repository-refresh (e.g. after a profile is applied)', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as { cachedAuthor: string };

      // Simulate applying a profile that rewrote the repo git identity.
      mockInvoke = async (command: string) => {
        if (command === 'get_user_identity') {
          return { name: 'New Identity', email: 'new@example.com' };
        }
        return null;
      };

      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await new Promise((r) => setTimeout(r, 50));

      expect(internal.cachedAuthor).to.equal('New Identity');
    });

    it('handleStageGroup isolates the group by unstaging every other staged file', async () => {
      const el = await renderCommitPanel();
      const internal = el as unknown as {
        handleStageGroup: (files: string[]) => Promise<void>;
      };
      // The index has the group's files, another group's file (c.ts), AND a
      // staged file in no suggested group (z.ts). All non-group files must be
      // unstaged so the commit is truly isolated.
      mockInvoke = async (command: string) => {
        if (command === 'get_status') {
          return [
            { path: 'a.ts', status: 'modified', isStaged: true, isConflicted: false },
            { path: 'b.ts', status: 'modified', isStaged: true, isConflicted: false },
            { path: 'c.ts', status: 'modified', isStaged: true, isConflicted: false },
            { path: 'z.ts', status: 'modified', isStaged: true, isConflicted: false },
            { path: 'u.ts', status: 'modified', isStaged: false, isConflicted: false },
          ];
        }
        return null;
      };

      invokeHistory.length = 0;
      await internal.handleStageGroup(['a.ts', 'b.ts']);

      const unstage = invokeHistory.find(h => h.command === 'unstage_files');
      const stage = invokeHistory.find(h => h.command === 'stage_files');
      expect(unstage, 'unstages all other staged files').to.exist;
      expect((unstage!.args as { paths: string[] }).paths).to.deep.equal(['c.ts', 'z.ts']);
      expect(stage, 'stages this group').to.exist;
      expect((stage!.args as { paths: string[] }).paths).to.deep.equal(['a.ts', 'b.ts']);
    });
  });

  describe('amend when HEAD cannot be read', () => {
    it('reports the failure and un-arms the checkbox', async () => {
      // invokeCommand never throws, so the `catch` under this call is dead code
      // and the no-else branch was the real failure path. It left `amend` true
      // with `lastCommit` null — a state the label and the Commit button cannot
      // tell from a healthy one, since canCommit is satisfied by `amend` alone.
      // The user learned it had failed only after pressing Commit.
      const el = await renderCommitPanel(0);
      mockInvoke = async (command: string) => {
        if (command === 'get_commit_history') {
          throw { code: 'COMMAND_ERROR', message: 'HEAD points at a missing ref' };
        }
        return null;
      };
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).fetchLastCommitMessage();
      await el.updateComplete;

      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length, 'the failure is surfaced').to.equal(1);
      expect(errors[0].message).to.contain('missing ref');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).amend, 'and the checkbox is not left armed').to.equal(false);
    });
  });
});
