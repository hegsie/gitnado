/**
 * Tests for lv-pull-request-list — the sidebar's Pull Requests section.
 *
 * Covers every state the section can be in (no provider, offline, blocked by
 * the allowlist, unauthenticated, loading error, empty, populated), the lazy
 * load contract (nothing is fetched while collapsed), the per-repository
 * cache, explicit refresh, and click-through to the browser.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
let invokedCommands: string[] = [];
let invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokedCommands.push(command);
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { settingsStore } from '../../../stores/settings.store.ts';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { invalidateProviderDetection } from '../../../services/pull-request.service.ts';
import '../lv-pull-request-list.ts';
import type { LvPullRequestList } from '../lv-pull-request-list.ts';

const REPO_PATH = '/test/repo';
const OTHER_REPO_PATH = '/test/other-repo';

interface MockOptions {
  /** Detected GitHub repo, or null for "no provider anywhere". */
  githubRepo?: { owner: string; repo: string; remoteName: string } | null;
  /** Keyring answer for the legacy GitHub token. */
  token?: string | null;
  /** Pull requests list_pull_requests resolves with. */
  pullRequests?: unknown[];
  /** When set, list_pull_requests rejects with this message. */
  listError?: string;
}

function setupMocks(options: MockOptions = {}): void {
  const {
    githubRepo = { owner: 'octo', repo: 'leviathan', remoteName: 'origin' },
    token = 'gh-token',
    pullRequests = [],
    listError,
  } = options;

  mockInvoke = async (command: string) => {
    switch (command) {
      case 'detect_github_repo':
        return githubRepo;
      case 'detect_ado_repo':
      case 'detect_gitlab_repo':
      case 'detect_bitbucket_repo':
        return null;
      case 'get_keyring_token':
        return token;
      case 'list_pull_requests':
        if (listError) throw new Error(listError);
        return pullRequests;
      default:
        return null;
    }
  };
}

function makePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Add the pull request sidebar',
    state: 'open',
    user: { login: 'octocat', id: 1, avatarUrl: '', name: 'Octo Cat', email: null },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    headRef: 'feature/prs',
    headSha: 'abc123',
    baseRef: 'main',
    draft: false,
    mergeable: true,
    htmlUrl: 'https://github.com/octo/leviathan/pull/42',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    ...overrides,
  };
}

async function renderList(
  expanded = true,
  repositoryPath = REPO_PATH,
): Promise<LvPullRequestList> {
  const el = await fixture<LvPullRequestList>(html`
    <lv-pull-request-list
      .repositoryPath=${repositoryPath}
      .expanded=${expanded}
    ></lv-pull-request-list>
  `);
  await settle(el);
  return el;
}

/**
 * Let the element's chained awaits (detect → token → list) resolve.
 *
 * `updated()` starts the load a microtask after the render that changed the
 * bindings, and the load flips `listState` to 'loading' before its first
 * await — so once that render has completed, "not loading" means the chain
 * has reached its settled state (or, collapsed or unbound, never started).
 */
async function settle(el: LvPullRequestList): Promise<void> {
  await el.updateComplete;
  await waitUntil(
    () => (el as unknown as { listState: string }).listState !== 'loading',
    'the pull request list to settle',
  );
  await el.updateComplete;
}

/** The row handlers hand off to openExternalUrl, which reaches IPC asynchronously. */
function browserOpened(): Promise<void> {
  return waitUntil(() => openedUrls().length > 0, 'the pull request to be opened in the browser');
}

