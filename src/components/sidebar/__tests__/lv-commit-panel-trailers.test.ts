/**
 * Tests for the commit panel's trailer affordances: Sign off and Co-authors.
 *
 * The bar is what reaches `create_commit`: the composed message must carry the
 * exact trailers the panel promises, once each, in the footer.
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
  convertCallback: (callback: unknown, once: boolean) => { void once; void callback; return 0; },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { repositoryStore } from '../../../stores/repository.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import type { LvCommitPanel } from '../lv-commit-panel.ts';
import '../lv-commit-panel.ts';

const REPO_PATH = '/test/repo';

const IDENTITY = { name: 'Ada Lovelace', email: 'ada@example.com' };

interface PanelInternals {
  summary: string;
  description: string;
  signOff: boolean;
  coAuthors: Array<{ name: string; email: string }>;
  coAuthorInput: string;
  coAuthorError: string | null;
  suggestionsError: string | null;
  conventionalMode: boolean;
  selectedType: string;
  scope: string;
  amend: boolean;
  lastCommit: unknown;
  identityName: string;
  identityEmail: string;
  identityLoaded: boolean;
  showCoAuthors: boolean;
  visibleSuggestions: Array<{ name: string; email: string }>;
  buildCommitMessage: () => string;
  handleCommit: () => Promise<void>;
  handleAddCoAuthor: () => void;
  handleRemoveCoAuthor: (coAuthor: { name: string; email: string }) => void;
  handleCoAuthorsToggle: (e: Event) => void;
  loadCoAuthorSuggestions: () => Promise<void>;
  fetchLastCommitMessage: () => Promise<void>;
  handleAmendToggle: (e: Event) => Promise<void>;
}

function commitOf(summary: string, body: string | null) {
  return {
    oid: 'abc123def456',
    shortId: 'abc123d',
    message: body ? `${summary}\n\n${body}` : summary,
    summary,
    body,
    author: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 0 },
    committer: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 0 },
    parentIds: [],
    timestamp: 0,
  };
}

let identity: { name: string | null; email: string | null } | null = IDENTITY;
let history: unknown[] = [commitOf('Last commit message', 'Some body text')];

function setupDefaultMocks(): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'list_templates':
        return [];
      case 'get_conventional_types':
        return [
          { typeName: 'feat', description: 'A new feature', emoji: null },
          { typeName: 'fix', description: 'A bug fix', emoji: null },
        ];
      case 'get_commit_template':
        return null;
      case 'get_user_identity':
        return identity;
      case 'is_ai_available':
        return false;
      case 'get_commit_history':
        return history;
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
}

async function renderCommitPanel(stagedCount = 1): Promise<LvCommitPanel> {
  const el = await fixture<LvCommitPanel>(
    html`<lv-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${stagedCount}></lv-commit-panel>`
  );
  await mounted(el);
  return el;
}

/**
 * Wait for the panel's mount to finish. connectedCallback chains several
 * lookups (templates, conventional types, AI availability, identity), only
 * THEN seeds sign-off and registers its window listeners, and its last act is
 * to subscribe to the model-download event — so that subscription reaching
 * the Tauri boundary is the signal the whole chain has run.
 */
async function mounted(el: LvCommitPanel): Promise<void> {
  await waitUntil(
    () =>
      invokeHistory.some(
        (h) =>
          h.command === 'plugin:event|listen' &&
          (h.args as { event?: string } | undefined)?.event === 'model-download-complete',
      ),
    'the commit panel to finish mounting',
  );
  await el.updateComplete;
}

function internals(el: LvCommitPanel): PanelInternals {
  return el as unknown as PanelInternals;
}

