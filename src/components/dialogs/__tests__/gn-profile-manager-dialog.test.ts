/**
 * Profile Manager Dialog Tests
 *
 * These render the REAL gn-profile-manager-dialog component, mock only the
 * Tauri invoke layer and stores, and verify the actual component code calls
 * the right commands and renders the correct UI.
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
import { PROFILE_COLORS } from '../../../types/unified-profile.types.ts';

// Import the actual component — registers <gn-profile-manager-dialog> custom element
import '../gn-profile-manager-dialog.ts';
import type { GnProfileManagerDialog } from '../gn-profile-manager-dialog.ts';

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
    color: PROFILE_COLORS[0],
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

const workProfile = makeProfile();
const personalProfile = makeProfile({
  id: 'profile-2',
  name: 'Personal',
  gitName: 'John Personal',
  gitEmail: 'john@personal.com',
  isDefault: true,
  color: PROFILE_COLORS[1],
  urlPatterns: ['github.com/personal/*'],
  defaultAccounts: { gitlab: 'account-2' },
});

const githubAccount = makeAccount();
const gitlabAccount = makeAccount({
  id: 'account-2',
  name: 'Personal GitLab',
  integrationType: 'gitlab',
  config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
  isDefault: true,
  cachedUser: { username: 'johndoe', displayName: 'John', avatarUrl: null, email: 'john@personal.com' },
});

const testProfiles: UnifiedProfile[] = [workProfile, personalProfile];
const testAccounts: IntegrationAccount[] = [githubAccount, gitlabAccount];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_unified_profiles_config':
        return {
          version: 3,
          profiles: testProfiles,
          accounts: testAccounts,
          repositoryAssignments: { '/repo/work': 'profile-1' },
        };
      case 'get_migration_backup_info':
        return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
      case 'save_unified_profile':
        return { profile: testProfiles[0], failedRepositories: [] };
      case 'delete_unified_profile':
        return null;
      case 'save_global_account':
        return testAccounts[0];
      case 'delete_global_account':
        return null;
      case 'apply_unified_profile':
        return null;
      // plugin-dialog 2.7 routes confirm() through `message` and returns the
      // clicked button label; 'Ok' means the user confirmed.
      case 'plugin:dialog|message':
        return 'Ok';
      default:
        return null;
    }
  };
}

function setupStoreState(): void {
  const store = unifiedProfileStore.getState();
  store.setConfig({
    version: 3,
    profiles: testProfiles,
    accounts: testAccounts,
    repositoryAssignments: { '/repo/work': 'profile-1' },
  });
  store.setLoading(false);

  // Set up repository store with recent repos
  const repoStore = repositoryStore.getState();
  repoStore.addRecentRepository('/repo/work', 'work');
  repoStore.addRecentRepository('/repo/personal', 'personal');
}

// Override both the Tauri mock and the store so a custom config survives the
// component's initial loadProfiles() call (which reloads via get_unified_profiles_config).
function useConfig(profiles: UnifiedProfile[], accounts: IntegrationAccount[]): void {
  mockInvoke = async (command: string, args?: unknown) => {
    switch (command) {
      case 'get_unified_profiles_config':
        return { version: 3, profiles, accounts, repositoryAssignments: {} };
      case 'get_migration_backup_info':
        return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
      case 'save_unified_profile':
        // Echo back the submitted profile so the store reflects what was saved.
        return {
          profile: (args as { profile?: UnifiedProfile } | undefined)?.profile ?? profiles[0] ?? null,
          failedRepositories: [],
        };
      case 'delete_global_account':
        return null;
      case 'plugin:dialog|message':
        return 'Ok';
      default:
        return null;
    }
  };
  unifiedProfileStore.getState().setConfig({ version: 3, profiles, accounts, repositoryAssignments: {} });
}

async function renderDialog(props: { open?: boolean; repoPath?: string } = {}): Promise<GnProfileManagerDialog> {
  const { open = true, repoPath = '/test/repo' } = props;
  const el = await fixture<GnProfileManagerDialog>(
    html`<gn-profile-manager-dialog .open=${open} .repoPath=${repoPath}></gn-profile-manager-dialog>`
  );
  await el.updateComplete;
  // Allow async loadProfiles to settle
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-profile-manager-dialog', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
    setupStoreState();
  });

  afterEach(() => {
    // Reset store state
    unifiedProfileStore.getState().reset();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders nothing when open is false', async () => {
      const el = await renderDialog({ open: false });
      const overlay = el.shadowRoot!.querySelector('.dialog-overlay');
      expect(overlay).to.be.null;
    });

    it('renders the dialog overlay and dialog when open', async () => {
      const el = await renderDialog();
      const overlay = el.shadowRoot!.querySelector('.dialog-overlay');
      expect(overlay).to.not.be.null;
      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.not.be.null;
    });

    it('displays "Profiles" as the default dialog title', async () => {
      const el = await renderDialog();
      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('Profiles');
    });

    it('renders the profile list with all profiles', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      expect(profileItems.length).to.equal(2);
    });

    it('displays profile name, git identity, and color in the list', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');

      // First profile: Work
      const firstItem = profileItems[0];
      const name = firstItem.querySelector('.profile-name');
      expect(name!.textContent).to.include('Work');

      const email = firstItem.querySelector('.profile-email');
      expect(email!.textContent).to.include('John Doe');
      expect(email!.textContent).to.include('john@work.com');

      const colorDot = firstItem.querySelector('.profile-color') as HTMLElement;
      expect(colorDot).to.not.be.null;
    });

    it('shows the "Default" badge on the default profile', async () => {
      const el = await renderDialog();
      const badges = el.shadowRoot!.querySelectorAll('.default-badge');
      expect(badges.length).to.equal(1);
      // Personal profile is the default
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      const personalItem = profileItems[1];
      const badge = personalItem.querySelector('.default-badge');
      expect(badge).to.not.be.null;
      expect(badge!.textContent).to.include('Default');
    });

    it('shows URL pattern count in profile meta when patterns exist', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      // Personal profile has 1 URL pattern
      const personalItem = profileItems[1];
      const meta = personalItem.querySelector('.profile-meta');
      expect(meta!.textContent).to.include('1 pattern');
    });

    it('shows "New Profile" button in footer on list view', async () => {
      const el = await renderDialog();
      const buttons = el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary');
      const newProfileBtn = Array.from(buttons).find(
        (btn) => btn.textContent?.trim().includes('New Profile')
      );
      expect(newProfileBtn).to.not.be.undefined;
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────
  describe('empty state', () => {
    it('shows empty state when no profiles exist', async () => {
      // Override mock to return empty config so loadProfiles populates empty state
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          default:
            return null;
        }
      };
      unifiedProfileStore.getState().setConfig({
        version: 3,
        profiles: [],
        accounts: [],
        repositoryAssignments: {},
      });

      const el = await renderDialog();
      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
      expect(emptyState!.textContent).to.include('No profiles yet');
    });
  });

  // ── Create profile ─────────────────────────────────────────────────────
  describe('create profile', () => {
    it('switches to create view when "New Profile" is clicked', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;

      newProfileBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('New Profile');
    });

    it('shows form fields for profile name, git name, git email, signing key, URL patterns', async () => {
      const el = await renderDialog();
      // Navigate to create view
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const inputs = el.shadowRoot!.querySelectorAll('.form-group input, .form-group textarea');
      // Profile Name, Git Name, Git Email, Signing Key, URL Patterns (textarea)
      expect(inputs.length).to.be.greaterThanOrEqual(4);

      // Check for labels
      const labels = el.shadowRoot!.querySelectorAll('.form-group label');
      const labelTexts = Array.from(labels).map((l) => l.textContent?.trim());
      expect(labelTexts).to.include('Profile Name');
      expect(labelTexts).to.include('Git Name');
      expect(labelTexts).to.include('Git Email');
    });

    it('shows "Save Profile" and "Cancel" buttons in create mode', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const footerButtons = el.shadowRoot!.querySelectorAll('.dialog-footer .btn');
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent?.trim());
      expect(buttonTexts.some((t) => t?.includes('Save Profile'))).to.be.true;
      expect(buttonTexts.some((t) => t?.includes('Cancel'))).to.be.true;
    });

    it('calls save_unified_profile with form data when Save is clicked', async () => {
      // Make save return a success
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile': {
            const typedArgs = args as { profile: UnifiedProfile };
            return { profile: typedArgs.profile, failedRepositories: [] };
          }
          default:
            return null;
        }
      };

      const el = await renderDialog();
      // Navigate to create
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      // Fill in form
      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      // Profile name input
      const nameInput = inputs[0];
      nameInput.value = 'Test Profile';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Git name input
      const gitNameInput = inputs[1];
      gitNameInput.value = 'Test User';
      gitNameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Git email input
      const gitEmailInput = inputs[2];
      gitEmailInput.value = 'test@example.com';
      gitEmailInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      // Click Save Profile
      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(1);
      const savedProfile = (saveCalls[0].args as { profile: UnifiedProfile }).profile;
      expect(savedProfile.name).to.equal('Test Profile');
      expect(savedProfile.gitName).to.equal('Test User');
      expect(savedProfile.gitEmail).to.equal('test@example.com');
    });
  });

  // ── Edit profile ───────────────────────────────────────────────────────
  describe('edit profile', () => {
    it('switches to edit view when a profile is clicked', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Edit Profile');
    });

    it('populates the form with the selected profile data', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      // Profile name
      expect(inputs[0].value).to.equal('Work');
      // Git name
      expect(inputs[1].value).to.equal('John Doe');
      // Git email
      expect(inputs[2].value).to.equal('john@work.com');
    });

    it('shows back button in edit view that navigates to list', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const backBtn = el.shadowRoot!.querySelector('.back-btn') as HTMLButtonElement;
      expect(backBtn).to.not.be.null;

      backBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Profiles');
    });

    it('calls save_unified_profile when Save is clicked in edit mode', async () => {
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile': {
            const typedArgs = args as { profile: UnifiedProfile };
            return { profile: typedArgs.profile, failedRepositories: [] };
          }
          default:
            return null;
        }
      };

      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      // Edit the name
      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      inputs[0].value = 'Work Updated';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(1);
      const savedProfile = (saveCalls[0].args as { profile: UnifiedProfile }).profile;
      expect(savedProfile.name).to.equal('Work Updated');
      expect(savedProfile.id).to.equal('profile-1');
    });
  });

  // ── Delete profile ─────────────────────────────────────────────────────
  describe('delete profile', () => {
    it('renders a delete button for each profile in the list', async () => {
      const el = await renderDialog();
      const deleteButtons = el.shadowRoot!.querySelectorAll('.action-btn.delete');
      expect(deleteButtons.length).to.equal(2);
    });

    it('calls delete_unified_profile when delete is confirmed', async () => {
      const el = await renderDialog();
      const deleteButtons = el.shadowRoot!.querySelectorAll('.action-btn.delete');

      clearHistory();
      (deleteButtons[0] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const deleteCalls = findCommands('delete_unified_profile');
      expect(deleteCalls.length).to.equal(1);
      expect((deleteCalls[0].args as { profileId: string }).profileId).to.equal('profile-1');
    });

    it('does NOT call delete_unified_profile when delete is cancelled', async () => {
      // Override mock to reject confirmation
      const defaultMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') return 'Cancel';
        return defaultMock(command, args);
      };

      const el = await renderDialog();
      const deleteButtons = el.shadowRoot!.querySelectorAll('.action-btn.delete');

      clearHistory();
      (deleteButtons[0] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const deleteCalls = findCommands('delete_unified_profile');
      expect(deleteCalls.length).to.equal(0);
    });
  });

  // ── Form validation ────────────────────────────────────────────────────
  describe('form validation', () => {
    it('does not call save_unified_profile when profile name is empty', async () => {
      const el = await renderDialog();
      // Navigate to create
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      // Fill only git fields but not profile name
      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      inputs[1].value = 'Some User';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = 'user@test.com';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(0);
    });

    it('does not call save_unified_profile when git name is empty', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      // Set profile name only
      inputs[0].value = 'My Profile';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      // Leave git name empty, set email
      inputs[2].value = 'user@test.com';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(findCommands('save_unified_profile').length).to.equal(0);
    });

    it('does not call save_unified_profile when git email is empty', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      inputs[0].value = 'My Profile';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = 'Some User';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      // Leave email empty
      await el.updateComplete;

      clearHistory();

      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(findCommands('save_unified_profile').length).to.equal(0);
    });
  });

  // ── Color selection ────────────────────────────────────────────────────
  describe('color selection', () => {
    it('renders color options in the create/edit form', async () => {
      const el = await renderDialog();
      // Navigate to create
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const colorOptions = el.shadowRoot!.querySelectorAll('.color-option');
      expect(colorOptions.length).to.equal(PROFILE_COLORS.length);
    });

    it('marks the first color as selected by default for new profile', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const selectedColor = el.shadowRoot!.querySelector('.color-option.selected') as HTMLElement;
      expect(selectedColor).to.not.be.null;
      // The first color option in the picker should be the selected one
      const allColors = el.shadowRoot!.querySelectorAll('.color-option');
      expect(selectedColor).to.equal(allColors[0]);
    });

    it('updates selected color when a color option is clicked', async () => {
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile': {
            const typedArgs = args as { profile: UnifiedProfile };
            return { profile: typedArgs.profile, failedRepositories: [] };
          }
          default:
            return null;
        }
      };

      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      // Click the third color
      const colorOptions = el.shadowRoot!.querySelectorAll('.color-option');
      (colorOptions[2] as HTMLElement).click();
      await el.updateComplete;

      const selectedColor = el.shadowRoot!.querySelector('.color-option.selected') as HTMLElement;
      expect(selectedColor).to.not.be.null;
      // Third color option should now be the selected one
      expect(selectedColor).to.equal(colorOptions[2]);
    });
  });

  // ── URL patterns ───────────────────────────────────────────────────────
  describe('URL patterns', () => {
    it('renders a textarea for URL patterns', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.form-group textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
    });

    it('populates URL patterns textarea when editing a profile with patterns', async () => {
      const el = await renderDialog();
      // Click on Personal profile which has URL patterns
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.form-group textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
      expect(textarea.value).to.include('github.com/personal/*');
    });

    it('saves URL patterns correctly from textarea input', async () => {
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile': {
            const typedArgs = args as { profile: UnifiedProfile };
            return { profile: typedArgs.profile, failedRepositories: [] };
          }
          default:
            return null;
        }
      };

      const el = await renderDialog();
      // Click to edit Work profile
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.form-group textarea') as HTMLTextAreaElement;
      textarea.value = 'github.com/work/*\ngitlab.com/company/*';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(1);
      const savedProfile = (saveCalls[0].args as { profile: UnifiedProfile }).profile;
      expect(savedProfile.urlPatterns).to.deep.equal(['github.com/work/*', 'gitlab.com/company/*']);
    });
  });

  // ── Account list in profile form ──────────────────────────────────────
  describe('accounts section', () => {
    it('shows integration accounts section in edit/create view', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const sectionTitles = el.shadowRoot!.querySelectorAll('.form-section-title');
      const accountsTitle = Array.from(sectionTitles).find(
        (t) => t.textContent?.includes('Integration Accounts')
      );
      expect(accountsTitle).to.not.be.undefined;
    });

    it('lists only the accounts attached to the profile', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      // Personal profile has defaultAccounts { gitlab: 'account-2' } → one attached account
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      const accountItems = accountsSection!.querySelectorAll('.account-item');
      expect(accountItems.length).to.equal(1);
      expect(accountItems[0].textContent).to.include('Personal GitLab');
    });

    it('shows the attached account name and type badge', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      const accountNames = accountsSection!.querySelectorAll('.account-name');
      const nameTexts = Array.from(accountNames).map((n) => n.textContent?.trim());
      expect(nameTexts.some((t) => t?.includes('Personal GitLab'))).to.be.true;
      // Work GitHub is NOT attached to the Personal profile
      expect(nameTexts.some((t) => t?.includes('Work GitHub'))).to.be.false;

      const typeBadges = accountsSection!.querySelectorAll('.type-badge');
      expect(typeBadges.length).to.equal(1);
    });

    it('shows empty state when no accounts are attached to the profile', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      // Work profile has empty defaultAccounts
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      const empty = accountsSection!.querySelector('.empty-accounts');
      expect(empty).to.not.be.null;
      expect(empty!.textContent).to.include('No accounts attached to this profile');
      expect(accountsSection!.querySelectorAll('.account-item').length).to.equal(0);
    });

    it('ignores dangling account ids whose global account no longer exists', async () => {
      const danglingProfile = makeProfile({
        id: 'profile-dangling',
        name: 'Dangling',
        defaultAccounts: { github: 'does-not-exist' },
      });
      useConfig([danglingProfile], testAccounts);

      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      expect(accountsSection!.querySelectorAll('.account-item').length).to.equal(0);
      expect(accountsSection!.querySelector('.empty-accounts')).to.not.be.null;
    });
  });

  // ── Attaching/detaching accounts ───────────────────────────────────────
  describe('attaching and detaching accounts', () => {
    function getAddButton(el: GnProfileManagerDialog): HTMLButtonElement {
      const section = el.shadowRoot!.querySelector('.accounts-section')!;
      return Array.from(section.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Add'
      ) as HTMLButtonElement;
    }

    it('opens the account picker when Add is clicked', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Attach Account');
      // Picker lists the existing global accounts as selectable rows
      const selectable = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      expect(selectable.length).to.equal(2);
    });

    it('attaches a selected account and returns to the form without a Tauri call', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click(); // Work profile, no attached accounts
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;

      clearHistory();
      // Click the Work GitHub row
      const rows = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      const githubRow = Array.from(rows).find((r) => r.textContent?.includes('Work GitHub'));
      (githubRow as HTMLElement).click();
      await el.updateComplete;

      // Back on the edit form with the account now attached
      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Edit Profile');
      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      const accountItems = accountsSection!.querySelectorAll('.account-item');
      expect(accountItems.length).to.equal(1);
      expect(accountItems[0].textContent).to.include('Work GitHub');

      // Attach is local-only until Save - no association command should fire
      expect(findCommands('set_profile_default_account').length).to.equal(0);
    });

    it('replaces the existing account of the same provider when attaching another', async () => {
      const ghA = makeAccount({ id: 'gh-a', name: 'GitHub A', integrationType: 'github' });
      const ghB = makeAccount({ id: 'gh-b', name: 'GitHub B', integrationType: 'github' });
      const profile = makeProfile({ id: 'p', name: 'P', defaultAccounts: { github: 'gh-a' } });
      useConfig([profile], [ghA, ghB]);

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;

      const rows = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      const rowB = Array.from(rows).find((r) => r.textContent?.includes('GitHub B'));
      (rowB as HTMLElement).click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      const accountItems = accountsSection!.querySelectorAll('.account-item');
      // Still one github slot, now showing GitHub B
      expect(accountItems.length).to.equal(1);
      expect(accountItems[0].textContent).to.include('GitHub B');
      expect(accountItems[0].textContent).to.not.include('GitHub A');
    });

    it('detaches an account without deleting it globally', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[1] as HTMLElement).click(); // Personal, one attached account
      await el.updateComplete;

      clearHistory();
      const detachBtn = el.shadowRoot!.querySelector(
        '.accounts-section .account-actions .action-btn.delete'
      ) as HTMLButtonElement;
      detachBtn.click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      expect(accountsSection!.querySelectorAll('.account-item').length).to.equal(0);
      expect(accountsSection!.querySelector('.empty-accounts')).to.not.be.null;

      // Detach is local-only - no global delete and no association command
      expect(findCommands('delete_global_account').length).to.equal(0);
      expect(findCommands('remove_profile_default_account').length).to.equal(0);
    });

    it('persists an attached account on Save Profile', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click(); // Work
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;
      const rows = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      const githubRow = Array.from(rows).find((r) => r.textContent?.includes('Work GitHub'));
      (githubRow as HTMLElement).click();
      await el.updateComplete;

      clearHistory();
      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((b) => b.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(1);
      const saved = (saveCalls[0].args as { profile: UnifiedProfile }).profile;
      expect(saved.defaultAccounts.github).to.equal('account-1');
    });

    it('persists an attached account when creating a new profile', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((b) => b.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const inputs = el.shadowRoot!.querySelectorAll(
        '.form-group input'
      ) as NodeListOf<HTMLInputElement>;
      inputs[0].value = 'Created';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = 'Created User';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = 'created@test.com';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;
      const rows = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      const githubRow = Array.from(rows).find((r) => r.textContent?.includes('Work GitHub'));
      (githubRow as HTMLElement).click();
      await el.updateComplete;

      clearHistory();
      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((b) => b.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const saveCalls = findCommands('save_unified_profile');
      expect(saveCalls.length).to.equal(1);
      const saved = (saveCalls[0].args as { profile: UnifiedProfile }).profile;
      expect(saved.id).to.be.a('string').and.not.be.empty;
      expect(saved.defaultAccounts.github).to.equal('account-1');
    });

    it('shows connect-new buttons in the picker and dispatches open-github', async () => {
      useConfig(testProfiles, []);

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;

      // No global accounts → no selectable rows, but connect-new buttons present
      expect(el.shadowRoot!.querySelectorAll('.account-item.selectable').length).to.equal(0);
      const githubBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'GitHub'
      ) as HTMLButtonElement;
      expect(githubBtn).to.not.be.undefined;

      let dispatched = false;
      el.addEventListener('open-github', () => {
        dispatched = true;
      });
      githubBtn.click();
      await el.updateComplete;
      expect(dispatched).to.be.true;

      // The picker view is preserved (the host hides/reopens the dialog), so the
      // user returns here to select the newly connected account.
      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Attach Account');
    });

    it('preserves the picker visually while demoted behind a stacked dialog', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      getAddButton(el).click();
      await el.updateComplete;

      // Demote behind a stacked dialog (e.g. an integration dialog). `demoted` is
      // now PURELY a visual signal (render-behind) — it no longer triggers any
      // reveal/attach side effects; that is driven explicitly by revealAfterConnect.
      el.demoted = true;
      await el.updateComplete;
      expect(el.hasAttribute('demoted')).to.be.true;
      // Still mounted and on the picker (state preserved)
      expect(el.shadowRoot!.querySelector('.dialog-overlay')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Attach Account');

      el.demoted = false;
      await el.updateComplete;
      expect(el.hasAttribute('demoted')).to.be.false;
      // No accidental reveal/attach from un-demoting alone.
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Attach Account');
    });

    it('refreshes the account list when the host calls revealAfterConnect', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      getAddButton(el).click();
      await el.updateComplete;

      // The host explicitly reveals us after a non-attaching connect (e.g. opened
      // from the standalone Accounts view). The list is reloaded; nothing attaches.
      clearHistory();
      await el.revealAfterConnect({
        returnTo: 'profile-manager',
        integrationType: 'github',
        profileId: 'p1',
        profileName: 'P1',
        attach: false,
      });
      await el.updateComplete;
      expect(findCommands('get_unified_profiles_config').length).to.be.greaterThan(0);
    });

    // Every provider's connect button must carry the same explicit attach
    // context — not just GitHub. The button label is INTEGRATION_TYPE_NAMES[type]
    // and the event is `open-${type}`.
    const providerCases: Array<{ type: string; label: string }> = [
      { type: 'github', label: 'GitHub' },
      { type: 'gitlab', label: 'GitLab' },
      { type: 'bitbucket', label: 'Bitbucket' },
      { type: 'azure-devops', label: 'Azure DevOps' },
      { type: 'oidc', label: 'Enterprise SSO (OIDC)' },
    ];

    providerCases.forEach(({ type, label }) => {
      it(`emits an explicit return-target context with attach intent from the picker (${type})`, async () => {
        const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: {} });
        useConfig([profile], []);
        const el = await renderDialog();
        (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
        await el.updateComplete;
        getAddButton(el).click();
        await el.updateComplete;

        let detail: unknown = null;
        el.addEventListener(`open-${type}`, (e) => {
          detail = (e as CustomEvent).detail;
        });
        const providerBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === label
        ) as HTMLButtonElement;
        expect(providerBtn, `connect button for ${type}`).to.not.be.undefined;
        providerBtn.click();
        await el.updateComplete;

        // Connecting from the attach picker carries an explicit context: return to
        // the profile manager, target this profile, WITH attach intent.
        expect(detail).to.deep.equal({
          returnTo: 'profile-manager',
          integrationType: type,
          profileId: 'p1',
          profileName: 'P1',
          attach: true,
        });
      });
    });

    it('auto-attaches a newly connected account on return from the integration dialog', async () => {
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: {} });
      useConfig([profile], []); // no global accounts yet

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      getAddButton(el).click();
      await el.updateComplete;

      // Click the "Connect a new account → GitHub" button — snapshots the
      // pre-connect accounts and dispatches the explicit open context.
      const githubBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'GitHub'
      ) as HTMLButtonElement;
      githubBtn.click();
      await el.updateComplete;

      // Integration dialog opens (demoted); user connects a new account
      el.demoted = true;
      await el.updateComplete;
      const newGh = makeAccount({ id: 'gh-new', name: 'New GH', integrationType: 'github' });
      useConfig([profile], [newGh]);

      // The host EXPLICITLY reveals and attaches via the captured context (the
      // attach intent + target profile travel with the context — no guessing).
      el.demoted = false;
      await el.revealAfterConnect({
        returnTo: 'profile-manager',
        integrationType: 'github',
        profileId: 'p1',
        profileName: 'P1',
        attach: true,
      });
      await el.updateComplete;

      // Back on the edit form with the connected account attached
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Edit Profile');
      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      expect(accountsSection!.querySelectorAll('.account-item').length).to.equal(1);
      expect(accountsSection!.textContent).to.include('New GH');
    });

    it('shows a "Save Profile to keep <account>" hint after attach-on-connect and emphasizes Save', async () => {
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: {} });
      useConfig([profile], []);

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      getAddButton(el).click();
      await el.updateComplete;

      const githubBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'GitHub'
      ) as HTMLButtonElement;
      githubBtn.click();
      await el.updateComplete;

      el.demoted = true;
      await el.updateComplete;
      const newGh = makeAccount({ id: 'gh-new', name: 'New GH', integrationType: 'github' });
      useConfig([profile], [newGh]);

      el.demoted = false;
      await el.revealAfterConnect({
        returnTo: 'profile-manager',
        integrationType: 'github',
        profileId: 'p1',
        profileName: 'P1',
        attach: true,
      });
      await el.updateComplete;

      // Inline hint near Save reduces the surprise of a Cancel dropping the attach.
      const hint = el.shadowRoot!.querySelector('[data-testid="attach-keep-hint"]');
      expect(hint, 'attach-keep hint visible').to.not.be.null;
      expect(hint!.textContent).to.include('New GH');

      // Save button is visually emphasized while the hint is showing.
      const saveBtn = Array.from(el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')).find(
        (b) => b.textContent?.trim().includes('Save Profile')
      ) as HTMLButtonElement;
      expect(saveBtn).to.not.be.undefined;
      expect(saveBtn.classList.contains('btn-emphasized')).to.be.true;
    });

    it('does NOT auto-attach an existing account when the user backs out of re-connecting', async () => {
      const gh = makeAccount({
        id: 'gh1',
        name: 'Existing GH',
        integrationType: 'github',
        isDefault: true,
      });
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: {} });
      useConfig([profile], [gh]);

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      getAddButton(el).click();
      await el.updateComplete;

      // Open the connect flow for GitHub, then back out without connecting a
      // new account (same accounts as before).
      const githubBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'GitHub'
      ) as HTMLButtonElement;
      githubBtn.click();
      await el.updateComplete;

      el.demoted = true;
      await el.updateComplete;
      // No new account was connected — backing out must be a no-op (no auto-fill).
      el.demoted = false;
      await el.revealAfterConnect({
        returnTo: 'profile-manager',
        integrationType: 'github',
        profileId: 'p1',
        profileName: 'P1',
        attach: true,
      });
      await el.updateComplete;

      // The existing account is NOT auto-attached: we stay on the attach view and
      // the profile draft gains no account.
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Attach Account');
      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      expect(accountsSection).to.be.null;
    });

    it('deletes a global account from the account edit screen', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[1] as HTMLElement).click(); // Personal
      await el.updateComplete;

      // Open the attached account's edit screen
      const editBtn = el.shadowRoot!.querySelector(
        '.accounts-section .account-actions .action-btn:not(.delete)'
      ) as HTMLButtonElement;
      editBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Edit Account');

      clearHistory();
      const deleteBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-danger')
      ).find((b) => b.textContent?.trim().includes('Delete Account')) as HTMLButtonElement;
      expect(deleteBtn).to.not.be.undefined;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(findCommands('delete_global_account').length).to.equal(1);
    });

    it('discards an attach when the picker is dismissed with Back', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click(); // Work, no accounts
      await el.updateComplete;

      getAddButton(el).click();
      await el.updateComplete;

      // Leave the picker without selecting anything
      const backBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-secondary')
      ).find((b) => b.textContent?.trim() === 'Back') as HTMLButtonElement;
      backBtn.click();
      await el.updateComplete;

      const accountsSection = el.shadowRoot!.querySelector('.accounts-section');
      expect(accountsSection!.querySelectorAll('.account-item').length).to.equal(0);
    });

    it('discards a detach when the form is cancelled without saving', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[1] as HTMLElement).click(); // Personal
      await el.updateComplete;

      // Detach the attached account locally
      (
        el.shadowRoot!.querySelector(
          '.accounts-section .account-actions .action-btn.delete'
        ) as HTMLButtonElement
      ).click();
      await el.updateComplete;
      expect(
        el.shadowRoot!.querySelector('.accounts-section')!.querySelectorAll('.account-item').length
      ).to.equal(0);

      clearHistory();
      // Cancel the form (returns to list) - nothing should persist
      const cancelBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-secondary')
      ).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement;
      cancelBtn.click();
      await el.updateComplete;
      expect(findCommands('save_unified_profile').length).to.equal(0);

      // Re-open the profile - the account is still attached (the store was untouched)
      (el.shadowRoot!.querySelectorAll('.profile-item')[1] as HTMLElement).click();
      await el.updateComplete;
      expect(
        el.shadowRoot!.querySelector('.accounts-section')!.querySelectorAll('.account-item').length
      ).to.equal(1);
    });
  });

  // ── Connection status indicator ────────────────────────────────────────
  describe('connection status', () => {
    it('refreshes the status dot to connected when opened', async () => {
      const gh = makeAccount({ id: 'gh1', name: 'GH', integrationType: 'github' });
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: { github: 'gh1' } });

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [profile], accounts: [gh], repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'get_keyring_token':
            return 'tok-123';
          case 'check_github_connection':
            return { connected: true, user: { login: 'me', name: 'Me', avatarUrl: null, email: null } };
          case 'update_global_account_cached_user':
            return null;
          default:
            return null;
        }
      };
      unifiedProfileStore.getState().setConfig({
        version: 3,
        profiles: [profile],
        accounts: [gh],
        repositoryAssignments: {},
      });

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      // The status check runs in the background; wait for it to resolve
      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const indicator = el.shadowRoot!.querySelector('.accounts-section .status-indicator');
      expect(indicator).to.not.be.null;
      expect(indicator!.classList.contains('connected')).to.be.true;
    });

    it('marks the account disconnected when it has no token', async () => {
      const gh = makeAccount({ id: 'gh1', name: 'GH', integrationType: 'github' });
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: { github: 'gh1' } });

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [profile], accounts: [gh], repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'get_keyring_token':
            return null; // no token → disconnected
          default:
            return null;
        }
      };
      unifiedProfileStore.getState().setConfig({
        version: 3,
        profiles: [profile],
        accounts: [gh],
        repositoryAssignments: {},
      });

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const indicator = el.shadowRoot!.querySelector('.accounts-section .status-indicator');
      expect(indicator!.classList.contains('disconnected')).to.be.true;
    });

    it('does not override the status set by the integration dialog on reveal', async () => {
      const gh = makeAccount({ id: 'gh1', name: 'GH', integrationType: 'github' });
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: { github: 'gh1' } });
      useConfig([profile], [gh]); // no token in this mock → fresh-open check = disconnected

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      // Let the fresh-open status check settle (it resolves to disconnected here)
      await new Promise((r) => setTimeout(r, 60));
      await el.updateComplete;

      // Simulate the integration dialog reporting a verified connection
      unifiedProfileStore.getState().setAccountConnectionStatus('gh1', 'connected');
      await el.updateComplete;

      // Demote (integration dialog opens on top) then reveal (it closes)
      el.demoted = true;
      await el.updateComplete;
      el.demoted = false;
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 60));
      await el.updateComplete;

      // Reveal must NOT re-check and clobber the dialog's status
      expect(unifiedProfileStore.getState().accountConnectionStatus['gh1']?.status).to.equal(
        'connected'
      );
      const indicator = el.shadowRoot!.querySelector('.accounts-section .status-indicator');
      expect(indicator!.classList.contains('connected')).to.be.true;
    });
  });

  // ── Default account per integration type ───────────────────────────────
  describe('default account per integration type', () => {
    it('shows "Default" badge on the attached default account', async () => {
      const el = await renderDialog();
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      // Personal profile has the gitlab account (isDefault: true) attached
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const defaultBadges = el.shadowRoot!.querySelectorAll('.account-item .default-badge');
      expect(defaultBadges.length).to.be.greaterThanOrEqual(1);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    it('handles save failure gracefully without crashing', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile':
            throw new Error('Save failed!');
          default:
            return null;
        }
      };

      const el = await renderDialog();
      // Navigate to create
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      // Fill required fields
      const inputs = el.shadowRoot!.querySelectorAll('.form-group input') as NodeListOf<HTMLInputElement>;
      inputs[0].value = 'Error Profile';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = 'Error User';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = 'error@test.com';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Click save - should not throw
      const saveBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('Save Profile')) as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Component should still be rendered and not crashed
      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.not.be.null;
    });

    it('handles delete failure gracefully', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'delete_unified_profile':
            throw new Error('Delete failed!');
          case 'plugin:dialog|message':
            return 'Ok';
          default:
            return null;
        }
      };

      const el = await renderDialog();
      const deleteButtons = el.shadowRoot!.querySelectorAll('.action-btn.delete');
      (deleteButtons[0] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Component should still be rendered
      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.not.be.null;
    });

    it('handles global account delete failure gracefully', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'delete_global_account':
            throw new Error('Account removal failed!');
          case 'plugin:dialog|message':
            return 'Ok';
          default:
            return null;
        }
      };

      const el = await renderDialog();
      // Edit the Personal profile (has an attached account) and open its edit screen
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const editBtn = el.shadowRoot!.querySelector(
        '.accounts-section .account-actions .action-btn:not(.delete)'
      ) as HTMLButtonElement;
      editBtn.click();
      await el.updateComplete;

      // Click the destructive global delete and confirm
      const deleteBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-danger')
      ).find((b) => b.textContent?.trim().includes('Delete Account')) as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Component should still be rendered despite the failure
      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.not.be.null;
    });
  });

  // ── Dialog open/close behavior ─────────────────────────────────────────
  describe('dialog open/close behavior', () => {
    it('dispatches "close" event when close button is clicked', async () => {
      const el = await renderDialog();

      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      expect(closeFired).to.be.true;
    });

    it('dispatches "close" event when clicking the overlay background', async () => {
      const el = await renderDialog();

      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });

      const overlay = el.shadowRoot!.querySelector('.dialog-overlay') as HTMLElement;
      // Click on the overlay itself (not the dialog within it)
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      expect(closeFired).to.be.true;
    });

    it('loads profiles when dialog is opened', async () => {
      clearHistory();
      await renderDialog({ open: true });

      const loadCalls = findCommands('get_unified_profiles_config');
      expect(loadCalls.length).to.be.greaterThan(0);
    });

    it('resets to list view and clears editing state on close', async () => {
      const el = await renderDialog();
      // Navigate to edit
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[0] as HTMLElement).click();
      await el.updateComplete;

      let title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Edit Profile');

      // Close and re-open
      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      el.open = true;
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Profiles');
    });
  });

  // ── Duplicate profile ──────────────────────────────────────────────────
  describe('duplicate profile', () => {
    it('shows duplicate button for each profile', async () => {
      const el = await renderDialog();
      // There are action buttons for each profile; duplicate is the copy icon button
      // (not .delete class)
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      for (const item of Array.from(profileItems)) {
        const actionBtns = item.querySelectorAll('.action-btn:not(.delete)');
        // Should have at least a duplicate button (possibly also apply)
        expect(actionBtns.length).to.be.greaterThanOrEqual(1);
      }
    });
  });

  // ── Apply profile ──────────────────────────────────────────────────────
  describe('apply profile', () => {
    it('shows apply button when repoPath is set', async () => {
      const el = await renderDialog({ repoPath: '/test/repo' });
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      // Each item should have an apply button (checkmark icon)
      for (const item of Array.from(profileItems)) {
        const applyBtn = Array.from(item.querySelectorAll('.action-btn')).find(
          (btn) => btn.getAttribute('title') === 'Apply to current repository'
        );
        expect(applyBtn).to.not.be.undefined;
      }
    });

    it('calls apply_unified_profile when apply button is clicked', async () => {
      const el = await renderDialog({ repoPath: '/test/repo' });

      clearHistory();

      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      const firstItem = profileItems[0];
      const applyBtn = Array.from(firstItem.querySelectorAll('.action-btn')).find(
        (btn) => btn.getAttribute('title') === 'Apply to current repository'
      ) as HTMLButtonElement;
      applyBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const applyCalls = findCommands('apply_unified_profile');
      expect(applyCalls.length).to.equal(1);
      expect((applyCalls[0].args as { path: string; profileId: string }).path).to.equal('/test/repo');
      expect((applyCalls[0].args as { path: string; profileId: string }).profileId).to.equal('profile-1');
    });

    it('dispatches repository-refresh after a successful apply', async () => {
      const el = await renderDialog({ repoPath: '/test/repo' });

      let refreshed = false;
      const listener = () => { refreshed = true; };
      window.addEventListener('repository-refresh', listener);

      try {
        const firstItem = el.shadowRoot!.querySelectorAll('.profile-item')[0];
        const applyBtn = Array.from(firstItem.querySelectorAll('.action-btn')).find(
          (btn) => btn.getAttribute('title') === 'Apply to current repository'
        ) as HTMLButtonElement;
        applyBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        // Without the refresh event the displayed git identity would be stale
        // until the tab is re-switched.
        expect(refreshed).to.be.true;
      } finally {
        window.removeEventListener('repository-refresh', listener);
      }
    });
  });

  // ── Default checkbox ───────────────────────────────────────────────────
  describe('default profile checkbox', () => {
    it('renders isDefault checkbox in create/edit form', async () => {
      const el = await renderDialog();
      const newProfileBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-primary')
      ).find((btn) => btn.textContent?.trim().includes('New Profile')) as HTMLButtonElement;
      newProfileBtn.click();
      await el.updateComplete;

      const checkbox = el.shadowRoot!.querySelector('.checkbox-row input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).to.not.be.null;

      const label = el.shadowRoot!.querySelector('.checkbox-row label');
      expect(label!.textContent).to.include('Set as default profile');
    });

    it('sets isDefault checkbox when editing a default profile', async () => {
      const el = await renderDialog();
      // Click Personal profile which is default
      const profileItems = el.shadowRoot!.querySelectorAll('.profile-item');
      (profileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const checkbox = el.shadowRoot!.querySelector('.checkbox-row input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).to.be.true;
    });
  });

  // ── Standalone Accounts view (Manage Accounts) ─────────────────────────────
  describe('accounts manager view', () => {
    function getAccountsButton(el: GnProfileManagerDialog): HTMLButtonElement {
      return Array.from(
        el.shadowRoot!.querySelectorAll('.dialog-footer .btn-secondary')
      ).find((b) => b.textContent?.trim() === 'Accounts') as HTMLButtonElement;
    }

    it('opens the accounts view from the list footer "Accounts" button', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent!.trim()).to.equal('Accounts');
      // Lists every global account (both test accounts) with edit/delete actions
      const rows = el.shadowRoot!.querySelectorAll('.accounts-list .account-item');
      expect(rows.length).to.equal(2);
      const editBtns = el.shadowRoot!.querySelectorAll('.account-actions .action-btn:not(.delete)');
      const deleteBtns = el.shadowRoot!.querySelectorAll('.account-actions .action-btn.delete');
      expect(editBtns.length).to.equal(2);
      expect(deleteBtns.length).to.equal(2);
    });

    it('lands on the accounts view when opened with initialView="accounts"', async () => {
      const el = await fixture<GnProfileManagerDialog>(
        html`<gn-profile-manager-dialog
          .open=${true}
          .repoPath=${'/test/repo'}
          .initialView=${'accounts'}
        ></gn-profile-manager-dialog>`
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent!.trim()).to.equal('Accounts');
    });

    it('showAccountsView() lands an already-open (demoted) manager on the accounts view', async () => {
      // Reproduces "Manage Accounts" clicked from a provider dialog that was
      // itself launched FROM the manager: the manager is already open & demoted,
      // so `open` never transitions false->true and willUpdate's view logic
      // doesn't run. The host drives the accounts view explicitly instead.
      const el = await renderDialog();
      // Manager is sitting on a non-list sub-view (e.g. it was on select-account
      // / edit when the provider dialog was launched on top of it).
      const elState = el as unknown as { viewMode: string; demoted: boolean };
      elState.viewMode = 'edit-account';
      elState.demoted = true;
      await el.updateComplete;

      // Host calls the public method (what app-shell.handleManageAccounts does).
      (el as unknown as { showAccountsView: () => void }).showAccountsView();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(elState.viewMode).to.equal('accounts');
      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent!.trim()).to.equal('Accounts');

      // Accounts is the entry view for this session, so Back must CLOSE the
      // manager (returning to the provider dialog that opened it) — not fall
      // through to the profile list. This requires showAccountsView() to have
      // set initialView itself, not rely on the host's property binding.
      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });
      const backBtn = el.shadowRoot!.querySelector('.back-btn') as HTMLButtonElement;
      backBtn.click();
      await el.updateComplete;
      expect(closeFired, 'Back from showAccountsView-driven Accounts closes the manager').to.be.true;
    });

    it('offers connect-new buttons for every provider in the accounts view', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      const labels = Array.from(
        el.shadowRoot!.querySelectorAll('.form-section .btn.btn-sm')
      ).map((b) => b.textContent?.trim());
      expect(labels).to.include('GitHub');
      expect(labels).to.include('GitLab');
      expect(labels).to.include('Bitbucket');
      expect(labels).to.include('Azure DevOps');
      expect(labels).to.include('Enterprise SSO (OIDC)');
    });

    it('dispatches open-oidc when the Enterprise SSO connect button is clicked', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      let opened = false;
      el.addEventListener('open-oidc', () => { opened = true; });
      const oidcBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.form-section .btn.btn-sm')
      ).find((b) => b.textContent?.trim() === 'Enterprise SSO (OIDC)') as HTMLButtonElement;
      oidcBtn.click();
      await el.updateComplete;

      expect(opened).to.be.true;
    });

    it('dispatches open-<provider> when a connect button is clicked from the accounts view', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      let opened = false;
      el.addEventListener('open-github', () => { opened = true; });
      const githubBtn = Array.from(
        el.shadowRoot!.querySelectorAll('.form-section .btn.btn-sm')
      ).find((b) => b.textContent?.trim() === 'GitHub') as HTMLButtonElement;
      githubBtn.click();
      await el.updateComplete;

      expect(opened).to.be.true;
    });

    it('edits an account from the accounts view and returns to it on Back', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      const editBtn = el.shadowRoot!.querySelector(
        '.account-actions .action-btn:not(.delete)'
      ) as HTMLButtonElement;
      editBtn.click();
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Edit Account');

      const backBtn = el.shadowRoot!.querySelector('.back-btn') as HTMLButtonElement;
      backBtn.click();
      await el.updateComplete;
      // Returns to the accounts view, not the profile list
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent!.trim()).to.equal('Accounts');
    });

    it('deletes a global account from the accounts view and stays in the view', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      clearHistory();
      const deleteBtn = el.shadowRoot!.querySelector(
        '.account-actions .action-btn.delete'
      ) as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(findCommands('delete_global_account').length).to.equal(1);
      // Still on the accounts view after deleting
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent!.trim()).to.equal('Accounts');
    });

    it('also deletes the keyring token (record first, then token) when deleting a global account', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      clearHistory();
      const deleteBtn = el.shadowRoot!.querySelector(
        '.account-actions .action-btn.delete'
      ) as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const deleteRecordIdx = invokeHistory.findIndex((h) => h.command === 'delete_global_account');
      const deleteTokenIdx = invokeHistory.findIndex((h) => h.command === 'delete_keyring_token');
      expect(deleteRecordIdx, 'account record deletion happened').to.be.greaterThan(-1);
      expect(deleteTokenIdx, 'keyring token deletion happened').to.be.greaterThan(-1);
      // Record is the source of truth — it must be deleted before the token.
      expect(deleteRecordIdx).to.be.lessThan(deleteTokenIdx);
      // The token deletion targets the deleted account's keyring key.
      const tokenCall = invokeHistory[deleteTokenIdx];
      expect((tokenCall.args as Record<string, string>).key).to.include('account-1');
    });

    it('still reports success when keyring token deletion fails (record already removed)', async () => {
      const el = await renderDialog();
      getAccountsButton(el).click();
      await el.updateComplete;

      // The account record deletes fine, but the keyring is unavailable. The
      // record is the source of truth and is already gone, so the user must NOT
      // see "Failed to delete account" — token cleanup is best-effort.
      const prev = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'delete_keyring_token') {
          throw new Error('keyring unavailable');
        }
        return prev(command, args);
      };

      clearHistory();
      uiStore.getState().toasts.length = 0;
      const deleteBtn = el.shadowRoot!.querySelector(
        '.account-actions .action-btn.delete'
      ) as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Record deletion still happened.
      expect(findCommands('delete_global_account').length).to.equal(1);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /deleted/i.test(t.message)), 'success toast').to.be.true;
      expect(toasts.some((t) => t.type === 'error'), 'no failure toast').to.be.false;
    });
  });

  // ── Replacing a same-provider account (#5) ─────────────────────────────────
  describe('same-provider account replacement', () => {
    it('shows an info toast and replaces when attaching a second account of the same provider', async () => {
      const gh1 = makeAccount({ id: 'gh1', name: 'GH One', integrationType: 'github' });
      const gh2 = makeAccount({ id: 'gh2', name: 'GH Two', integrationType: 'github' });
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: { github: 'gh1' } });
      useConfig([profile], [gh1, gh2]);

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      // Open the picker and choose the OTHER github account
      const addBtn = Array.from(
        el.shadowRoot!.querySelector('.accounts-section')!.querySelectorAll('button')
      ).find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      const rows = el.shadowRoot!.querySelectorAll('.account-item.selectable');
      const gh2Row = Array.from(rows).find((r) => r.textContent?.includes('GH Two'));
      (gh2Row as HTMLElement).click();
      await el.updateComplete;

      // Toast surfaced about the replacement
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.message.includes('Replaced'))).to.be.true;

      // The profile form now shows the replacement account, not the original
      const attached = el.shadowRoot!.querySelector('.accounts-section .accounts-list .account-name');
      expect(attached!.textContent).to.include('GH Two');
    });
  });

  // ── Unsaved-changes guard on dismissal (#6) ────────────────────────────────
  describe('unsaved-changes guard', () => {
    it('prompts to confirm when closing the dialog with unsaved profile edits', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      // Make the form dirty
      const nameInput = el.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      nameInput.value = 'Changed';
      nameInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      clearHistory();
      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // A confirm dialog was shown, and (mock answers 'Ok') the dialog closed
      expect(findCommands('plugin:dialog|message').length).to.equal(1);
      expect(closeFired).to.be.true;
    });

    it('does not prompt when closing without unsaved edits', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      clearHistory();
      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      expect(findCommands('plugin:dialog|message').length).to.equal(0);
      expect(closeFired).to.be.true;
    });
  });

  // ── Explicit reveal-after-connect (no intent-guessing) ─────────────────────
  describe('reveal after connect (explicit context)', () => {
    it('does NOT auto-attach when revealed with no attach intent (standalone)', async () => {
      const profile = makeProfile({ id: 'p1', name: 'P1', defaultAccounts: {} });
      useConfig([profile], []);
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;
      (Array.from(
        el.shadowRoot!.querySelector('.accounts-section')!.querySelectorAll('button')
      ).find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement).click();
      await el.updateComplete;

      // A brand-new account materialises while the (standalone) connect dialog is up.
      const newGh = makeAccount({ id: 'gh-new', name: 'New GH', integrationType: 'github' });
      useConfig([profile], [newGh]);

      // Reveal with attach:false — the manager must NOT attach the account; it
      // stays on the picker view and only refreshes the list.
      await el.revealAfterConnect({
        returnTo: 'profile-manager',
        integrationType: 'github',
        profileId: 'p1',
        profileName: 'P1',
        attach: false,
      });
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.dialog-title')!.textContent).to.include('Attach Account');
    });

    it('clears the pre-connect snapshot when the dialog is closed', async () => {
      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      const addBtn = Array.from(
        el.shadowRoot!.querySelector('.accounts-section')!.querySelectorAll('button')
      ).find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      const githubConnect = Array.from(
        el.shadowRoot!.querySelectorAll('.form-section .btn.btn-sm')
      ).find((b) => b.textContent?.trim() === 'GitHub') as HTMLButtonElement;
      githubConnect.click();
      await el.updateComplete;

      const withPrivate = el as unknown as { accountIdsBeforeConnect: Set<string> };
      // Closing the dialog drops the snapshot so it can't influence a later reveal.
      (el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement).click();
      await el.updateComplete;
      expect(withPrivate.accountIdsBeforeConnect.size).to.equal(0);
    });
  });

  // D4: restore-backup must dispatch `migration-needed` BEFORE closing so the
  // parent can swap dialogs without a close-then-reopen flicker.
  describe('restore backup ordering (D4)', () => {
    it('dispatches migration-needed before the dialog closes', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: true, backupDate: '2026-01-01', profilesCount: 2, accountsCount: 2 };
          case 'restore_migration_backup':
            return { hasBackup: true, backupDate: '2026-01-01', profilesCount: 2, accountsCount: 2 };
          case 'needs_unified_profiles_migration':
            return true;
          case 'plugin:dialog|message':
            return 'Ok';
          default:
            return null;
        }
      };

      const el = await renderDialog();

      const order: string[] = [];
      el.addEventListener('migration-needed', () => order.push('migration-needed'));
      el.addEventListener('close', () => order.push('close'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleRestoreBackup();
      await el.updateComplete;

      expect(order).to.deep.equal(['migration-needed', 'close']);
      // Dialog actually closed.
      expect((el as unknown as { open: boolean }).open).to.be.false;
    });
  });

  // D11: bulk-assign partial failure must keep the FAILED repos selected (so the
  // user can retry) and name them in the feedback.
  describe('bulk assign partial failure (D11)', () => {
    it('keeps failed repos selected and names them in the toast', async () => {
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'assign_unified_profile_to_repository': {
            const path = (args as { path?: string } | undefined)?.path;
            // Fail only for the "personal" repo.
            if (path === '/repo/personal') throw new Error('locked');
            return null;
          }
          default:
            return null;
        }
      };

      const el = await renderDialog();
      uiStore.getState().toasts.length = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingProfile = makeProfile({ id: 'profile-1' });
      shell.selectedReposForAssignment = new Set(['/repo/work', '/repo/personal']);
      shell.viewMode = 'assign-repos';

      await shell.handleBulkAssign();
      await el.updateComplete;

      // Failed repo stays selected; succeeded repo is dropped.
      const remaining = shell.selectedReposForAssignment as Set<string>;
      expect(Array.from(remaining)).to.deep.equal(['/repo/personal']);

      // Feedback names the failed repo, not just a count.
      const toasts = uiStore.getState().toasts;
      const warn = toasts.find((t) => t.type === 'warning');
      expect(warn, 'a warning toast was shown').to.not.be.undefined;
      expect(warn!.message).to.match(/failed 1/);
      expect(warn!.message).to.match(/personal/);
    });

    it('clears the selection and leaves the view on full success', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments: {} };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'assign_unified_profile_to_repository':
            return null;
          default:
            return null;
        }
      };

      const el = await renderDialog();
      uiStore.getState().toasts.length = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingProfile = makeProfile({ id: 'profile-1' });
      shell.selectedReposForAssignment = new Set(['/repo/work', '/repo/personal']);
      shell.viewMode = 'assign-repos';

      await shell.handleBulkAssign();
      await el.updateComplete;

      expect((shell.selectedReposForAssignment as Set<string>).size).to.equal(0);
      expect(shell.viewMode).to.equal('edit');
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success')).to.be.true;
    });
  });

  // Saving a profile re-applies its identity to every repository assigned to it
  // (the backend rewrites their .git/config). The dialog must report the ones
  // that kept the old identity, and refresh the open repo when it was rewritten.
  describe('save re-applies the identity to assigned repositories', () => {
    function mocksWithSaveResult(
      failedRepositories: string[],
      repositoryAssignments: Record<string, string>
    ): void {
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return { version: 3, profiles: testProfiles, accounts: testAccounts, repositoryAssignments };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'save_unified_profile':
            return {
              profile: (args as { profile: UnifiedProfile }).profile,
              failedRepositories,
            };
          default:
            return null;
        }
      };
    }

    it('names the repositories that kept the old identity', async () => {
      mocksWithSaveResult(['/repo/personal'], { '/repo/personal': 'profile-1' });

      const el = await renderDialog();
      uiStore.getState().toasts.length = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingProfile = makeProfile({ id: 'profile-1', gitEmail: 'new@work.com' });
      shell.viewMode = 'edit';
      await shell.handleSave();
      await el.updateComplete;

      const toasts = uiStore.getState().toasts;
      const warn = toasts.find((t) => t.type === 'warning');
      expect(warn, 'a warning toast was shown').to.not.be.undefined;
      expect(warn!.message).to.match(/personal/);
      expect(toasts.some((t) => t.type === 'success')).to.be.false;
    });

    it('refreshes the open repository when the saved profile is the one assigned to it', async () => {
      mocksWithSaveResult([], { '/repo/work': 'profile-1' });

      const el = await renderDialog({ repoPath: '/repo/work' });
      let refreshed = false;
      const onRefresh = (): void => {
        refreshed = true;
      };
      window.addEventListener('repository-refresh', onRefresh);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shell = el as any;
        shell.editingProfile = makeProfile({ id: 'profile-1', gitEmail: 'new@work.com' });
        shell.viewMode = 'edit';
        await shell.handleSave();
        await el.updateComplete;
      } finally {
        window.removeEventListener('repository-refresh', onRefresh);
      }

      expect(refreshed, 'repository-refresh was dispatched').to.be.true;
    });

    it('does not refresh when the open repository is assigned to a different profile', async () => {
      mocksWithSaveResult([], { '/repo/work': 'profile-2' });

      const el = await renderDialog({ repoPath: '/repo/work' });
      uiStore.getState().toasts.length = 0;
      let refreshed = false;
      const onRefresh = (): void => {
        refreshed = true;
      };
      window.addEventListener('repository-refresh', onRefresh);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shell = el as any;
        shell.editingProfile = makeProfile({ id: 'profile-1', gitEmail: 'new@work.com' });
        shell.viewMode = 'edit';
        await shell.handleSave();
        await el.updateComplete;
      } finally {
        window.removeEventListener('repository-refresh', onRefresh);
      }

      expect(refreshed, 'no refresh for an unrelated profile').to.be.false;
      expect(uiStore.getState().toasts.some((t) => t.type === 'success')).to.be.true;
    });

    it('shows the plain success toast when every assigned repository was updated', async () => {
      mocksWithSaveResult([], { '/repo/personal': 'profile-1' });

      const el = await renderDialog();
      uiStore.getState().toasts.length = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingProfile = makeProfile({ id: 'profile-1', gitEmail: 'new@work.com' });
      shell.viewMode = 'edit';
      await shell.handleSave();
      await el.updateComplete;

      const toasts = uiStore.getState().toasts;
      expect(toasts.filter((t) => t.type === 'success').map((t) => t.message)).to.deep.equal([
        'Profile saved',
      ]);
      expect(toasts.some((t) => t.type === 'warning')).to.be.false;
    });
  });

  // ── Account config fields in the edit-account view (Wave 1, item 1) ────────
  describe('account config fields', () => {
    it('renders the GitLab instance URL field when editing a GitLab account', async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = { ...gitlabAccount };
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.form-group label')).map(
        (l) => l.textContent?.trim()
      );
      expect(labels.some((l) => l?.includes('GitLab Instance URL'))).to.be.true;

      // The field is pre-filled from the account's existing config.
      const urlInput = el.shadowRoot!.querySelector(
        'input[type="url"]'
      ) as HTMLInputElement;
      expect(urlInput).to.not.be.null;
      expect(urlInput.value).to.equal('https://gitlab.com');
    });

    it('persists an edited GitLab instanceUrl on save', async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = { ...gitlabAccount };
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector(
        'input[type="url"]'
      ) as HTMLInputElement;
      urlInput.value = 'https://gitlab.mycompany.com';
      urlInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      clearHistory();
      await shell.handleSaveAccount();
      await el.updateComplete;

      const saves = findCommands('save_global_account');
      expect(saves.length).to.equal(1);
      const saved = (saves[0].args as { account?: IntegrationAccount }).account!;
      expect(saved.config).to.deep.include({
        type: 'gitlab',
        instanceUrl: 'https://gitlab.mycompany.com',
      });
    });

    it('renders the Azure DevOps organization field when editing an Azure account', async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = makeAccount({
        id: 'acc-azure',
        name: 'Work Azure',
        integrationType: 'azure-devops',
        config: { type: 'azure-devops', organization: 'myorg' },
      });
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.form-group label')).map(
        (l) => l.textContent?.trim()
      );
      expect(labels.some((l) => l === 'Organization')).to.be.true;
    });
  });

  // ── Account URL patterns ─────────────────────────────────────────
  describe('account URL patterns', () => {
    it('renders a URL patterns textarea in the account edit form', async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = { ...githubAccount };
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.form-group label')).map((l) =>
        l.textContent?.trim()
      );
      expect(labels.some((l) => l === 'URL Patterns (one per line)')).to.be.true;

      // There should be a textarea in the account form.
      const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
    });

    it("round-trips an existing account's url patterns into the textarea", async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = makeAccount({
        id: 'acc-patterns',
        name: 'Work GitHub',
        urlPatterns: ['github.com/work-org/*', 'github.com/another-org/*'],
      });
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
      expect(textarea.value).to.equal('github.com/work-org/*\ngithub.com/another-org/*');
    });

    it('persists edited url patterns in save_global_account', async () => {
      const el = await renderDialog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      shell.editingAccount = { ...githubAccount, urlPatterns: [] };
      shell.viewMode = 'edit-account';
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = 'github.com/work-org/*\n  github.com/team/*  \n';
      textarea.dispatchEvent(new Event('input'));
      await el.updateComplete;

      clearHistory();
      await shell.handleSaveAccount();
      await el.updateComplete;

      const saves = findCommands('save_global_account');
      expect(saves.length).to.equal(1);
      const saved = (saves[0].args as { account?: IntegrationAccount }).account!;
      // Trimmed and blank-filtered, one pattern per line.
      expect(saved.urlPatterns).to.deep.equal(['github.com/work-org/*', 'github.com/team/*']);
    });
  });

  // ── Delete-confirm copy (Wave 1, item 3) ───────────────────────────────────
  describe('delete profile confirmation copy', () => {
    it('explains accounts remain global and does NOT claim they are removed', async () => {
      let confirmMessage = '';
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return {
              version: 3,
              profiles: testProfiles,
              accounts: testAccounts,
              repositoryAssignments: {},
            };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'plugin:dialog|message':
            confirmMessage = (args as { message?: string } | undefined)?.message ?? '';
            return 'Ok';
          case 'delete_unified_profile':
            return null;
          default:
            return null;
        }
      };

      const el = await renderDialog();
      const deleteBtn = el.shadowRoot!.querySelector(
        '.profile-item .action-btn.delete'
      ) as HTMLButtonElement;
      expect(deleteBtn).to.not.be.null;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(confirmMessage).to.include('repository assignments');
      expect(confirmMessage).to.include('remain available globally');
      expect(confirmMessage).to.not.include('remove all associated integration accounts');
      expect(findCommands('delete_unified_profile').length).to.equal(1);
    });
  });

  // ── Single-repo unassign (Wave 1, item 4) ──────────────────────────────────
  describe('unassign a single repository', () => {
    it('shows an unassign button per assigned repo and unassigns on click', async () => {
      let unassignedPath: string | undefined;
      mockInvoke = async (command: string, args?: unknown) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return {
              version: 3,
              profiles: testProfiles,
              accounts: testAccounts,
              repositoryAssignments: { '/repo/work': 'profile-1' },
            };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'unassign_unified_profile_from_repository':
            unassignedPath = (args as { path?: string } | undefined)?.path;
            return null;
          default:
            return null;
        }
      };

      const el = await renderDialog();
      // Edit the Work profile (it has /repo/work assigned).
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      // The assigned-repositories list shows the one assigned repo with an unassign button.
      const unassignBtn = el.shadowRoot!.querySelector(
        '.accounts-section .account-item .action-btn.delete'
      ) as HTMLButtonElement;
      expect(unassignBtn, 'an unassign button is rendered for the assigned repo').to.not.be.null;
      expect(unassignBtn.getAttribute('title')).to.include('Unassign');

      uiStore.getState().toasts.length = 0;
      clearHistory();
      unassignBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(findCommands('unassign_unified_profile_from_repository').length).to.equal(1);
      expect(unassignedPath).to.equal('/repo/work');

      // User-visible feedback on success.
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success')).to.be.true;
    });

    it('surfaces an error toast when unassign fails', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_unified_profiles_config':
            return {
              version: 3,
              profiles: testProfiles,
              accounts: testAccounts,
              repositoryAssignments: { '/repo/work': 'profile-1' },
            };
          case 'get_migration_backup_info':
            return { hasBackup: false, backupDate: null, profilesCount: null, accountsCount: null };
          case 'unassign_unified_profile_from_repository':
            throw new Error('locked');
          default:
            return null;
        }
      };

      const el = await renderDialog();
      (el.shadowRoot!.querySelectorAll('.profile-item')[0] as HTMLElement).click();
      await el.updateComplete;

      uiStore.getState().toasts.length = 0;
      const unassignBtn = el.shadowRoot!.querySelector(
        '.accounts-section .account-item .action-btn.delete'
      ) as HTMLButtonElement;
      unassignBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.true;
    });
  });
});