/** Rendered text with template whitespace collapsed, for prose assertions. */
function text(el: LvPullRequestList): string {
  return (el.shadowRoot!.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** URLs handed to the Tauri shell plugin by openExternalUrl. */
function openedUrls(): string[] {
  return invokeCalls
    .filter((c) => c.command === 'plugin:shell|open')
    .map((c) => String((c.args as { path?: string } | undefined)?.path ?? ''));
}

describe('lv-pull-request-list', () => {
  beforeEach(() => {
    // Reset accounts BEFORE the counters: mocha runs the innermost afterEach
    // first, so a reset there would still reach the previous test's live
    // element and start one more load.
    unifiedProfileStore.getState().setAccounts([]);
    invokedCommands = [];
    invokeCalls = [];
    invalidateProviderDetection();
    settingsStore.getState().setOfflineMode(false);
    setupMocks();
  });

  afterEach(() => {
    settingsStore.getState().setOfflineMode(false);
    invalidateProviderDetection();
  });

  // ── Lazy loading ───────────────────────────────────────────────────────
  describe('lazy loading', () => {
    it('fetches nothing while the section is collapsed', async () => {
      const el = await renderList(false);
      expect(invokedCommands).to.not.include('detect_github_repo');
      expect(invokedCommands).to.not.include('list_pull_requests');
      expect(el.shadowRoot!.querySelector('.pr-item')).to.not.exist;
    });

    it('loads when the section is expanded', async () => {
      const el = await renderList(false);
      el.expanded = true;
      await settle(el);

      expect(invokedCommands).to.include('detect_github_repo');
      expect(invokedCommands).to.include('list_pull_requests');
    });

    it('renders nothing at all without a repository path', async () => {
      const el = await renderList(true, '');
      expect(el.shadowRoot!.textContent!.trim()).to.equal('');
      expect(invokedCommands).to.not.include('list_pull_requests');
    });
  });

  // ── States ─────────────────────────────────────────────────────────────
  describe('states', () => {
    it('lists open pull requests with number, title and author', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const items = el.shadowRoot!.querySelectorAll('.pr-item');
      expect(items.length).to.equal(1);
      expect(items[0].textContent).to.contain('Add the pull request sidebar');
      expect(items[0].textContent).to.contain('#42');
      expect(items[0].textContent).to.contain('Octo Cat');
      expect(items[0].textContent).to.contain('feature/prs');
    });

    it('badges a draft and a conflicting pull request', async () => {
      setupMocks({
        pullRequests: [makePr({ draft: true, mergeable: false })],
      });
      const el = await renderList();

      const badges = Array.from(el.shadowRoot!.querySelectorAll('.pr-badge')).map(
        (b) => b.textContent!.trim(),
      );
      expect(badges).to.include('Draft');
      expect(badges).to.include('Conflicts');
    });

    it('shows an empty state rather than a blank list', async () => {
      setupMocks({ pullRequests: [] });
      const el = await renderList();

      expect(el.shadowRoot!.querySelector('.empty')).to.exist;
      expect(text(el)).to.contain('No open pull requests');
    });

    it('explains when no hosting provider is detected', async () => {
      setupMocks({ githubRepo: null });
      const el = await renderList();

      expect(text(el)).to.contain('No GitHub, GitLab, Bitbucket or Azure DevOps remote');
      expect(invokedCommands).to.not.include('list_pull_requests');
    });

    it('offers to connect instead of showing an empty list when not authenticated', async () => {
      setupMocks({ token: null });
      const el = await renderList();

      expect(text(el)).to.contain('Not connected to GitHub');
      const connect = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(connect).to.exist;
      expect(connect.textContent).to.contain('Connect to GitHub');
      // No API call was made without a token.
      expect(invokedCommands).to.not.include('list_pull_requests');
    });

    it('dispatches open-provider-connection from the connect button', async () => {
      setupMocks({ token: null });
      const el = await renderList();

      let detail: { provider?: string } | null = null;
      el.addEventListener('open-provider-connection', (e) => {
        detail = (e as CustomEvent<{ provider: string }>).detail;
      });
      (el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement).click();

      expect(detail).to.not.be.null;
      expect(detail!.provider).to.equal('github');
    });

    it('says why the list is unavailable in offline mode, without calling the API', async () => {
      settingsStore.getState().setOfflineMode(true);
      const el = await renderList();

      expect(text(el)).to.contain('unavailable while offline mode is enabled');
      expect(invokedCommands).to.not.include('list_pull_requests');
    });

    it('explains an allowlist block rather than showing an empty list', async () => {
      // A configured allowlist that does not contain api.github.com makes the
      // shared network gate refuse the provider call with BLOCKED.
      settingsStore.setState({ remoteAllowlist: ['example.invalid'] });
      try {
        const el = await renderList();
        expect(text(el)).to.contain('allowlist');
        expect(el.shadowRoot!.querySelector('.pr-item')).to.not.exist;
      } finally {
        settingsStore.setState({ remoteAllowlist: [] });
      }
    });

    it('shows the error with a retry when the list call fails', async () => {
      setupMocks({ listError: 'API rate limit exceeded' });
      const el = await renderList();

      expect(text(el)).to.contain('API rate limit exceeded');
      const retry = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
      expect(retry).to.exist;
      expect(retry.textContent).to.contain('Retry');
    });

    it('recovers from an error when retry succeeds', async () => {
      setupMocks({ listError: 'Network unreachable' });
      const el = await renderList();
      expect(text(el)).to.contain('Network unreachable');

      setupMocks({ pullRequests: [makePr()] });
      (el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement).click();
      await settle(el);

      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(1);
    });
  });

  // ── Caching and refresh ────────────────────────────────────────────────
  describe('caching and refresh', () => {
    it('does not refetch when the section is collapsed and expanded again', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();
      const firstCalls = invokedCommands.filter((c) => c === 'list_pull_requests').length;
      expect(firstCalls).to.equal(1);

      el.expanded = false;
      await settle(el);
      el.expanded = true;
      await settle(el);

      const secondCalls = invokedCommands.filter((c) => c === 'list_pull_requests').length;
      expect(secondCalls).to.equal(1);
      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(1);
    });

    it('caches per repository and reuses each cached result', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      el.repositoryPath = OTHER_REPO_PATH;
      await settle(el);
      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(2);

      el.repositoryPath = REPO_PATH;
      await settle(el);
      // Back to a repository already loaded: no third call.
      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(2);
    });

    it('refetches on an explicit refresh', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();
      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(1);

      setupMocks({ pullRequests: [makePr({ number: 43, title: 'Second' })] });
      await el.refresh();
      await settle(el);

      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(2);
      expect(text(el)).to.contain('Second');
    });

    it('retries a failed load when the section is re-expanded', async () => {
      // An error is not a result, so it must not be cached: re-opening the
      // section is the obvious "try again" gesture.
      setupMocks({ listError: 'Network unreachable' });
      const el = await renderList();
      expect(text(el)).to.contain('Network unreachable');

      el.expanded = false;
      await settle(el);
      setupMocks({ pullRequests: [makePr()] });
      el.expanded = true;
      await settle(el);

      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(1);
    });

    it('reloads when an account is connected while showing "not connected"', async () => {
      setupMocks({ token: null });
      const el = await renderList();
      expect(text(el)).to.contain('Not connected to GitHub');

      // Connecting through the dialog the Connect button opens lands as a new
      // account in the shared store; the section must notice.
      setupMocks({ token: 'gh-token', pullRequests: [makePr()] });
      unifiedProfileStore.getState().setAccounts([
        {
          id: 'gh-1',
          name: 'GitHub',
          integrationType: 'github',
          config: { type: 'pat' },
          color: null,
          cachedUser: null,
          urlPatterns: [],
          isDefault: true,
        },
      ] as never);
      await settle(el);

      expect(el.shadowRoot!.querySelectorAll('.pr-item').length).to.equal(1);
    });

    it('refetches on repository-refresh while expanded', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();
      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(1);

      window.dispatchEvent(
        new CustomEvent('repository-refresh', { detail: { repoPath: REPO_PATH } }),
      );
      await settle(el);

      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(2);
    });

    it('does not refetch on repository-refresh while collapsed', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();
      el.expanded = false;
      await settle(el);

      window.dispatchEvent(
        new CustomEvent('repository-refresh', { detail: { repoPath: REPO_PATH } }),
      );
      await settle(el);

      expect(invokedCommands.filter((c) => c === 'list_pull_requests').length).to.equal(1);
    });
  });

  // ── Count reporting ────────────────────────────────────────────────────
  describe('count reporting', () => {
    it('reports the loaded count for the section header badge', async () => {
      setupMocks({ pullRequests: [makePr(), makePr({ number: 43 })] });
      const counts: number[] = [];
      const el = await fixture<LvPullRequestList>(html`
        <lv-pull-request-list
          .repositoryPath=${REPO_PATH}
          .expanded=${true}
          @pull-request-count-changed=${(e: CustomEvent<{ count: number }>) =>
            counts.push(e.detail.count)}
        ></lv-pull-request-list>
      `);
      await settle(el);

      expect(counts[counts.length - 1]).to.equal(2);
    });

    it('reports zero for a state that has no list', async () => {
      setupMocks({ token: null });
      const counts: number[] = [];
      const el = await fixture<LvPullRequestList>(html`
        <lv-pull-request-list
          .repositoryPath=${REPO_PATH}
          .expanded=${true}
          @pull-request-count-changed=${(e: CustomEvent<{ count: number }>) =>
            counts.push(e.detail.count)}
        ></lv-pull-request-list>
      `);
      await settle(el);

      expect(counts[counts.length - 1]).to.equal(0);
    });
  });

  // ── Click-through ──────────────────────────────────────────────────────
  describe('click-through', () => {
    it('opens the pull request in the browser on click', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      (el.shadowRoot!.querySelector('.pr-item') as HTMLElement).click();
      await browserOpened();

      // openExternalUrl hands the URL to the Tauri shell plugin - the same
      // route the graph's PR badges take.
      expect(openedUrls()).to.contain('https://github.com/octo/leviathan/pull/42');
    });

    it('opens the pull request on Enter', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const item = el.shadowRoot!.querySelector('.pr-item') as HTMLElement;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await browserOpened();

      expect(openedUrls()).to.contain('https://github.com/octo/leviathan/pull/42');
    });

    it('opens the pull request on Space', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const item = el.shadowRoot!.querySelector('.pr-item') as HTMLElement;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await browserOpened();

      expect(openedUrls()).to.contain('https://github.com/octo/leviathan/pull/42');
    });
  });

  // ── Semantics ──────────────────────────────────────────────────────────
  describe('row semantics', () => {
    it('renders each row as a link whose accessible name says it opens in the browser', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const row = el.shadowRoot!.querySelector('.pr-item') as HTMLAnchorElement;
      // A real control, not a static list item dressed up with a click
      // handler: assistive tech has to announce something activatable.
      expect(row.tagName).to.equal('A');
      expect(row.getAttribute('href')).to.equal('https://github.com/octo/leviathan/pull/42');
      expect(row.getAttribute('aria-label')).to.equal(
        'Add the pull request sidebar, #42, opens in browser',
      );

      // The <li> keeps the list semantics and stops pretending to be clickable.
      const li = el.shadowRoot!.querySelector('.pr-list > li') as HTMLElement;
      expect(li.getAttribute('role')).to.equal('listitem');
      expect(li.hasAttribute('tabindex')).to.equal(false);
      expect(li.querySelector('.pr-item')).to.equal(row);
    });

    it('never lets the webview navigate to the pull request itself', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const row = el.shadowRoot!.querySelector('.pr-item') as HTMLAnchorElement;
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      row.dispatchEvent(click);
      await browserOpened();

      expect(click.defaultPrevented).to.equal(true);
      expect(openedUrls()).to.contain('https://github.com/octo/leviathan/pull/42');
    });

    it('cancels Enter so the anchor cannot also open the pull request', async () => {
      setupMocks({ pullRequests: [makePr()] });
      const el = await renderList();

      const row = el.shadowRoot!.querySelector('.pr-item') as HTMLElement;
      const key = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      row.dispatchEvent(key);
      await browserOpened();

      expect(key.defaultPrevented).to.equal(true);
      expect(openedUrls().filter((u) => u.endsWith('/pull/42')).length).to.equal(1);
    });
  });
});
