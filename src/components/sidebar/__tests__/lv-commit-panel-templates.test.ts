/**
 * Fixture-based tests for lv-commit-panel template functionality.
 *
 * These render the REAL lv-commit-panel component, mock only the Tauri invoke
 * layer, and verify template selection and variable expansion through the
 * actual component DOM.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { LvCommitPanel } from '../lv-commit-panel.ts';
import type { CommitTemplate } from '../../../services/git.service.ts';

// Import the actual component — registers <lv-commit-panel> custom element
import '../lv-commit-panel.ts';
import { collectUnhandledRejections } from '../../../test-utils/unhandled-rejections.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const TEST_TEMPLATES: CommitTemplate[] = [
  {
    id: 'tmpl-branch',
    name: 'Branch Template',
    content: '[${branch}] Fix something',
    isConventional: false,
    createdAt: 1000,
  },
  {
    id: 'tmpl-multiline',
    name: 'Multi-line Template',
    content: 'Summary line here\nDescription body\nMore details',
    isConventional: false,
    createdAt: 2000,
  },
  {
    id: 'tmpl-date',
    name: 'Date Template',
    content: 'Release ${date}',
    isConventional: false,
    createdAt: 3000,
  },
  {
    id: 'tmpl-datetime',
    name: 'Datetime Template',
    content: 'Snapshot ${datetime}',
    isConventional: false,
    createdAt: 4000,
  },
  {
    id: 'tmpl-author',
    name: 'Author Template',
    content: 'Authored by ${author}',
    isConventional: false,
    createdAt: 5000,
  },
  {
    id: 'tmpl-unknown',
    name: 'Unknown Var Template',
    content: 'Has ${unknown} variable',
    isConventional: false,
    createdAt: 6000,
  },
  {
    id: 'tmpl-multi-vars',
    name: 'Multi Var Template',
    content: '[${branch}] ${date} by ${author}',
    isConventional: false,
    createdAt: 7000,
  },
  {
    id: 'tmpl-no-vars',
    name: 'No Vars Template',
    content: 'Plain commit message with no variables',
    isConventional: false,
    createdAt: 8000,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function setupDefaultMocks(templates: CommitTemplate[] = TEST_TEMPLATES): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'list_templates':
        return templates;
      case 'get_conventional_types':
        return [
          { typeName: 'feat', description: 'A new feature', emoji: '' },
          { typeName: 'fix', description: 'A bug fix', emoji: '' },
        ];
      case 'get_commit_template':
        return null;
      case 'get_user_identity':
        return { name: 'Jane Doe', email: 'jane@example.com' };
      case 'is_ai_available':
        return false;
      default:
        return null;
    }
  };
}

function setupStoreWithBranch(branchName: string): void {
  repositoryStore.getState().addRepository({
    path: REPO_PATH,
    name: 'test',
    isValid: true,
    isBare: false,
    headRef: null,
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  });
  if (branchName) {
    repositoryStore.getState().setCurrentBranch({
      name: branchName,
      shorthand: branchName,
      isHead: true,
      isRemote: false,
      upstream: null,
      targetOid: 'abc123',
      isStale: false,
    });
  }
}

async function renderCommitPanel(): Promise<LvCommitPanel> {
  const el = await fixture<LvCommitPanel>(
    html`<lv-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${1}></lv-commit-panel>`
  );
  // Wait for connectedCallback async operations
  await new Promise((r) => setTimeout(r, 100));
  await el.updateComplete;
  return el;
}

async function selectTemplate(el: LvCommitPanel, templateId: string): Promise<void> {
  const select = el.shadowRoot!.querySelector('.template-select') as HTMLSelectElement;
  select.value = templateId;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  // Extra tick for any cascaded state updates
  await new Promise((r) => setTimeout(r, 20));
  await el.updateComplete;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-commit-panel templates (fixture-based)', () => {
  beforeEach(() => {
    setupDefaultMocks();
    setupStoreWithBranch('feature/test');
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  // ── Rendering tests ────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders with a .summary-input textarea', async () => {
      const el = await renderCommitPanel();
      const summaryInput = el.shadowRoot!.querySelector('.summary-input');
      expect(summaryInput).to.not.be.null;
      expect(summaryInput!.tagName.toLowerCase()).to.equal('textarea');
    });

    it('renders with a .description-input textarea', async () => {
      const el = await renderCommitPanel();
      const descInput = el.shadowRoot!.querySelector('.description-input');
      expect(descInput).to.not.be.null;
      expect(descInput!.tagName.toLowerCase()).to.equal('textarea');
    });

    it('renders a commit button', async () => {
      const el = await renderCommitPanel();
      const commitBtn = el.shadowRoot!.querySelector('.commit-btn');
      expect(commitBtn).to.not.be.null;
      expect(commitBtn!.textContent).to.include('Commit');
    });
  });

  // ── Template selection tests ───────────────────────────────────────────
  describe('template selection', () => {
    it('renders template-select with template options when templates exist', async () => {
      const el = await renderCommitPanel();
      const select = el.shadowRoot!.querySelector('.template-select') as HTMLSelectElement;
      expect(select).to.not.be.null;

      const options = select.querySelectorAll('option');
      // First option is the "Select template..." placeholder
      expect(options.length).to.equal(TEST_TEMPLATES.length + 1);
      expect(options[1].textContent).to.include('Branch Template');
    });

    it('populates .summary-input with first line of expanded template content', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-multiline');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('Summary line here');
    });

    it('populates .description-input with remaining lines of template content', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-multiline');

      const descInput = el.shadowRoot!.querySelector('.description-input') as HTMLTextAreaElement;
      expect(descInput.value).to.equal('Description body\nMore details');
    });

    it('expands ${branch} variable in populated summary', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-branch');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('[feature/test] Fix something');
    });
  });

  // ── Template variable expansion tests ──────────────────────────────────
  describe('template variable expansion', () => {
    it('replaces ${branch} with current branch name in summary textarea value', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-branch');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.include('feature/test');
      expect(summaryInput.value).to.not.include('${branch}');
    });

    it('replaces ${date} with YYYY-MM-DD format', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-date');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      const today = new Date().toISOString().slice(0, 10);
      expect(summaryInput.value).to.equal(`Release ${today}`);
    });

    it('replaces ${datetime} with YYYY-MM-DD HH:MM format', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-datetime');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.match(/^Snapshot \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('replaces ${author} with git user name', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-author');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('Authored by Jane Doe');
    });

    it('leaves unknown ${unknown} variables as-is in the textarea', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-unknown');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('Has ${unknown} variable');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('expands multiple variables in one template correctly', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-multi-vars');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      const today = new Date().toISOString().slice(0, 10);
      expect(summaryInput.value).to.equal(`[feature/test] ${today} by Jane Doe`);
    });

    it('handles empty branch name without crashing', async () => {
      // Reset store and set up with empty branch
      repositoryStore.getState().reset();
      setupStoreWithBranch('');

      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-branch');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('[] Fix something');
    });

    it('populates textarea unchanged when template has no variables', async () => {
      const el = await renderCommitPanel();
      await selectTemplate(el, 'tmpl-no-vars');

      const summaryInput = el.shadowRoot!.querySelector('.summary-input') as HTMLTextAreaElement;
      expect(summaryInput.value).to.equal('Plain commit message with no variables');
    });
  });
});

describe('lv-commit-panel teardown without the event plugin internals', () => {
  beforeEach(() => {
    setupDefaultMocks();
    setupStoreWithBranch('feature/test');
    delete (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  it('disconnects without an unhandled rejection', async () => {
    // listen() succeeds against the mock, so the panel holds a real unlisten
    // closure for `model-download-complete`; that closure reads
    // __TAURI_EVENT_PLUGIN_INTERNALS__, which does not exist here.
    const el = await renderCommitPanel();
    await waitUntil(
      () => (el as unknown as { modelCompleteUnlisten?: unknown }).modelCompleteUnlisten !== undefined,
      'the model-download listener never attached',
    );

    const rejections = await collectUnhandledRejections(() => {
      el.remove();
    });
    expect(rejections, 'teardown must not reject').to.deep.equal([]);
  });
});
