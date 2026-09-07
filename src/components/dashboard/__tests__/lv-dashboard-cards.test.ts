/**
 * Tests for dashboard card components:
 * - lv-profile-card
 * - lv-repository-card
 * - lv-integration-card
 *
 * Renders REAL components, mocking only the Tauri invoke layer,
 * and verifies DOM output and interactions.
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
import type { UnifiedProfile, IntegrationAccount, ProfileAssignmentSource } from '../../../types/unified-profile.types.ts';
import type { Repository, Branch, Remote } from '../../../types/git.types.ts';
import type { ConnectionStatus } from '../../../stores/unified-profile.store.ts';
import type { LvProfileCard } from '../lv-profile-card.ts';
import type { LvRepositoryCard } from '../lv-repository-card.ts';
import type { LvIntegrationCard } from '../lv-integration-card.ts';

// Import actual components — registers custom elements
import '../lv-profile-card.ts';
import '../lv-repository-card.ts';
import '../lv-integration-card.ts';

// ── Test data factories ────────────────────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

// ── Profile Card Tests ─────────────────────────────────────────────────────
describe('lv-profile-card', () => {
  beforeEach(() => {
    clearHistory();
    mockInvoke = async () => null;
  });

  describe('with profile', () => {
    it('renders profile name', async () => {
      const profile = makeProfile({ name: 'Personal' });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const nameEl = el.shadowRoot!.querySelector('.profile-name');
      expect(nameEl).to.not.be.null;
      expect(nameEl!.textContent).to.include('Personal');
    });

    it('renders git name and email', async () => {
      const profile = makeProfile({ gitName: 'Jane Smith', gitEmail: 'jane@example.com' });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const identityValues = el.shadowRoot!.querySelectorAll('.identity-value');
      const values = Array.from(identityValues).map((v) => v.textContent?.trim());
      expect(values).to.include('Jane Smith');
      expect(values).to.include('jane@example.com');
    });

    it('renders profile color dot', async () => {
      const profile = makeProfile({ color: '#ef4444' });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const dot = el.shadowRoot!.querySelector('.profile-dot') as HTMLElement;
      expect(dot).to.not.be.null;
      // Browser may convert hex to rgb
      const bg = dot.style.background;
      expect(bg === '#ef4444' || bg.includes('rgb(239, 68, 68)')).to.be.true;
    });

    it('renders card accent bar with profile color', async () => {
      const profile = makeProfile({ color: '#10b981' });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const accent = el.shadowRoot!.querySelector('.card-accent') as HTMLElement;
      expect(accent).to.not.be.null;
      // Browser may convert hex to rgb
      const bg = accent.style.background;
      expect(bg === '#10b981' || bg.includes('rgb(16, 185, 129)')).to.be.true;
    });

    it('shows "Default" badge when profile is default', async () => {
      const profile = makeProfile({ isDefault: true });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const badge = el.shadowRoot!.querySelector('.default-badge');
      expect(badge).to.not.be.null;
      expect(badge!.textContent).to.include('Default');
    });

    it('does NOT show "Default" badge when profile is not default', async () => {
      const profile = makeProfile({ isDefault: false });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const badge = el.shadowRoot!.querySelector('.default-badge');
      expect(badge).to.be.null;
    });

    it('shows "GPG Configured" when signing key exists', async () => {
      const profile = makeProfile({ signingKey: 'ABCD1234' });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const signingKey = el.shadowRoot!.querySelector('.signing-key.configured');
      expect(signingKey).to.not.be.null;
      expect(signingKey!.textContent).to.include('Configured');
    });

    it('shows "Not configured" when no signing key', async () => {
      const profile = makeProfile({ signingKey: null });
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      const signingKey = el.shadowRoot!.querySelector('.signing-key.not-configured');
      expect(signingKey).to.not.be.null;
      expect(signingKey!.textContent).to.include('Not configured');
    });

    it('renders manual assignment source label', async () => {
      const profile = makeProfile();
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile} .assignmentSource=${'manual' as ProfileAssignmentSource}></lv-profile-card>`
      );
      await el.updateComplete;

      const source = el.shadowRoot!.querySelector('.assignment-source');
      expect(source).to.not.be.null;
      expect(source!.textContent).to.include('Manually assigned');
    });

    it('renders url-pattern assignment source label', async () => {
      const profile = makeProfile();
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile} .assignmentSource=${'url-pattern' as ProfileAssignmentSource}></lv-profile-card>`
      );
      await el.updateComplete;

      const source = el.shadowRoot!.querySelector('.assignment-source');
      expect(source).to.not.be.null;
      expect(source!.textContent).to.include('Matched by URL pattern');
    });

    it('renders default assignment source label', async () => {
      const profile = makeProfile();
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile} .assignmentSource=${'default' as ProfileAssignmentSource}></lv-profile-card>`
      );
      await el.updateComplete;

      const source = el.shadowRoot!.querySelector('.assignment-source');
      expect(source).to.not.be.null;
      expect(source!.textContent).to.include('Default profile');
    });

    it('shows fallback label when source is "none" (first-available)', async () => {
      const profile = makeProfile();
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile} .assignmentSource=${'none' as ProfileAssignmentSource}></lv-profile-card>`
      );
      await el.updateComplete;

      const source = el.shadowRoot!.querySelector('.assignment-source.fallback');
      expect(source).to.not.be.null;
      expect(source!.textContent).to.include('no rule matched');
      expect(source!.textContent).to.include('first available');
    });

    it('dispatches edit-profile event when edit button is clicked', async () => {
      const profile = makeProfile();
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${profile}></lv-profile-card>`
      );
      await el.updateComplete;

      let eventFired = false;
      el.addEventListener('edit-profile', () => { eventFired = true; });

      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLButtonElement;
      expect(editBtn).to.not.be.null;
      editBtn.click();
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });
  });

  describe('empty state (no profile)', () => {
    it('renders empty state when profile is null', async () => {
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${null}></lv-profile-card>`
      );
      await el.updateComplete;

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
    });

    it('shows "No Profile Active" title in empty state', async () => {
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${null}></lv-profile-card>`
      );
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.empty-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('No Profile Active');
    });

    it('shows "Set Up Profile" button in empty state', async () => {
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${null}></lv-profile-card>`
      );
      await el.updateComplete;

      const setupBtn = el.shadowRoot!.querySelector('.setup-btn');
      expect(setupBtn).to.not.be.null;
      expect(setupBtn!.textContent).to.include('Set Up Profile');
    });

    it('dispatches edit-profile event from setup button in empty state', async () => {
      const el = await fixture<LvProfileCard>(
        html`<lv-profile-card .profile=${null}></lv-profile-card>`
      );
      await el.updateComplete;

      let eventFired = false;
      el.addEventListener('edit-profile', () => { eventFired = true; });

      const setupBtn = el.shadowRoot!.querySelector('.setup-btn') as HTMLButtonElement;
      setupBtn.click();
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });
  });
});

// ── Repository Card Tests ──────────────────────────────────────────────────
describe('lv-repository-card', () => {
  beforeEach(() => {
    clearHistory();
    mockInvoke = async () => null;
  });

  describe('with repository', () => {
    it('renders repository name', async () => {
      const repo = makeRepository({ name: 'gitnado' });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card .repository=${repo}></lv-repository-card>`
      );
      await el.updateComplete;

      const name = el.shadowRoot!.querySelector('.repo-name');
      expect(name).to.not.be.null;
      expect(name!.textContent).to.include('gitnado');
    });

    it('renders repository path', async () => {
      const repo = makeRepository({ path: '/home/user/repos/my-project' });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card .repository=${repo}></lv-repository-card>`
      );
      await el.updateComplete;

      const path = el.shadowRoot!.querySelector('.repo-path');
      expect(path).to.not.be.null;
      expect(path!.textContent?.trim()).to.include('my-project');
    });

    it('renders current branch name', async () => {
      const repo = makeRepository();
      const branch = makeBranch({ name: 'feature/awesome' });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${branch}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const branchName = el.shadowRoot!.querySelector('.branch-name');
      expect(branchName).to.not.be.null;
      expect(branchName!.textContent).to.include('feature/awesome');
    });

    it('shows a detached HEAD chip when no branch is checked out', async () => {
      const repo = makeRepository({
        headRef: 'HEAD',
        detachedHeadOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${null}
          .remotes=${[makeRemote()]}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const chip = el.shadowRoot!.querySelector('.branch-name.detached');
      expect(chip).to.not.be.null;
      expect(chip!.textContent).to.include('Detached HEAD');
      expect(chip!.textContent).to.include('a1b2c3d');
    });

    it('names the full commit in the detached chip tooltip', async () => {
      const repo = makeRepository({
        headRef: 'HEAD',
        detachedHeadOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${null}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const chip = el.shadowRoot!.querySelector('.branch-name.detached');
      expect(chip).to.not.be.null;
      const title = chip!.getAttribute('title') ?? '';
      expect(title).to.include('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
      expect(title).to.include("won't belong to any branch");
    });

    it('shows the detached chip when the repo has no remotes', async () => {
      const repo = makeRepository({
        headRef: 'HEAD',
        detachedHeadOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${null}
          .remotes=${[]}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.branch-info')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.branch-name.detached')).to.not.be.null;
    });

    it('shows the branch name, not a detached chip, on a normal checkout', async () => {
      const repo = makeRepository({ detachedHeadOid: null });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${makeBranch({ name: 'feature/awesome' })}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.branch-name.detached')).to.be.null;
      expect(el.shadowRoot!.querySelector('.branch-name')!.textContent).to.include(
        'feature/awesome'
      );
    });

    it('shows no detached chip on an unborn HEAD', async () => {
      // A freshly initialised repo has no branch and no detached commit: a null
      // currentBranch alone must not be read as detachment.
      const repo = makeRepository({ headRef: null, detachedHeadOid: null });
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${null}
          .remotes=${[]}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.branch-name.detached')).to.be.null;
      expect(el.shadowRoot!.querySelector('.branch-name')).to.be.null;
    });

    it('renders provider icon for GitHub repo', async () => {
      const repo = makeRepository();
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .detectedProvider=${'github'}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const providerIcon = el.shadowRoot!.querySelector('.provider-icon');
      expect(providerIcon).to.not.be.null;
    });

    it('renders provider icon for GitLab repo', async () => {
      const repo = makeRepository();
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .detectedProvider=${'gitlab'}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const providerIcon = el.shadowRoot!.querySelector('.provider-icon');
      expect(providerIcon).to.not.be.null;
    });

    it('renders remote info for origin', async () => {
      const repo = makeRepository();
      const remotes = [makeRemote({ name: 'origin' })];
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .currentBranch=${makeBranch()}
          .remotes=${remotes}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const remoteInfo = el.shadowRoot!.querySelector('.remote-info');
      expect(remoteInfo).to.not.be.null;
      expect(remoteInfo!.textContent).to.include('origin');
    });

    it('shows assignment info for manual assignment', async () => {
      const repo = makeRepository();
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .assignmentSource=${'manual'}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const assignment = el.shadowRoot!.querySelector('.assignment-info');
      expect(assignment).to.not.be.null;
      expect(assignment!.textContent).to.include('Profile manually assigned');
    });

    it('shows assignment info for url-pattern assignment', async () => {
      const repo = makeRepository();
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .assignmentSource=${'url-pattern'}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const assignment = el.shadowRoot!.querySelector('.assignment-info');
      expect(assignment).to.not.be.null;
      expect(assignment!.textContent).to.include('Profile matched by URL pattern');
    });

    it('hides assignment info when source is "none"', async () => {
      const repo = makeRepository();
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card
          .repository=${repo}
          .assignmentSource=${'none'}
        ></lv-repository-card>`
      );
      await el.updateComplete;

      const assignment = el.shadowRoot!.querySelector('.assignment-info');
      expect(assignment).to.be.null;
    });
  });

  describe('empty state', () => {
    it('renders nothing when repository is null', async () => {
      const el = await fixture<LvRepositoryCard>(
        html`<lv-repository-card .repository=${null}></lv-repository-card>`
      );
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('.card');
      expect(card).to.be.null;
    });
  });
});

// ── Integration Card Tests ─────────────────────────────────────────────────
describe('lv-integration-card', () => {
  beforeEach(() => {
    clearHistory();
    mockInvoke = async () => null;
  });

  describe('with account', () => {
    it('renders account name', async () => {
      const account = makeAccount({ name: 'My GitHub' });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const name = el.shadowRoot!.querySelector('.account-name');
      expect(name).to.not.be.null;
      expect(name!.textContent).to.include('My GitHub');
    });

    it('renders integration icon', async () => {
      const account = makeAccount({ integrationType: 'github' });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const icon = el.shadowRoot!.querySelector('.integration-icon');
      expect(icon).to.not.be.null;
      // The icon should contain an SVG
      const svg = icon!.querySelector('svg');
      expect(svg).to.not.be.null;
    });

    it('shows connected status correctly', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'connected' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('.card');
      expect(card!.classList.contains('connected')).to.be.true;

      const statusText = el.shadowRoot!.querySelector('.status-text');
      expect(statusText).to.not.be.null;
      expect(statusText!.textContent).to.include('Connected');
    });

    it('shows disconnected status correctly', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'disconnected' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('.card');
      expect(card!.classList.contains('disconnected')).to.be.true;

      const statusText = el.shadowRoot!.querySelector('.status-text');
      expect(statusText).to.not.be.null;
      expect(statusText!.textContent).to.include('Disconnected');
    });

    it('shows checking status correctly', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'checking' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('.card');
      expect(card!.classList.contains('checking')).to.be.true;

      const statusText = el.shadowRoot!.querySelector('.status-text');
      expect(statusText).to.not.be.null;
      expect(statusText!.textContent).to.include('Checking...');
    });

    it('shows unknown status correctly', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'unknown' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const statusText = el.shadowRoot!.querySelector('.status-text');
      expect(statusText).to.not.be.null;
      expect(statusText!.textContent).to.include('Unknown');
    });

    it('shows "Profile default" badge when isProfileDefault is true', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .isProfileDefault=${true}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const badge = el.shadowRoot!.querySelector('.default-badge');
      expect(badge).to.not.be.null;
      expect(badge!.textContent!.trim()).to.equal('Profile default');
      // Not the muted global variant.
      expect(badge!.classList.contains('global')).to.be.false;
      expect(badge!.getAttribute('title')).to.include('profile prefers');
    });

    it('shows muted "Global default" badge when only isGlobalDefault is true', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .isProfileDefault=${false}
          .isGlobalDefault=${true}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const badge = el.shadowRoot!.querySelector('.default-badge');
      expect(badge).to.not.be.null;
      expect(badge!.textContent!.trim()).to.equal('Global default');
      expect(badge!.classList.contains('global')).to.be.true;
      expect(badge!.getAttribute('title')).to.include('fallback');
    });

    it('prefers "Profile default" over "Global default" when both are true', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .isProfileDefault=${true}
          .isGlobalDefault=${true}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const badges = el.shadowRoot!.querySelectorAll('.default-badge');
      expect(badges.length).to.equal(1);
      expect(badges[0].textContent!.trim()).to.equal('Profile default');
    });

    it('does NOT show any default badge when neither default flag is set', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .isProfileDefault=${false}
          .isGlobalDefault=${false}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const badge = el.shadowRoot!.querySelector('.default-badge');
      expect(badge).to.be.null;
    });

    it('renders cached user info when available', async () => {
      const account = makeAccount({
        cachedUser: {
          username: 'johndoe',
          displayName: 'John Doe',
          avatarUrl: null,
          email: 'john@example.com',
        },
      });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'connected' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const userName = el.shadowRoot!.querySelector('.user-name');
      expect(userName).to.not.be.null;
      expect(userName!.textContent).to.include('John Doe');

      const userHandle = el.shadowRoot!.querySelector('.user-handle');
      expect(userHandle).to.not.be.null;
      expect(userHandle!.textContent).to.include('@johndoe');
    });

    it('shows avatar placeholder when no avatar URL', async () => {
      const account = makeAccount({
        cachedUser: {
          username: 'johndoe',
          displayName: null,
          avatarUrl: null,
          email: null,
        },
      });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const placeholder = el.shadowRoot!.querySelector('.avatar-placeholder');
      expect(placeholder).to.not.be.null;
    });

    it('shows username as display name when displayName is null', async () => {
      const account = makeAccount({
        cachedUser: {
          username: 'janedoe',
          displayName: null,
          avatarUrl: null,
          email: null,
        },
      });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const userName = el.shadowRoot!.querySelector('.user-name');
      expect(userName).to.not.be.null;
      // displayName || username => 'janedoe'
      expect(userName!.textContent).to.include('janedoe');
    });

    it('shows secondary info for Azure DevOps organization', async () => {
      const account = makeAccount({
        integrationType: 'azure-devops',
        config: { type: 'azure-devops', organization: 'myorg' },
      });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const secondaryInfo = el.shadowRoot!.querySelector('.secondary-info');
      expect(secondaryInfo).to.not.be.null;
      expect(secondaryInfo!.textContent).to.include('org: myorg');
    });

    it('shows secondary info for Bitbucket workspace', async () => {
      const account = makeAccount({
        integrationType: 'bitbucket',
        config: { type: 'bitbucket', workspace: 'my-workspace' },
      });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      const secondaryInfo = el.shadowRoot!.querySelector('.secondary-info');
      expect(secondaryInfo).to.not.be.null;
      expect(secondaryInfo!.textContent).to.include('workspace: my-workspace');
    });

    it('dispatches open-dialog event when configure button is clicked', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      let eventFired = false;
      el.addEventListener('open-dialog', () => { eventFired = true; });

      // The configure action button has title "Configure account"
      const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
      const configureBtn = Array.from(actionBtns).find(
        (btn) => btn.getAttribute('title') === 'Configure account'
      ) as HTMLButtonElement;
      expect(configureBtn).to.not.be.undefined;
      configureBtn.click();
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });

    it('dispatches refresh-account event when refresh button is clicked', async () => {
      const account = makeAccount({ id: 'acc-42' });
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${account}></lv-integration-card>`
      );
      await el.updateComplete;

      let eventDetail: unknown = null;
      el.addEventListener('refresh-account', ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      // The refresh button has title "Refresh connection"
      const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
      const refreshBtn = Array.from(actionBtns).find(
        (btn) => btn.getAttribute('title') === 'Refresh connection'
      ) as HTMLButtonElement;
      expect(refreshBtn).to.not.be.undefined;
      refreshBtn.click();
      await el.updateComplete;

      expect(eventDetail).to.deep.equal({ accountId: 'acc-42' });
    });

    it('disables refresh button when status is checking', async () => {
      const account = makeAccount();
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card
          .account=${account}
          .connectionStatus=${'checking' as ConnectionStatus}
        ></lv-integration-card>`
      );
      await el.updateComplete;

      const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
      const refreshBtn = Array.from(actionBtns).find(
        (btn) => btn.getAttribute('title') === 'Refresh connection'
      ) as HTMLButtonElement;
      expect(refreshBtn).to.not.be.undefined;
      expect(refreshBtn.disabled).to.be.true;
    });
  });

  describe('empty state', () => {
    it('renders nothing when account is null', async () => {
      const el = await fixture<LvIntegrationCard>(
        html`<lv-integration-card .account=${null}></lv-integration-card>`
      );
      await el.updateComplete;

      const card = el.shadowRoot!.querySelector('.card');
      expect(card).to.be.null;
    });
  });
});