describe('lv-commit-panel trailers', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    identity = IDENTITY;
    history = [commitOf('Last commit message', 'Some body text')];
    localStorage.removeItem('leviathan-commit-history');
    settingsStore.getState().setAlwaysSignOff(false);
    setupDefaultMocks();
    setupStore();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    settingsStore.getState().setAlwaysSignOff(false);
  });

  // ── Sign off ───────────────────────────────────────────────────────────
  describe('sign off', () => {
    it('renders a sign-off toggle, off by default', async () => {
      const el = await renderCommitPanel();
      const checkbox = el.shadowRoot!.querySelector(
        '.signoff-toggle input'
      ) as HTMLInputElement;
      expect(checkbox).to.exist;
      expect(checkbox.checked).to.be.false;
      expect(checkbox.disabled).to.be.false;
    });

    it('appends Signed-off-by with the repository identity', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'fix: a bug';
      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;
      checkbox.click();
      await el.updateComplete;

      expect(panel.signOff).to.be.true;
      expect(panel.buildCommitMessage()).to.equal(
        'fix: a bug\n\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );
    });

    it('shows the trailer that will be added', async () => {
      const el = await renderCommitPanel();
      internals(el).summary = 'fix: a bug';
      (el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement).click();
      await el.updateComplete;

      const preview = el.shadowRoot!.querySelector('.trailers-preview');
      expect(preview).to.exist;
      expect(preview!.textContent).to.contain('Signed-off-by: Ada Lovelace <ada@example.com>');
    });

    it('removes exactly its own trailer when toggled off, leaving the message intact', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'fix: a bug';
      panel.description = 'A hand-written body.\n\nRefs: #42';
      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;

      checkbox.click();
      await el.updateComplete;
      expect(panel.buildCommitMessage()).to.equal(
        'fix: a bug\n\nA hand-written body.\n\nRefs: #42\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );

      checkbox.click();
      await el.updateComplete;
      expect(panel.buildCommitMessage()).to.equal(
        'fix: a bug\n\nA hand-written body.\n\nRefs: #42'
      );
    });

    it('disables the toggle and explains itself when no identity is configured', async () => {
      identity = { name: null, email: null };
      const el = await renderCommitPanel();
      await el.updateComplete;

      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;
      expect(checkbox.disabled, 'the toggle is not armable').to.be.true;

      const hint = el.shadowRoot!.querySelector('.trailer-hint');
      expect(hint, 'the panel says why').to.exist;
      expect(hint!.textContent).to.contain('No git identity configured');
    });

    it('never writes a broken trailer when the identity is missing', async () => {
      identity = { name: null, email: null };
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'fix: a bug';
      panel.signOff = true;
      await el.updateComplete;

      expect(panel.buildCommitMessage()).to.equal('fix: a bug');
      expect(el.shadowRoot!.querySelector('.trailers-preview')).to.not.exist;
    });

    it('reports a rejected sign-off instead of silently ignoring it', async () => {
      identity = { name: null, email: null };
      const el = await renderCommitPanel();
      uiStore.setState({ toasts: [] });

      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;
      // Bypass the disabled attribute the way a programmatic toggle would.
      checkbox.disabled = false;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      await el.updateComplete;

      expect(internals(el).signOff).to.be.false;
      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length).to.equal(1);
      expect(errors[0].message).to.contain('No git identity');
    });

    it('opens the git config dialog from the hint', async () => {
      identity = { name: null, email: null };
      const el = await renderCommitPanel();
      await el.updateComplete;

      let opened = false;
      const listener = (): void => { opened = true; };
      window.addEventListener('open-git-config', listener);
      (el.shadowRoot!.querySelector('.trailer-hint button') as HTMLButtonElement).click();
      window.removeEventListener('open-git-config', listener);

      expect(opened).to.be.true;
    });

    it('recovers as soon as an identity is configured, without any other refresh', async () => {
      // The hint's button opens the Git Configuration dialog; saving there
      // announces `git-identity-changed`. If the panel ignored it, the user
      // would come back to the same disabled control they went to fix.
      identity = { name: null, email: null };
      const el = await renderCommitPanel();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.trailer-hint')).to.exist;
      expect(
        (el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement).disabled,
      ).to.be.true;

      identity = IDENTITY;
      window.dispatchEvent(new CustomEvent('git-identity-changed'));
      await waitUntil(
        async () => {
          await el.updateComplete;
          return el.shadowRoot!.querySelector('.trailer-hint') === null;
        },
        'the "no git identity" hint should disappear once one is configured',
      );

      expect(
        (el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement).disabled,
      ).to.be.false;
      expect(internals(el).identityName).to.equal(IDENTITY.name);
      expect(internals(el).identityEmail).to.equal(IDENTITY.email);
    });

    it('starts armed when "always sign off" is enabled', async () => {
      settingsStore.getState().setAlwaysSignOff(true);
      const el = await renderCommitPanel();
      await el.updateComplete;
      expect(internals(el).signOff).to.be.true;
    });

    it('never starts armed when there is no identity to sign with', async () => {
      // A checkbox that is checked AND disabled, next to a hint saying commits
      // cannot be signed off, states something the commit will not do: with no
      // identity the footer gets no Signed-off-by line at all.
      identity = { name: null, email: null };
      settingsStore.getState().setAlwaysSignOff(true);
      const el = await renderCommitPanel();
      await el.updateComplete;

      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;
      expect(checkbox.disabled, 'the toggle is not armable').to.be.true;
      expect(checkbox.checked, 'and it does not claim to be armed').to.be.false;
      expect(internals(el).signOff).to.be.false;
      expect(
        el.shadowRoot!.querySelector('.trailers-preview'),
        'nothing is promised in the footer either'
      ).to.not.exist;
    });

    it('disarms a sign-off carried into a repository with no identity', async () => {
      settingsStore.getState().setAlwaysSignOff(true);
      const el = await renderCommitPanel();
      const panel = internals(el);
      expect(panel.signOff, 'armed while the first repo has an identity').to.be.true;

      identity = { name: null, email: null };
      el.repositoryPath = '/test/no-identity';
      await el.updateComplete;
      await waitUntil(() => panel.identityLoaded, 'the new repository identity to load');
      await el.updateComplete;

      expect(panel.signOff).to.be.false;
      const checkbox = el.shadowRoot!.querySelector('.signoff-toggle input') as HTMLInputElement;
      expect(checkbox.checked).to.be.false;
      expect(checkbox.disabled).to.be.true;
    });
  });

  // ── Co-authors ─────────────────────────────────────────────────────────
  describe('co-authors', () => {
    it('adds a manually entered co-author', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'feat: pair work';
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      expect(panel.coAuthors).to.deep.equal([
        { name: 'Grace Hopper', email: 'grace@example.com' },
      ]);
      expect(panel.buildCommitMessage()).to.equal(
        'feat: pair work\n\nCo-authored-by: Grace Hopper <grace@example.com>'
      );
      expect(panel.coAuthorInput, 'the box is cleared for the next one').to.equal('');
    });

    it('rejects a malformed entry with an explanation', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.coAuthorInput = 'grace@example.com';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      expect(panel.coAuthors).to.deep.equal([]);
      expect(panel.coAuthorError).to.contain('not a valid co-author');
    });

    it('adding the same co-author twice is a no-op and says so', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      panel.coAuthorInput = 'G. Hopper <GRACE@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      expect(panel.coAuthors).to.have.lengthOf(1);
      expect(panel.coAuthorError).to.contain('already a co-author');
    });

    it('removes a co-author', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'feat: pair work';
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      panel.handleRemoveCoAuthor({ name: 'Grace Hopper', email: 'grace@example.com' });
      await el.updateComplete;

      expect(panel.coAuthors).to.deep.equal([]);
      expect(panel.buildCommitMessage()).to.equal('feat: pair work');
    });

    it('suggests recent commit authors, excluding yourself', async () => {
      history = [
        commitOf('one', null),
        { ...commitOf('two', null), author: { name: 'Grace Hopper', email: 'grace@example.com', timestamp: 0 } },
        { ...commitOf('three', null), author: { name: 'Grace H', email: 'GRACE@example.com', timestamp: 0 } },
        { ...commitOf('four', null), author: { name: 'Alan Turing', email: 'alan@example.com', timestamp: 0 } },
      ];
      const el = await renderCommitPanel();
      const panel = internals(el);
      await panel.loadCoAuthorSuggestions();
      await el.updateComplete;

      expect(panel.visibleSuggestions.map((s) => s.email)).to.deep.equal([
        'grace@example.com',
        'alan@example.com',
      ]);
    });

    it('drops a suggestion once it has been added', async () => {
      history = [
        { ...commitOf('two', null), author: { name: 'Grace Hopper', email: 'grace@example.com', timestamp: 0 } },
      ];
      const el = await renderCommitPanel();
      const panel = internals(el);
      await panel.loadCoAuthorSuggestions();
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      expect(panel.visibleSuggestions).to.deep.equal([]);
    });

    it('surfaces a failure to read recent authors', async () => {
      const el = await renderCommitPanel();
      mockInvoke = async (command: string) => {
        if (command === 'get_commit_history') {
          throw { code: 'COMMAND_ERROR', message: 'HEAD is unborn' };
        }
        return null;
      };
      const panel = internals(el);
      await panel.loadCoAuthorSuggestions();
      await el.updateComplete;

      expect(panel.suggestionsError).to.contain('HEAD is unborn');
      const error = el.shadowRoot!.querySelector('.coauthor-error');
      // The dropdown is closed, so open it to see the message.
      expect(error === null || error.textContent!.includes('HEAD is unborn')).to.be.true;
    });
  });

  // ── Composition ────────────────────────────────────────────────────────
  describe('message composition', () => {
    it('places the footer after a conventional-commit subject and body', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.conventionalMode = true;
      panel.selectedType = 'feat';
      panel.scope = 'auth';
      panel.summary = 'add SSO';
      panel.description = 'Why this matters.';
      panel.signOff = true;
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      expect(panel.buildCommitMessage()).to.equal(
        'feat(auth): add SSO\n\nWhy this matters.\n\n' +
          'Signed-off-by: Ada Lovelace <ada@example.com>\n' +
          'Co-authored-by: Grace Hopper <grace@example.com>'
      );
    });

    it('composes with a template body that already ends in a trailer', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'chore: from template';
      panel.description = 'Body from the template.\n\nRefs: PROJ-1';
      panel.signOff = true;
      await el.updateComplete;

      expect(panel.buildCommitMessage()).to.equal(
        'chore: from template\n\nBody from the template.\n\n' +
          'Refs: PROJ-1\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );
    });

    it('sends the composed message to create_commit', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'feat: shipped';
      panel.signOff = true;
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      invokeHistory.length = 0;
      await panel.handleCommit();

      const call = invokeHistory.find((h) => h.command === 'create_commit');
      expect(call, 'create_commit ran').to.exist;
      expect((call!.args as { message: string }).message).to.equal(
        'feat: shipped\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n' +
          'Co-authored-by: Grace Hopper <grace@example.com>'
      );
    });

    it('clears co-authors after a successful commit', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'feat: shipped';
      panel.signOff = true;
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      await panel.handleCommit();
      await el.updateComplete;

      expect(panel.coAuthors).to.deep.equal([]);
      expect(panel.signOff, 'falls back to the standing preference').to.be.false;
    });
  });

  // ── Amend ──────────────────────────────────────────────────────────────
  describe('amend', () => {
    it('adopts the amended commit trailers instead of duplicating them', async () => {
      history = [
        commitOf(
          'fix: earlier commit',
          'Body.\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n' +
            'Co-authored-by: Grace Hopper <grace@example.com>'
        ),
      ];
      const el = await renderCommitPanel(0);
      const panel = internals(el);
      panel.amend = true;
      await panel.fetchLastCommitMessage();
      await el.updateComplete;

      expect(panel.signOff, 'the sign-off is reflected in the control').to.be.true;
      expect(panel.coAuthors).to.deep.equal([
        { name: 'Grace Hopper', email: 'grace@example.com' },
      ]);
      expect(panel.description, 'the footer is lifted out of the body').to.equal('Body.');

      const message = panel.buildCommitMessage();
      expect(message).to.equal(
        'fix: earlier commit\n\nBody.\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n' +
          'Co-authored-by: Grace Hopper <grace@example.com>'
      );
      expect(message.match(/Signed-off-by/g)).to.have.lengthOf(1);
      expect(message.match(/Co-authored-by/g)).to.have.lengthOf(1);
    });

    it('leaves a sign-off by somebody else in the message body', async () => {
      history = [
        commitOf('fix: earlier commit', 'Signed-off-by: Grace Hopper <grace@example.com>'),
      ];
      const el = await renderCommitPanel(0);
      const panel = internals(el);
      panel.amend = true;
      await panel.fetchLastCommitMessage();
      await el.updateComplete;

      expect(panel.signOff).to.be.false;
      expect(panel.description).to.equal('Signed-off-by: Grace Hopper <grace@example.com>');
      expect(panel.buildCommitMessage()).to.equal(
        'fix: earlier commit\n\nSigned-off-by: Grace Hopper <grace@example.com>'
      );
    });

    it('restores the draft trailers when amend is switched off', async () => {
      history = [
        commitOf('fix: earlier commit', 'Co-authored-by: Grace Hopper <grace@example.com>'),
      ];
      const el = await renderCommitPanel(1);
      const panel = internals(el);
      panel.summary = 'my own draft';
      panel.coAuthorInput = 'Alan Turing <alan@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      const checkbox = el.shadowRoot!.querySelector('.amend-toggle input') as HTMLInputElement;
      checkbox.click();
      await waitUntil(() => panel.lastCommit !== null, 'the amended commit to be fetched');
      await el.updateComplete;
      expect(panel.coAuthors.map((c) => c.email)).to.deep.equal([
        'alan@example.com',
        'grace@example.com',
      ]);

      checkbox.click();
      // Switching amend off restores the draft synchronously in the handler.
      await el.updateComplete;

      expect(panel.summary).to.equal('my own draft');
      expect(panel.coAuthors.map((c) => c.email)).to.deep.equal(['alan@example.com']);
    });
  });

  // ── Repository switching ───────────────────────────────────────────────
  describe('repository switching', () => {
    it('drops the previous repository identity and co-authors', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      panel.signOff = true;
      await el.updateComplete;

      identity = { name: 'Second Repo User', email: 'second@example.com' };
      el.repositoryPath = '/test/other-repo';
      await el.updateComplete;
      await waitUntil(() => panel.identityLoaded, 'the new repository identity to load');
      await el.updateComplete;

      expect(panel.coAuthors).to.deep.equal([]);
      expect(panel.signOff).to.be.false;
      expect(panel.identityEmail).to.equal('second@example.com');
    });

    it('restores the trailers of a cached draft when switching back', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.summary = 'draft for repo one';
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      panel.signOff = true;
      await el.updateComplete;

      el.repositoryPath = '/test/other-repo';
      await el.updateComplete;
      el.repositoryPath = REPO_PATH;
      await el.updateComplete;
      await waitUntil(() => panel.identityLoaded, 'the restored repository identity to load');

      expect(panel.summary).to.equal('draft for repo one');
      expect(panel.signOff).to.be.true;
      expect(panel.coAuthors.map((c) => c.email)).to.deep.equal(['grace@example.com']);
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────────
  describe('accessibility', () => {
    it('reports the co-author dropdown state on the toggle that owns it', async () => {
      const el = await renderCommitPanel();
      const button = el.shadowRoot!.querySelector('.coauthor-btn') as HTMLButtonElement;

      expect(button.getAttribute('aria-expanded'), 'collapsed to start with').to.equal('false');
      const controls = button.getAttribute('aria-controls');
      expect(controls, 'the toggle names what it opens').to.be.a('string').and.not.equal('');

      button.click();
      await el.updateComplete;

      expect(button.getAttribute('aria-expanded')).to.equal('true');
      const dropdown = el.shadowRoot!.querySelector(`#${controls}`);
      expect(dropdown, 'aria-controls points at the dropdown that appeared').to.exist;
      expect(dropdown!.classList.contains('coauthor-dropdown')).to.be.true;

      button.click();
      await el.updateComplete;
      expect(button.getAttribute('aria-expanded'), 'and back again').to.equal('false');
    });

    it('names the co-author entry box — a placeholder is not a label', async () => {
      const el = await renderCommitPanel();
      (el.shadowRoot!.querySelector('.coauthor-btn') as HTMLButtonElement).click();
      await el.updateComplete;

      const input = el.shadowRoot!.querySelector('.coauthor-input') as HTMLInputElement;
      expect(input).to.exist;
      expect(input.getAttribute('aria-label')).to.equal('Co-author name and email');
    });

    it('names every trailer remove button — "✕" says nothing on its own', async () => {
      const el = await renderCommitPanel();
      const panel = internals(el);
      panel.signOff = true;
      panel.coAuthorInput = 'Grace Hopper <grace@example.com>';
      panel.handleAddCoAuthor();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.trailer-remove')).map((b) =>
        b.getAttribute('aria-label')
      );
      expect(labels).to.deep.equal([
        'Turn off sign-off',
        'Remove co-author Grace Hopper <grace@example.com>',
      ]);
    });
  });
});
