/**
 * Tests for gn-context-dashboard component.
 *
 * Renders the REAL gn-context-dashboard component, mocking only the Tauri
 * invoke layer and Zustand stores, then verifies DOM output and interactions.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import type { UnifiedProfile, IntegrationAccount } from '../../../types/unified-profile.types.ts';
import type { Repository, Branch, Remote } from '../../../types/git.types.ts';
import type { GnContextDashboard } from '../gn-context-dashboard.ts';

// Import the actual component — registers <gn-context-dashboard> custom element
import '../gn-context-dashboard.ts';

// ── Constants ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'gn-context-dashboard-expanded';

// ── Test data ──────────────────────────────────────────────────────────────
function makeProfile(overrides: Partial<UnifiedProfile> = {}): UnifiedProfile {
  return {
    id: 'profile-1',
    name: 'Work',
    gitName: 'John Doe',
    gitEmail: 'john@work.com',
    signingKey: null,
    urlPatterns: [],
    isDefault: false,
    color: '#3b82f6',
    defaultAccounts: {},
    ...overrides,
  };
}

function makeAccount(overrides: Partial<IntegrationAccount> = {}): IntegrationAccount {
  return {
    id: 'account-1',
    name: 'Work GitHub',
    integrationType: 'github',
    config: { type: 'github' },
    color: null,
    cachedUser: null,
    urlPatterns: [],
    isDefault: false,
    ...overrides,
  };
}

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    path: '/test/repo',
    name: 'my-repo',
    isValid: true,
    isBare: false,
    headRef: 'refs/heads/main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
    ...overrides,
  };
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
    ...overrides,
  };
}

function makeRemote(overrides: Partial<Remote> = {}): Remote {
  return {
    name: 'origin',
    url: 'https://github.com/user/repo.git',
    pushUrl: null,
    ...overrides,
  };
}

const defaultProfile = makeProfile();
const defaultAccount = makeAccount();
const defaultRepo = makeRepository();
const defaultBranch = makeBranch();
const defaultRemote = makeRemote();

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function setupStores(opts: {
  profile?: UnifiedProfile | null;
  profiles?: UnifiedProfile[];
  accounts?: IntegrationAccount[];
  repository?: Repository | null;
  currentBranch?: Branch | null;
  remotes?: Remote[];
  repositoryAssignments?: Record<string, string>;
} = {}): void {
  const profile = opts.profile !== undefined ? opts.profile : defaultProfile;
  const profiles = opts.profiles ?? (profile ? [profile] : []);
  const accounts = opts.accounts ?? [defaultAccount];
  const repository = opts.repository !== undefined ? opts.repository : defaultRepo;
  const currentBranch = opts.currentBranch !== undefined ? opts.currentBranch : defaultBranch;
  const remotes = opts.remotes ?? [defaultRemote];
  const repositoryAssignments = opts.repositoryAssignments ?? {};

  // Set up unified profile store
  const profileState = unifiedProfileStore.getState();
  profileState.setActiveProfile(profile);
  profileState.setProfiles(profiles);
  profileState.setAccounts(accounts);
  profileState.setConfig({
    version: 3,
    profiles,
    accounts,
    repositoryAssignments,
  });

  // Set up repository store
  if (repository) {
    const repoState = repositoryStore.getState();
    repoState.addRepository(repository);
    // Update the active repo data
    repoState.setCurrentBranch(currentBranch);
    repoState.setRemotes(remotes);
  }
}

function teardownStores(): void {
  unifiedProfileStore.getState().reset();
  repositoryStore.getState().reset();
}

async function renderDashboard(): Promise<GnContextDashboard> {
  const el = await fixture<GnContextDashboard>(
    html`<gn-context-dashboard></gn-context-dashboard>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-context-dashboard', () => {
  beforeEach(() => {
    clearHistory();
    mockInvoke = async () => null;
    // Ensure the dashboard starts collapsed by clearing persisted expand state
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  });

  afterEach(() => {
    teardownStores();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  });

  describe('rendering', () => {
    it('renders nothing when no active repository', async () => {
      // Set up profile store with a profile but no repository
      const profileState = unifiedProfileStore.getState();
      profileState.setActiveProfile(defaultProfile);
      profileState.setProfiles([defaultProfile]);
      profileState.setAccounts([defaultAccount]);

      const el = await renderDashboard();
      // The component returns nothing when no active repository
      const compact = el.shadowRoot!.querySelector('.dashboard-compact');
      const expanded = el.shadowRoot!.querySelector('.dashboard-expanded');
      expect(compact).to.be.null;
      expect(expanded).to.be.null;
    });

    it('renders compact view by default', async () => {
      setupStores();
      const el = await renderDashboard();

      const compact = el.shadowRoot!.querySelector('.dashboard-compact');
      expect(compact).to.not.be.null;

      const expanded = el.shadowRoot!.querySelector('.dashboard-expanded');
      expect(expanded).to.be.null;
    });

    it('displays profile name in compact view', async () => {
      setupStores();
      const el = await renderDashboard();

      const profileName = el.shadowRoot!.querySelector('.profile-name');
      expect(profileName).to.not.be.null;
      expect(profileName!.textContent).to.include('Work');
    });

    it('displays git identity in compact view', async () => {
      setupStores();
      const el = await renderDashboard();

      const identity = el.shadowRoot!.querySelector('.compact-identity');
      expect(identity).to.not.be.null;
      expect(identity!.textContent).to.include('John Doe');
      expect(identity!.textContent).to.include('john@work.com');
    });

    it('warns about a detached HEAD in the collapsed bar', async () => {
      setupStores({
        repository: makeRepository({
          headRef: 'HEAD',
          detachedHeadOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        }),
        currentBranch: null,
      });
      const el = await renderDashboard();

      const chip = el.shadowRoot!.querySelector('.dashboard-compact .detached-head');
      expect(chip).to.not.be.null;
      expect(chip!.textContent).to.include('Detached HEAD @ a1b2c3d');
      expect(chip!.getAttribute('title')).to.include(
        'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
      );
    });

    it('shows no detached warning while on a branch', async () => {
      setupStores();
      const el = await renderDashboard();

      expect(el.shadowRoot!.querySelector('.detached-head')).to.be.null;
    });

    it('shows profile color dot in compact view', async () => {
      setupStores();
      const el = await renderDashboard();

      const dot = el.shadowRoot!.querySelector('.profile-dot') as HTMLElement;
      expect(dot).to.not.be.null;
      // Browser converts hex to rgb
      const bg = dot.style.background;
      expect(bg === '#3b82f6' || bg.includes('rgb(59, 130, 246)')).to.be.true;
    });
  });

  describe('expand/collapse', () => {
    it('toggles to expanded view when expand button is clicked', async () => {
      setupStores();
      const el = await renderDashboard();

      // Verify starts compact
      expect(el.shadowRoot!.querySelector('.dashboard-compact')).to.not.be.null;

      // Click expand button
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expect(expandBtn).to.not.be.null;
      expandBtn.click();
      await el.updateComplete;

      const expanded = el.shadowRoot!.querySelector('.dashboard-expanded');
      expect(expanded).to.not.be.null;
    });

    it('shows dashboard title in expanded view', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dashboard-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('Repository Context');
    });

    it('renders profile card in expanded view', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const profileCard = el.shadowRoot!.querySelector('gn-profile-card');
      expect(profileCard).to.not.be.null;
    });

    it('renders repository card in expanded view', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const repoCard = el.shadowRoot!.querySelector('gn-repository-card');
      expect(repoCard).to.not.be.null;
    });

    it('renders integration card in expanded view when account exists', async () => {
      setupStores({
        accounts: [defaultAccount],
        profile: makeProfile({ defaultAccounts: { github: 'account-1' } }),
      });
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const integrationCard = el.shadowRoot!.querySelector('gn-integration-card');
      expect(integrationCard).to.not.be.null;
    });

    it('collapses back to compact view when collapse button is clicked', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand first
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      // Verify expanded
      expect(el.shadowRoot!.querySelector('.dashboard-expanded')).to.not.be.null;

      // Then collapse
      const collapseBtn = el.shadowRoot!.querySelector('.expand-btn.expanded') as HTMLButtonElement;
      expect(collapseBtn).to.not.be.null;
      collapseBtn.click();
      await el.updateComplete;

      const compact = el.shadowRoot!.querySelector('.dashboard-compact');
      expect(compact).to.not.be.null;
      const expanded = el.shadowRoot!.querySelector('.dashboard-expanded');
      expect(expanded).to.be.null;
    });

    it('persists expanded state to localStorage', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      expect(localStorage.getItem(STORAGE_KEY)).to.equal('true');
    });
  });

  describe('provider detection', () => {
    it('shows account status dot for GitHub repos in compact view when connected', async () => {
      const ghAccount = makeAccount({ integrationType: 'github' });
      setupStores({
        accounts: [ghAccount],
        profile: makeProfile({ defaultAccounts: { github: ghAccount.id } }),
        remotes: [makeRemote({ url: 'https://github.com/user/repo.git' })],
      });
      // Set the account connection status to 'connected' so the dot (not Reconnect btn) is shown
      unifiedProfileStore.getState().setAccountConnectionStatus(ghAccount.id, 'connected');
      const el = await renderDashboard();

      // In compact view, a connected account shows account-status-btn with status dot
      const statusBtn = el.shadowRoot!.querySelector('.account-status-btn');
      expect(statusBtn).to.not.be.null;
      const dot = statusBtn!.querySelector('.account-status-dot');
      expect(dot).to.not.be.null;
      expect(dot!.classList.contains('connected')).to.be.true;
    });

    it('shows reconnect button for GitHub repos in compact view when disconnected', async () => {
      const ghAccount = makeAccount({ integrationType: 'github' });
      setupStores({
        accounts: [ghAccount],
        profile: makeProfile({ defaultAccounts: { github: ghAccount.id } }),
        remotes: [makeRemote({ url: 'https://github.com/user/repo.git' })],
      });
      // Disconnected/unknown status shows a "Reconnect" button instead of status dot
      unifiedProfileStore.getState().setAccountConnectionStatus(ghAccount.id, 'disconnected');
      const el = await renderDashboard();

      const configureBtn = el.shadowRoot!.querySelector('.configure-btn');
      expect(configureBtn).to.not.be.null;
      expect(configureBtn!.textContent).to.include('Reconnect');
    });

    it('shows configure button when provider detected but no account in compact view', async () => {
      setupStores({
        accounts: [],
        remotes: [makeRemote({ url: 'https://github.com/user/repo.git' })],
      });
      const el = await renderDashboard();

      const configureBtn = el.shadowRoot!.querySelector('.configure-btn');
      expect(configureBtn).to.not.be.null;
      expect(configureBtn!.textContent).to.include('Connect');
      expect(configureBtn!.textContent).to.include('GitHub');
    });

    it('shows configure card for GitLab repos without account in expanded view', async () => {
      setupStores({
        accounts: [],
        remotes: [makeRemote({ url: 'https://gitlab.com/user/repo.git' })],
      });
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const configureCard = el.shadowRoot!.querySelector('.configure-card');
      expect(configureCard).to.not.be.null;
      const cardTitle = el.shadowRoot!.querySelector('.configure-card-title');
      expect(cardTitle).to.not.be.null;
      expect(cardTitle!.textContent).to.include('GitLab');
    });

    it('detects Azure DevOps from remote URL', async () => {
      setupStores({
        accounts: [],
        remotes: [makeRemote({ url: 'https://dev.azure.com/org/project/_git/repo' })],
      });
      const el = await renderDashboard();

      const configureBtn = el.shadowRoot!.querySelector('.configure-btn');
      expect(configureBtn).to.not.be.null;
      expect(configureBtn!.textContent).to.include('Azure DevOps');
    });

    it('detects Bitbucket from remote URL', async () => {
      setupStores({
        accounts: [],
        remotes: [makeRemote({ url: 'https://bitbucket.org/team/repo.git' })],
      });
      const el = await renderDashboard();

      const configureBtn = el.shadowRoot!.querySelector('.configure-btn');
      expect(configureBtn).to.not.be.null;
      expect(configureBtn!.textContent).to.include('Bitbucket');
    });
  });

  describe('no profile state', () => {
    it('shows "No profile active" in compact view when no profile', async () => {
      setupStores({ profile: null, accounts: [] });
      const el = await renderDashboard();

      const noProfile = el.shadowRoot!.querySelector('.no-profile');
      expect(noProfile).to.not.be.null;
      expect(noProfile!.textContent).to.include('No profile active');
    });

    it('shows "Set up profile" button when no profile', async () => {
      setupStores({ profile: null, accounts: [] });
      const el = await renderDashboard();

      const setupBtn = el.shadowRoot!.querySelector('.no-profile-btn');
      expect(setupBtn).to.not.be.null;
      expect(setupBtn!.textContent).to.include('Set up profile');
    });

    it('dispatches open-profile-manager when "Set up profile" is clicked', async () => {
      setupStores({ profile: null, accounts: [] });
      const el = await renderDashboard();

      let eventFired = false;
      el.addEventListener('open-profile-manager', () => { eventFired = true; });

      const setupBtn = el.shadowRoot!.querySelector('.no-profile-btn') as HTMLButtonElement;
      expect(setupBtn).to.not.be.null;
      setupBtn.click();
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });
  });

  describe('remote buttons', () => {
    it('renders fetch, pull, and push buttons in compact view', async () => {
      setupStores();
      const el = await renderDashboard();

      const remoteButtons = el.shadowRoot!.querySelectorAll('.remote-btn');
      expect(remoteButtons.length).to.equal(3);

      const buttonLabels = Array.from(remoteButtons).map((b) => b.textContent?.trim());
      expect(buttonLabels).to.include('Fetch');
      expect(buttonLabels).to.include('Pull');
      expect(buttonLabels).to.include('Push');
    });
  });

  describe('expand button aria', () => {
    it('has correct aria-expanded="false" when collapsed', async () => {
      setupStores();
      const el = await renderDashboard();

      // Ensure we're in compact view
      expect(el.shadowRoot!.querySelector('.dashboard-compact')).to.not.be.null;

      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expect(expandBtn.getAttribute('aria-expanded')).to.equal('false');
    });

    it('has correct aria-expanded="true" when expanded', async () => {
      setupStores();
      const el = await renderDashboard();

      // Expand
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      // In expanded view, the expand-btn has class "expanded"
      const collapseBtn = el.shadowRoot!.querySelector('.expand-btn.expanded') as HTMLButtonElement;
      expect(collapseBtn).to.not.be.null;
      expect(collapseBtn.getAttribute('aria-expanded')).to.equal('true');
    });
  });

  // D10: the dashboard acts as an event bus — child-card events bubble in and are
  // re-dispatched upward (to app-shell) by the dashboard.
  describe('event bus relay (D10)', () => {
    async function renderExpandedWithIntegrationCard(): Promise<GnContextDashboard> {
      setupStores({
        accounts: [defaultAccount],
        profile: makeProfile({ defaultAccounts: { github: 'account-1' } }),
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;
      return el;
    }

    it('re-dispatches integration-card refresh-account upward', async () => {
      const el = await renderExpandedWithIntegrationCard();
      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card, 'integration card rendered').to.not.be.null;

      let relayed: CustomEvent | null = null;
      el.addEventListener('refresh-account', ((e: CustomEvent) => {
        relayed = e;
      }) as EventListener);

      card!.dispatchEvent(
        new CustomEvent('refresh-account', {
          detail: { accountId: 'account-1' },
          bubbles: true,
          composed: true,
        })
      );
      await el.updateComplete;

      expect(relayed, 'refresh-account relayed').to.not.be.null;
      expect((relayed! as CustomEvent).detail).to.deep.equal({ accountId: 'account-1' });
    });

    it('re-dispatches integration-card open-dialog as open-<provider> upward', async () => {
      const el = await renderExpandedWithIntegrationCard();
      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card).to.not.be.null;

      let openGithub = false;
      el.addEventListener('open-github', () => {
        openGithub = true;
      });

      card!.dispatchEvent(new CustomEvent('open-dialog', { bubbles: true, composed: true }));
      await el.updateComplete;

      expect(openGithub, 'open-github relayed for a github account').to.be.true;
    });

    it('re-dispatches profile-card edit-profile as open-profile-manager upward', async () => {
      setupStores();
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const profileCard = el.shadowRoot!.querySelector('gn-profile-card');
      expect(profileCard).to.not.be.null;

      let openProfileManager = false;
      el.addEventListener('open-profile-manager', () => {
        openProfileManager = true;
      });

      profileCard!.dispatchEvent(new CustomEvent('edit-profile', { bubbles: true, composed: true }));
      await el.updateComplete;

      expect(openProfileManager, 'edit-profile -> open-profile-manager').to.be.true;
    });
  });

  // ── Profile-switch error feedback (Wave 1, item 5) ─────────────────────────
  describe('profile switch error feedback', () => {
    it('surfaces an error toast when applying a profile fails (no silent catch)', async () => {
      setupStores({
        profiles: [defaultProfile, makeProfile({ id: 'profile-2', name: 'Personal' })],
      });
      mockInvoke = async (command: string) => {
        if (command === 'apply_unified_profile') {
          throw new Error('git config is locked');
        }
        return null;
      };

      const el = await renderDashboard();
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dash = el as any;
      await dash.handleSelectProfile(makeProfile({ id: 'profile-2', name: 'Personal' }));
      await el.updateComplete;

      // The repository store error field has no render sink, so the failure must
      // be surfaced via a visible error toast.
      const errorToasts = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errorToasts.length, 'an error toast is shown').to.be.greaterThan(0);
      expect(errorToasts[0].message).to.include('Failed to switch profile');
      expect(errorToasts[0].message).to.include('git config is locked');
    });

    it('does not show an error toast on a successful profile switch', async () => {
      setupStores({
        profiles: [defaultProfile, makeProfile({ id: 'profile-2', name: 'Personal' })],
      });
      mockInvoke = async () => null;

      const el = await renderDashboard();
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dash = el as any;
      await dash.handleSelectProfile(makeProfile({ id: 'profile-2', name: 'Personal' }));
      await el.updateComplete;

      expect(uiStore.getState().toasts.filter((t) => t.type === 'error')).to.have.lengthOf(0);
    });
  });

  // ── Backend parity for account/profile resolution ──────────────────────────
  describe('repository account resolution (backend parity)', () => {
    // getRelevantAccount()/getProfileAssignmentSource() must predict what the
    // Rust `get_repository_preferred_account` / `url_matches_pattern` resolve,
    // otherwise the dashboard advertises one account while PR and pipeline
    // calls use another.

    it('falls back to the global default account, not the first account of the type', async () => {
      setupStores({
        accounts: [
          makeAccount({ id: 'account-1', name: 'First GitHub' }),
          makeAccount({ id: 'account-2', name: 'Global GitHub', isDefault: true }),
        ],
        profile: makeProfile({ defaultAccounts: {} }),
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card, 'integration card rendered').to.not.be.null;
      const name = card!.shadowRoot!.querySelector('.account-name');
      expect(name!.textContent).to.include('Global GitHub');
    });

    it('uses the global default when no profile is active', async () => {
      setupStores({
        accounts: [
          makeAccount({ id: 'account-1', name: 'First GitHub' }),
          makeAccount({ id: 'account-2', name: 'Global GitHub', isDefault: true }),
        ],
        profile: null,
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card, 'integration card rendered').to.not.be.null;
      const name = card!.shadowRoot!.querySelector('.account-name');
      expect(name!.textContent).to.include('Global GitHub');
    });

    it('matches an account whose trailing /* pattern spans nested path segments', async () => {
      setupStores({
        accounts: [
          makeAccount({ id: 'account-1', name: 'Global GitHub', isDefault: true }),
          makeAccount({
            id: 'account-2',
            name: 'Work-org GitHub',
            urlPatterns: ['github.com/work-org/*'],
          }),
        ],
        profile: makeProfile({ defaultAccounts: {} }),
        remotes: [makeRemote({ url: 'https://github.com/work-org/team/some-repo.git' })],
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card, 'integration card rendered').to.not.be.null;
      const name = card!.shadowRoot!.querySelector('.account-name');
      expect(name!.textContent).to.include('Work-org GitHub');
    });

    it('labels the profile as matched by URL pattern for a nested remote', async () => {
      setupStores({
        profile: makeProfile({ urlPatterns: ['github.com/work-org/*'], isDefault: false }),
        remotes: [makeRemote({ url: 'https://github.com/work-org/team/some-repo.git' })],
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const profileCard = el.shadowRoot!.querySelector('gn-profile-card');
      expect(profileCard, 'profile card rendered').to.not.be.null;
      const source = profileCard!.shadowRoot!.querySelector('.assignment-source');
      expect(source!.textContent).to.include('Matched by URL pattern');
    });

    it('shows the connect card when no account of the detected provider exists', async () => {
      setupStores({
        accounts: [makeAccount({ id: 'gl-1', integrationType: 'gitlab', isDefault: true })],
        profile: makeProfile({ defaultAccounts: {} }),
        remotes: [makeRemote({ url: 'https://github.com/user/repo.git' })],
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('gn-integration-card')).to.be.null;
      const cardTitle = el.shadowRoot!.querySelector('.configure-card-title');
      expect(cardTitle!.textContent).to.include('GitHub not connected');
    });

    it('does not let a non-matching pattern account hijack resolution', async () => {
      setupStores({
        accounts: [
          makeAccount({
            id: 'account-1',
            name: 'Other-host GitHub',
            urlPatterns: ['gitlab.com/work-org/*'],
          }),
          makeAccount({ id: 'account-2', name: 'Global GitHub', isDefault: true }),
        ],
        profile: makeProfile({ defaultAccounts: {} }),
        remotes: [makeRemote({ url: 'https://github.com/work-org/team/some-repo.git' })],
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      const name = card!.shadowRoot!.querySelector('.account-name');
      expect(name!.textContent).to.include('Global GitHub');
    });
  });

  // ── Profile-switch refresh + confirmation ──────────────────────────────────
  // Applying a profile rewrites the repo's local git identity/signing config,
  // so the switch must refresh listeners (the commit panel re-reads the author
  // behind its commit-template placeholder) and confirm itself, exactly like
  // the profile manager dialog's Apply and this component's fetch/pull/push.
  describe('profile switch refresh + confirmation', () => {
    const personalProfile = makeProfile({ id: 'profile-2', name: 'Personal' });

    function captureRefresh(el: HTMLElement): { event: CustomEvent | null } {
      const captured: { event: CustomEvent | null } = { event: null };
      el.addEventListener('repository-refresh', (e: Event) => {
        captured.event = e as CustomEvent;
      });
      return captured;
    }

    it('dispatches repository-refresh naming the repo the switch ran on', async () => {
      setupStores({ profiles: [defaultProfile, personalProfile] });
      mockInvoke = async () => null;

      const el = await renderDashboard();
      const captured = captureRefresh(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSelectProfile(personalProfile);
      await el.updateComplete;

      expect(captured.event, 'a repository-refresh is dispatched').to.not.be.null;
      // bubbles + composed so it escapes the shadow root and reaches both
      // app-shell's @repository-refresh binding and its window listener.
      expect(captured.event!.bubbles, 'event bubbles').to.be.true;
      expect(captured.event!.composed, 'event is composed').to.be.true;
      expect(captured.event!.detail.repoPath).to.equal('/test/repo');
    });

    it('confirms the switch with a success toast naming the profile', async () => {
      setupStores({ profiles: [defaultProfile, personalProfile] });
      mockInvoke = async () => null;

      const el = await renderDashboard();
      uiStore.setState({ toasts: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSelectProfile(personalProfile);
      await el.updateComplete;

      const successToasts = uiStore.getState().toasts.filter((t) => t.type === 'success');
      expect(successToasts, 'a success toast is shown').to.have.lengthOf(1);
      expect(successToasts[0].message).to.include('Personal');
    });

    it('names the repo the switch started in even if the user switches tabs mid-apply', async () => {
      setupStores({ profiles: [defaultProfile, personalProfile] });
      mockInvoke = async (command: string) => {
        if (command === 'apply_unified_profile') {
          // The user opens another repo while the IPC round-trip is in flight;
          // addRepository activates it, so this.activeRepository changes before
          // the await resolves.
          repositoryStore
            .getState()
            .addRepository(makeRepository({ path: '/test/other', name: 'other' }));
        }
        return null;
      };

      const el = await renderDashboard();
      const captured = captureRefresh(el);
      clearHistory();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSelectProfile(personalProfile);
      await el.updateComplete;

      const applyCall = invokeHistory.find((c) => c.command === 'apply_unified_profile');
      expect(applyCall, 'the profile was applied').to.not.be.undefined;
      expect((applyCall!.args as { path: string }).path).to.equal('/test/repo');

      expect(captured.event, 'a repository-refresh is dispatched').to.not.be.null;
      expect(captured.event!.detail.repoPath).to.equal('/test/repo');
    });

    it('emits no refresh and no success toast when the switch fails', async () => {
      setupStores({ profiles: [defaultProfile, personalProfile] });
      mockInvoke = async (command: string) => {
        if (command === 'apply_unified_profile') {
          throw new Error('git config is locked');
        }
        return null;
      };

      const el = await renderDashboard();
      uiStore.setState({ toasts: [] });
      const captured = captureRefresh(el);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSelectProfile(personalProfile);
      await el.updateComplete;

      expect(captured.event, 'no refresh for a failed apply').to.be.null;
      expect(
        uiStore.getState().toasts.filter((t) => t.type === 'success'),
        'no success toast for a failed apply'
      ).to.have.lengthOf(0);
      const errorToasts = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errorToasts.length, 'the failure is still surfaced').to.be.greaterThan(0);
      expect(errorToasts[0].message).to.include('Failed to switch profile');
    });
  });

  // ── Assignment-source badge sync after a profile switch ───────────────────
  describe('profile switch assignment badge', () => {
    it("shows 'Manually assigned' on the profile card after switching profile from the dropdown", async () => {
      const personal = makeProfile({ id: 'profile-2', name: 'Personal' });
      setupStores({
        profiles: [defaultProfile, personal],
        repositoryAssignments: {},
      });
      mockInvoke = async () => null;

      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      // Before the switch: no assignment, no URL pattern, not the default
      // profile — the card renders the fallback badge.
      const card = el.shadowRoot!.querySelector('gn-profile-card') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await card.updateComplete;
      expect(card.shadowRoot!.querySelectorAll('.assignment-source.fallback')).to.have.lengthOf(1);

      // Switch profile via the real dropdown.
      const selectorBtn = el.shadowRoot!.querySelector(
        '.profile-selector-btn'
      ) as HTMLButtonElement;
      selectorBtn.click();
      await el.updateComplete;
      const items = Array.from(
        el.shadowRoot!.querySelectorAll('.dropdown-item')
      ) as HTMLButtonElement[];
      const personalItem = items.find((i) => i.textContent?.includes('Personal'));
      expect(personalItem, 'the Personal entry is in the dropdown').to.not.be.undefined;
      personalItem!.click();
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
      await card.updateComplete;

      // applyUnifiedProfile mirrors the backend's repo→profile assignment into
      // the store, so the badge flips to 'Manually assigned' right away.
      expect(card.shadowRoot!.querySelectorAll('.assignment-source.fallback')).to.have.lengthOf(0);
      const badge = card.shadowRoot!.querySelector('.assignment-source');
      expect(badge, 'assignment-source badge is rendered').to.not.be.null;
      expect(badge!.textContent!.trim()).to.equal('Manually assigned');
    });
  });

  // ── Default-account precedence (Wave 1, item 6) ────────────────────────────
  describe('default account precedence badge', () => {
    it('marks the active account as Global default when it is account.isDefault but not a profile preference', async () => {
      const globalDefaultAccount = makeAccount({ id: 'account-1', isDefault: true });
      setupStores({
        accounts: [globalDefaultAccount],
        // No defaultAccounts preference on the active profile.
        profile: makeProfile({ defaultAccounts: {} }),
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      expect(card, 'integration card rendered').to.not.be.null;
      const badge = card!.shadowRoot!.querySelector('.default-badge');
      expect(badge, 'a default badge is shown').to.not.be.null;
      expect(badge!.textContent!.trim()).to.equal('Global default');
      expect(badge!.classList.contains('global')).to.be.true;
    });

    it('marks the active account as Profile default when the profile prefers it', async () => {
      const account = makeAccount({ id: 'account-1', isDefault: true });
      setupStores({
        accounts: [account],
        // Profile explicitly prefers this account — takes precedence over global.
        profile: makeProfile({ defaultAccounts: { github: 'account-1' } }),
      });
      const el = await renderDashboard();
      const expandBtn = el.shadowRoot!.querySelector('.expand-btn') as HTMLButtonElement;
      expandBtn.click();
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('gn-integration-card');
      const badge = card!.shadowRoot!.querySelector('.default-badge');
      expect(badge!.textContent!.trim()).to.equal('Profile default');
      expect(badge!.classList.contains('global')).to.be.false;
    });
  });
});
