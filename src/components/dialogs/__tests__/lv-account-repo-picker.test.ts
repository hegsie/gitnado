/**
 * Tests for lv-account-repo-picker.
 *
 * Covers every state the picker has to answer for: no accounts at all, no
 * account for the chosen provider, a missing credential, a rejected (expired)
 * token, a provider API error, the security gate refusing, an empty listing,
 * loading, pagination in flight, the search filter, and handing a selected
 * repository back to the host.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invoked: { command: string; args?: unknown }[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, oneEvent, waitUntil } from '@open-wc/testing';
import '../lv-account-repo-picker.ts';
import type { LvAccountRepoPicker } from '../lv-account-repo-picker.ts';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────

const githubAccount: IntegrationAccount = {
  id: 'gh-1',
  name: 'Work GitHub',
  integrationType: 'github',
  urlPatterns: [],
  isDefault: true,
  color: null,
  config: { type: 'github' },
  cachedUser: { username: 'octocat', displayName: 'Octo', avatarUrl: null, email: null },
};

const gitlabAccount: IntegrationAccount = {
  id: 'gl-1',
  name: 'GitLab',
  integrationType: 'gitlab',
  urlPatterns: [],
  isDefault: true,
  color: null,
  config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
  cachedUser: null,
};

const adoNoOrgAccount: IntegrationAccount = {
  id: 'ado-1',
  name: 'Azure',
  integrationType: 'azure-devops',
  urlPatterns: [],
  isDefault: true,
  color: null,
  config: { type: 'azure-devops', organization: '' },
  cachedUser: null,
};

function repo(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    owner: 'octocat',
    fullName: `octocat/${name}`,
    description: null,
    isPrivate: false,
    cloneUrl: `https://github.com/octocat/${name}.git`,
    webUrl: `https://github.com/octocat/${name}`,
    defaultBranch: 'main',
    lastPushedAt: null,
    ...extra,
  };
}

/** A token exists in the keyring, with no OAuth bundle (a plain PAT account). */
function withStoredToken(
  handler: (command: string, args?: unknown) => Promise<unknown> | unknown,
): void {
  mockInvoke = (command, args) => {
    if (command === 'get_keyring_token') {
      const key = (args as { key?: string })?.key ?? '';
      // The OAuth bundle slot is empty; the plain token slot holds the PAT.
      return Promise.resolve(key.endsWith('_oauth') ? null : 'tok-123');
    }
    return Promise.resolve(handler(command, args));
  };
}

async function mount(): Promise<LvAccountRepoPicker> {
  const el = await fixture<LvAccountRepoPicker>(
    html`<lv-account-repo-picker></lv-account-repo-picker>`,
  );
  await el.updateComplete;
  return el;
}

function stateEl(el: LvAccountRepoPicker, state: string): Element | null {
  return el.shadowRoot!.querySelector(`[data-state="${state}"]`);
}

/** Wait for the picker to settle on a rendered state block. */
async function waitForState(el: LvAccountRepoPicker, state: string): Promise<Element> {
  await waitUntil(
    async () => {
      await el.updateComplete;
      return stateEl(el, state) !== null;
    },
    `expected the picker to reach the "${state}" state`,
    { timeout: 2000 },
  );
  return stateEl(el, state)!;
}

async function waitForRepoItems(el: LvAccountRepoPicker, count: number): Promise<void> {
  await waitUntil(
    async () => {
      await el.updateComplete;
      return el.shadowRoot!.querySelectorAll('.repo-item').length === count;
    },
    `expected ${count} repository rows`,
    { timeout: 2000 },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('lv-account-repo-picker', () => {
  beforeEach(() => {
    invoked.length = 0;
    mockInvoke = () => Promise.resolve(null);
    unifiedProfileStore.getState().reset();
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
  });

  describe('no accounts', () => {
    it('explains where to connect one and asks the host to open the manager', async () => {
      const el = await mount();

      const empty = stateEl(el, 'no-accounts');
      expect(empty, 'the no-accounts state is shown').to.exist;
      expect(empty!.textContent).to.contain('No accounts are connected');

      const button = empty!.querySelector('button') as HTMLButtonElement;
      setTimeout(() => button.click());
      const event = await oneEvent(el, 'manage-accounts');
      expect(event).to.exist;
    });

    it('never calls a provider API with no account to call it for', async () => {
      await mount();
      expect(invoked.map((i) => i.command)).to.not.contain('list_github_repositories');
    });
  });

  describe('a provider with no account of its own', () => {
    it('offers to connect one instead of listing nothing', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );
      const el = await mount();
      await waitForRepoItems(el, 1);

      const select = el.shadowRoot!.querySelector('#repo-provider') as HTMLSelectElement;
      select.value = 'bitbucket';
      select.dispatchEvent(new Event('change'));
      await el.updateComplete;

      expect(stateEl(el, 'no-provider-accounts')).to.exist;
    });
  });

  describe('listing', () => {
    it('loads the first page for the default account and lists it', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha'), repo('beta')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 2);

      const rows = el.shadowRoot!.querySelectorAll('.repo-item');
      expect(rows[0].textContent).to.contain('alpha');
      expect(rows[1].textContent).to.contain('beta');
      // The account's token is what the listing is made with.
      const call = invoked.find((i) => i.command === 'list_github_repositories');
      expect((call!.args as { token?: string }).token).to.equal('tok-123');
    });

    it('shows visibility and last push when the provider reports them', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? {
              repositories: [
                repo('alpha', {
                  isPrivate: true,
                  description: 'The main app',
                  lastPushedAt: '2024-05-01T10:00:00Z',
                }),
              ],
              nextPage: null,
            }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 1);

      const row = el.shadowRoot!.querySelector('.repo-item')!;
      expect(row.textContent).to.contain('Private');
      expect(row.textContent).to.contain('octocat');
      expect(row.textContent).to.contain('The main app');
      expect(row.textContent).to.contain('Updated');
    });

    it('shows a loading state while the first page is in flight', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      let release: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      withStoredToken((command) =>
        command === 'list_github_repositories' ? pending : null,
      );

      const el = await mount();
      await waitForState(el, 'loading');

      release({ repositories: [repo('alpha')], nextPage: null });
      await waitForRepoItems(el, 1);
    });

    it('says so when the account owns nothing', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories' ? { repositories: [], nextPage: null } : null,
      );

      const el = await mount();
      const empty = await waitForState(el, 'empty');
      expect(empty.textContent).to.contain('no repositories');
    });
  });

  describe('filtering', () => {
    it('filters the loaded repositories by name, owner and description', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? {
              repositories: [
                repo('alpha'),
                repo('beta'),
                repo('gamma', { description: 'alpha helper' }),
              ],
              nextPage: null,
            }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 3);

      const filter = el.shadowRoot!.querySelector('#repo-filter') as HTMLInputElement;
      filter.value = 'alpha';
      filter.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const rows = el.shadowRoot!.querySelectorAll('.repo-item');
      expect(rows.length).to.equal(2);
      expect(rows[0].textContent).to.contain('alpha');
      expect(rows[1].textContent).to.contain('gamma');
    });

    it('says when nothing loaded so far matches', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 1);

      const filter = el.shadowRoot!.querySelector('#repo-filter') as HTMLInputElement;
      filter.value = 'nothing-like-this';
      filter.dispatchEvent(new Event('input'));
      await el.updateComplete;

      expect(stateEl(el, 'no-matches')).to.exist;
    });
  });

  describe('pagination', () => {
    it('loads the next page only when asked, and appends it', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command, args) => {
        if (command !== 'list_github_repositories') return null;
        const page = (args as { page?: number }).page ?? 1;
        return page === 1
          ? { repositories: [repo('alpha')], nextPage: 2 }
          : { repositories: [repo('beta')], nextPage: null };
      });

      const el = await mount();
      await waitForRepoItems(el, 1);
      // The second page is NOT fetched up front.
      expect(
        invoked.filter((i) => i.command === 'list_github_repositories').length,
      ).to.equal(1);

      const loadMore = el.shadowRoot!.querySelector(
        '[data-action="load-more"]',
      ) as HTMLButtonElement;
      expect(loadMore).to.exist;
      loadMore.click();
      await waitForRepoItems(el, 2);

      const rows = el.shadowRoot!.querySelectorAll('.repo-item');
      expect(rows[0].textContent).to.contain('alpha');
      expect(rows[1].textContent).to.contain('beta');
      // Exhausted: no further page offered.
      expect(el.shadowRoot!.querySelector('[data-action="load-more"]')).to.equal(null);
    });

    it('shows the pagination in flight and cannot be spammed', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      let release: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      withStoredToken((command, args) => {
        if (command !== 'list_github_repositories') return null;
        const page = (args as { page?: number }).page ?? 1;
        return page === 1 ? { repositories: [repo('alpha')], nextPage: 2 } : pending;
      });

      const el = await mount();
      await waitForRepoItems(el, 1);

      const loadMore = el.shadowRoot!.querySelector(
        '[data-action="load-more"]',
      ) as HTMLButtonElement;
      loadMore.click();
      await waitUntil(
        async () => {
          await el.updateComplete;
          const btn = el.shadowRoot!.querySelector(
            '[data-action="load-more"]',
          ) as HTMLButtonElement | null;
          return !!btn && btn.disabled;
        },
        'the load-more button reports the request in flight',
        { timeout: 2000 },
      );
      expect(
        (
          el.shadowRoot!.querySelector('[data-action="load-more"]') as HTMLButtonElement
        ).textContent,
      ).to.contain('Loading more');

      release({ repositories: [repo('beta')], nextPage: null });
      await waitForRepoItems(el, 2);
    });

    it('keeps the loaded pages and the selection when a load more fails', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      const attemptedPages: number[] = [];
      let failPageThree = true;
      withStoredToken((command, args) => {
        if (command !== 'list_github_repositories') return null;
        const page = (args as { page?: number }).page ?? 1;
        attemptedPages.push(page);
        if (page === 1) return { repositories: [repo('alpha')], nextPage: 2 };
        if (page === 2) return { repositories: [repo('beta')], nextPage: 3 };
        if (page === 3 && failPageThree) {
          failPageThree = false;
          return Promise.reject({
            code: 'OPERATION_FAILED',
            message: 'GitHub API error 502: bad gateway',
          });
        }
        return { repositories: [repo('gamma')], nextPage: null };
      });

      const el = await mount();
      await waitForRepoItems(el, 1);

      const clickLoadMore = (): void => {
        (
          el.shadowRoot!.querySelector('[data-action="load-more"]') as HTMLButtonElement
        ).click();
      };
      clickLoadMore();
      await waitForRepoItems(el, 2);

      // Pick a repository, then lose page 3.
      (el.shadowRoot!.querySelectorAll('.repo-item')[1] as HTMLButtonElement).click();
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.repo-item.selected')!.textContent).to.contain(
        'beta',
      );

      clickLoadMore();
      const failure = await waitForState(el, 'load-more-error');
      expect(failure.textContent).to.contain('GitHub API error 502');

      // The two pages already paid for are still on screen, still selectable,
      // and the highlight survived.
      const rows = el.shadowRoot!.querySelectorAll('.repo-item');
      expect(rows.length).to.equal(2);
      expect(rows[0].textContent).to.contain('alpha');
      expect(rows[1].textContent).to.contain('beta');
      expect(el.shadowRoot!.querySelector('.repo-item.selected')!.textContent).to.contain(
        'beta',
      );

      // Retry resumes at page 3 rather than restarting the account.
      (failure.querySelector('button') as HTMLButtonElement).click();
      await waitForRepoItems(el, 3);
      expect(attemptedPages).to.deep.equal([1, 2, 3, 3]);
      expect(el.shadowRoot!.querySelector('[data-state="load-more-error"]')).to.equal(null);
      expect(el.shadowRoot!.querySelectorAll('.repo-item')[2].textContent).to.contain('gamma');
      expect(el.shadowRoot!.querySelector('.repo-item.selected')!.textContent).to.contain(
        'beta',
      );
    });

    it('replaces the whole list when the FIRST page fails, not just part of it', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) => {
        if (command !== 'list_github_repositories') return null;
        return Promise.reject({
          code: 'OPERATION_FAILED',
          message: 'GitHub API error 500: upstream',
        });
      });

      const el = await mount();
      await waitForState(el, 'error');
      // A first-page failure has nothing behind it, so it still takes over the
      // list area rather than rendering as an inline "load more" failure.
      expect(el.shadowRoot!.querySelector('[data-state="load-more-error"]')).to.equal(null);
      expect(el.shadowRoot!.querySelectorAll('.repo-item').length).to.equal(0);
    });
  });

  describe('failures', () => {
    it('offers to reconnect when a non-GitHub account has no stored credential', async () => {
      // No GitHub App equivalent for these providers, so there is nothing to
      // try and the request is never made.
      unifiedProfileStore.getState().setAccounts([gitlabAccount]);
      mockInvoke = () => Promise.resolve(null); // keyring has nothing

      const el = await mount();
      const message = await waitForState(el, 'no-credential');
      expect(message.textContent).to.contain('no stored credential');
      expect(message.querySelector('button')!.textContent).to.contain('Reconnect');
      expect(invoked.map((i) => i.command)).to.not.contain('list_gitlab_projects');
    });

    it('lets the GitHub App mint a token before reporting a missing credential', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      mockInvoke = (command) => {
        if (command === 'list_github_repositories') {
          // What the backend answers when neither a per-account token nor a
          // configured GitHub App can produce one.
          return Promise.reject({
            code: 'OPERATION_FAILED',
            message: 'Operation failed: GitHub token not configured',
          });
        }
        return Promise.resolve(null); // keyring has nothing
      };

      const el = await mount();
      const message = await waitForState(el, 'no-credential');
      expect(message.textContent).to.contain('no stored credential');
      // The App fallback was given its chance rather than being pre-empted.
      expect(invoked.map((i) => i.command)).to.contain('list_github_repositories');
    });

    it('lists an App installation when no per-account token is stored', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      mockInvoke = (command) => {
        if (command === 'list_github_repositories') {
          return Promise.resolve({ repositories: [repo('infra')], nextPage: null });
        }
        return Promise.resolve(null); // keyring has nothing
      };

      const el = await mount();
      await waitForRepoItems(el, 1);
      expect(el.shadowRoot!.querySelector('.repo-item')!.textContent).to.contain('infra');
    });

    it('shows the keychain error when the stored token cannot be read', async () => {
      // A keychain that refuses to be read is not "no credential": saying so
      // sent the user to reconnect an account whose token was sitting right
      // there, and a re-added account failed the same way. The keychain's own
      // message is shown, with Retry.
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      mockInvoke = (command) => {
        if (command === 'get_keyring_token') {
          return Promise.reject({
            code: 'OPERATION_FAILED',
            message: 'Keychain read failed for github_token_gh-1 (security exited with 36): User interaction is not allowed.',
          });
        }
        return Promise.resolve(null);
      };

      const el = await mount();
      const state = await waitForState(el, 'error');

      expect(state.textContent).to.contain('User interaction is not allowed');
      expect(stateEl(el, 'no-credential'), 'not reported as a missing credential').to.equal(null);
      expect(state.querySelector('.link-btn')!.textContent!.trim()).to.equal('Retry');
      expect(
        invoked.some((i) => i.command === 'list_github_repositories'),
        'no listing call is made without a token to make it with',
      ).to.be.false;
    });

    it('offers to reconnect when the token is rejected', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) => {
        if (command === 'list_github_repositories') {
          return Promise.reject({ code: 'AUTH_REQUIRED', message: 'Authentication required' });
        }
        return null;
      });

      const el = await mount();
      const message = await waitForState(el, 'auth-expired');
      expect(message.textContent).to.contain('expired');
    });

    it('surfaces a provider API error with a retry', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      let attempts = 0;
      withStoredToken((command) => {
        if (command !== 'list_github_repositories') return null;
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject({
            code: 'OPERATION_FAILED',
            message: 'GitHub API error 500: upstream',
          });
        }
        return { repositories: [repo('alpha')], nextPage: null };
      });

      const el = await mount();
      const message = await waitForState(el, 'error');
      expect(message.textContent).to.contain('GitHub API error 500');

      (message.querySelector('button') as HTMLButtonElement).click();
      await waitForRepoItems(el, 1);
    });

    it('explains an offline-mode block instead of failing silently', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      settingsStore.setState({ offlineMode: true, remoteAllowlist: [] });
      withStoredToken(() => null);

      const el = await mount();
      const message = await waitForState(el, 'blocked');
      expect(message.textContent).to.contain('Offline mode');
      expect(message.textContent).to.contain('Settings > Security');
      // The gate refuses before the command is ever sent.
      expect(invoked.map((i) => i.command)).to.not.contain('list_github_repositories');
    });

    it('explains an allowlist block naming the provider', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      settingsStore.setState({ offlineMode: false, remoteAllowlist: ['gitlab.com'] });
      withStoredToken(() => null);

      const el = await mount();
      const message = await waitForState(el, 'blocked');
      expect(message.textContent).to.contain('allowlist');
      expect(message.textContent).to.contain('GitHub');
    });

    it('reports an account whose provider detail is missing', async () => {
      unifiedProfileStore.getState().setAccounts([adoNoOrgAccount]);
      withStoredToken(() => null);

      const el = await mount();
      const message = await waitForState(el, 'error');
      expect(message.textContent).to.contain('organization');
      expect(invoked.map((i) => i.command)).to.not.contain('list_ado_repositories');
    });
  });

  describe('selection', () => {
    it('hands the selected repository to the host', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 1);

      const row = el.shadowRoot!.querySelector('.repo-item') as HTMLButtonElement;
      setTimeout(() => row.click());
      const event = (await oneEvent(el, 'repository-selected')) as CustomEvent;
      expect(event.detail.repository.cloneUrl).to.equal(
        'https://github.com/octocat/alpha.git',
      );
      // The account the repository was listed under travels with it: the
      // clone must authenticate as that account, not as the host's default.
      expect(event.detail.account?.id).to.equal('gh-1');

      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.repo-item.selected')).to.exist;
    });

    it('hands over the account the repository was listed under, not the default one', async () => {
      const personal: IntegrationAccount = {
        ...githubAccount,
        id: 'gh-2',
        name: 'Personal GitHub',
        isDefault: false,
      };
      unifiedProfileStore.getState().setAccounts([githubAccount, personal]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 1);

      const selector = el.shadowRoot!.querySelector('lv-account-selector')!;
      selector.dispatchEvent(
        new CustomEvent('account-change', {
          detail: { account: personal },
          bubbles: true,
          composed: true,
        }),
      );
      await waitForRepoItems(el, 1);

      const row = el.shadowRoot!.querySelector('.repo-item') as HTMLButtonElement;
      setTimeout(() => row.click());
      const event = (await oneEvent(el, 'repository-selected')) as CustomEvent;
      expect(event.detail.account?.id).to.equal('gh-2');
    });
  });

  describe('accessibility of the list', () => {
    it('exposes each repository as a button inside a list row', async () => {
      // role="listitem" ON the button would override its implicit button role,
      // leaving a screen reader announcing static list text where there is a
      // control the user has to activate.
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha'), repo('beta')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 2);

      const list = el.shadowRoot!.querySelector('.repo-list')!;
      expect(list.tagName).to.equal('UL');
      expect(list.getAttribute('role')).to.equal('list');
      expect(list.getAttribute('aria-label')).to.equal('Repositories');

      const rows = Array.from(el.shadowRoot!.querySelectorAll('.repo-item'));
      expect(rows.length).to.equal(2);
      for (const row of rows) {
        expect(row.tagName).to.equal('BUTTON');
        // No explicit role: the implicit button role is what has to survive.
        expect(row.getAttribute('role')).to.equal(null);
        expect(row.parentElement!.tagName).to.equal('LI');
        expect(row.parentElement!.getAttribute('role')).to.equal('listitem');
      }
    });

    it('states the selection with aria-pressed, not just a background colour', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha'), repo('beta')], nextPage: null }
          : null,
      );

      const el = await mount();
      await waitForRepoItems(el, 2);

      let rows = Array.from(
        el.shadowRoot!.querySelectorAll('.repo-item'),
      ) as HTMLButtonElement[];
      expect(rows.map((r) => r.getAttribute('aria-pressed'))).to.deep.equal([
        'false',
        'false',
      ]);

      rows[1].click();
      await el.updateComplete;

      rows = Array.from(el.shadowRoot!.querySelectorAll('.repo-item')) as HTMLButtonElement[];
      expect(rows.map((r) => r.getAttribute('aria-pressed'))).to.deep.equal([
        'false',
        'true',
      ]);
      expect(rows[1].classList.contains('selected')).to.be.true;
    });
  });

  describe('disabled', () => {
    it('passes the lock through to its account selector', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );
      // Mounted live and locked afterwards, the way the clone dialog does it
      // when a clone starts.
      const el = await mount();
      await waitForRepoItems(el, 1);
      el.disabled = true;
      await el.updateComplete;

      // The picker's own controls honour `disabled`; the selector nested inside
      // it must too, or its "Manage Accounts…" stays live while the host that
      // disabled us (the clone dialog mid-clone) has locked everything else.
      const selector = el.shadowRoot!.querySelector('lv-account-selector') as HTMLElement & {
        disabled: boolean;
        updateComplete: Promise<unknown>;
      };
      expect(selector.disabled, 'the selector is disabled with the picker').to.be.true;
      await selector.updateComplete;
      expect(
        (selector.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement).disabled,
      ).to.be.true;
      expect(
        (el.shadowRoot!.querySelector('#repo-provider') as HTMLSelectElement).disabled,
        'control: the provider select is disabled too',
      ).to.be.true;
    });

    /**
     * Lock the picker and assert that every action button inside the state
     * message it is showing is disabled. The state messages are reachable
     * mid-clone (pick "From account", land on any of them, paste a URL below,
     * Clone), and their "Connect an account" / "Reconnect" / "Retry" buttons
     * stayed live while the rest of the dialog was locked — each click was
     * swallowed by a guard further along, so they were silent no-ops.
     */
    async function expectStateActionsLocked(
      el: LvAccountRepoPicker,
      state: string,
      expectedLabels: string[],
    ): Promise<void> {
      const before = Array.from(
        el.shadowRoot!.querySelectorAll(`[data-state="${state}"] .link-btn`),
      ) as HTMLButtonElement[];
      expect(
        before.map((b) => b.textContent!.trim()),
        `control: the "${state}" state offers its actions`,
      ).to.deep.equal(expectedLabels);
      expect(before.every((b) => !b.disabled), 'control: live before the lock').to.be.true;

      el.disabled = true;
      await el.updateComplete;

      const after = Array.from(
        el.shadowRoot!.querySelectorAll(`[data-state="${state}"] .link-btn`),
      ) as HTMLButtonElement[];
      expect(after.length).to.equal(expectedLabels.length);
      for (const button of after) {
        expect(button.disabled, `"${button.textContent!.trim()}" in "${state}" is locked`).to.be
          .true;
      }
    }

    it('locks "Connect an account" when no account is connected', async () => {
      const el = await mount();
      await expectStateActionsLocked(el, 'no-accounts', ['Connect an account']);
    });

    it('locks "Connect an account" for a provider with no account', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: null }
          : null,
      );
      const el = await mount();
      await waitForRepoItems(el, 1);
      const select = el.shadowRoot!.querySelector('#repo-provider') as HTMLSelectElement;
      select.value = 'bitbucket';
      select.dispatchEvent(new Event('change'));
      await el.updateComplete;

      await expectStateActionsLocked(el, 'no-provider-accounts', ['Connect an account']);
    });

    it('locks Retry on an empty listing', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories' ? { repositories: [], nextPage: null } : null,
      );
      const el = await mount();
      await waitForState(el, 'empty');

      await expectStateActionsLocked(el, 'empty', ['Retry']);
    });

    it('locks Retry on a provider API error', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? Promise.reject({ code: 'OPERATION_FAILED', message: 'GitHub API error 500' })
          : null,
      );
      const el = await mount();
      await waitForState(el, 'error');

      await expectStateActionsLocked(el, 'error', ['Retry']);
    });

    it('locks Reconnect and Retry when the account has no credential', async () => {
      unifiedProfileStore.getState().setAccounts([gitlabAccount]);
      mockInvoke = () => Promise.resolve(null);
      const el = await mount();
      await waitForState(el, 'no-credential');

      await expectStateActionsLocked(el, 'no-credential', ['Reconnect account', 'Retry']);
    });

    it('locks Reconnect and Retry when the token was rejected', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? Promise.reject({ code: 'AUTH_REQUIRED', message: 'Authentication required' })
          : null,
      );
      const el = await mount();
      await waitForState(el, 'auth-expired');

      await expectStateActionsLocked(el, 'auth-expired', ['Reconnect account', 'Retry']);
    });

    it('locks Retry on a failed "Load more"', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command, args) => {
        if (command !== 'list_github_repositories') return null;
        const page = (args as { page?: number }).page ?? 1;
        if (page === 2) {
          return Promise.reject({ code: 'OPERATION_FAILED', message: 'GitHub API error 502' });
        }
        return { repositories: [repo('alpha')], nextPage: 2 };
      });
      const el = await mount();
      await waitForRepoItems(el, 1);
      (el.shadowRoot!.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
      await waitForState(el, 'load-more-error');

      await expectStateActionsLocked(el, 'load-more-error', ['Retry']);
    });

    it('locks Retry on a "Load more" the allowlist refused', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount]);
      withStoredToken((command) =>
        command === 'list_github_repositories'
          ? { repositories: [repo('alpha')], nextPage: 2 }
          : null,
      );
      const el = await mount();
      await waitForRepoItems(el, 1);
      // The allowlist changes underneath a listing that is already on screen,
      // so the next page is refused and the block offers a Retry.
      settingsStore.setState({ offlineMode: false, remoteAllowlist: ['gitlab.com'] });
      (el.shadowRoot!.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
      await waitForState(el, 'blocked');

      await expectStateActionsLocked(el, 'blocked', ['Retry']);
    });
  });

  describe('account switching', () => {
    it('lists the newly chosen provider account', async () => {
      unifiedProfileStore.getState().setAccounts([githubAccount, gitlabAccount]);
      withStoredToken((command) => {
        if (command === 'list_github_repositories') {
          return { repositories: [repo('alpha')], nextPage: null };
        }
        if (command === 'list_gitlab_projects') {
          return { repositories: [repo('gl-project')], nextPage: null };
        }
        return null;
      });

      const el = await mount();
      await waitForRepoItems(el, 1);

      const select = el.shadowRoot!.querySelector('#repo-provider') as HTMLSelectElement;
      select.value = 'gitlab';
      select.dispatchEvent(new Event('change'));

      await waitUntil(
        async () => {
          await el.updateComplete;
          const row = el.shadowRoot!.querySelector('.repo-item');
          return !!row && row.textContent!.includes('gl-project');
        },
        'the GitLab account listing replaces the GitHub one',
        { timeout: 2000 },
      );

      const call = invoked.find((i) => i.command === 'list_gitlab_projects');
      expect((call!.args as { instanceUrl?: string }).instanceUrl).to.equal(
        'https://gitlab.com',
      );
    });

    it('shows the newly chosen provider account in its selector', async () => {
      // The selector used to keep the accounts of the provider it was mounted
      // with, so after switching it showed the GitLab account as "No account
      // selected" and its dropdown still offered the GitHub accounts.
      unifiedProfileStore.getState().setAccounts([githubAccount, gitlabAccount]);
      withStoredToken((command) => {
        if (command === 'list_github_repositories') {
          return { repositories: [repo('alpha')], nextPage: null };
        }
        if (command === 'list_gitlab_projects') {
          return { repositories: [repo('gl-project')], nextPage: null };
        }
        return null;
      });

      const el = await mount();
      await waitForRepoItems(el, 1);

      const select = el.shadowRoot!.querySelector('#repo-provider') as HTMLSelectElement;
      select.value = 'gitlab';
      select.dispatchEvent(new Event('change'));
      await waitUntil(
        async () => {
          await el.updateComplete;
          const row = el.shadowRoot!.querySelector('.repo-item');
          return !!row && row.textContent!.includes('gl-project');
        },
        'the GitLab account listing replaces the GitHub one',
        { timeout: 2000 },
      );

      const selector = el.shadowRoot!.querySelector('lv-account-selector') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await selector.updateComplete;
      expect(selector.shadowRoot!.querySelector('.no-account')).to.equal(null);
      expect(selector.shadowRoot!.querySelector('.account-name')!.textContent).to.include(
        'GitLab',
      );

      (selector.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement).click();
      await selector.updateComplete;
      const items = Array.from(selector.shadowRoot!.querySelectorAll('.dropdown-item'));
      expect(items.length, 'only the GitLab account is offered').to.equal(1);
      expect(items[0].textContent).to.include('GitLab');
      expect(items[0].textContent).to.not.include('Work GitHub');
    });
  });
});
