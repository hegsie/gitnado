/**
 * Migration Dialog Tests
 *
 * Tests dialog rendering, view mode transitions (intro -> preview -> migrating -> complete),
 * account assignment, migration execution, error handling, empty state, and open/close behavior.
 */

// -- Tauri mock (must be set before any imports) --
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

// -- Imports (after Tauri mock) --
import { expect, fixture, html } from '@open-wc/testing';
import type { MigrationPreview } from '../../../types/unified-profile.types.ts';

// Import the actual component -- registers <gn-migration-dialog> custom element
import '../gn-migration-dialog.ts';
import type { GnMigrationDialog } from '../gn-migration-dialog.ts';

// -- Test data --

const PREVIEW_WITH_PROFILES: MigrationPreview = {
  profiles: [
    {
      profileId: 'profile-1',
      profileName: 'Work',
      gitEmail: 'dev@work.com',
      matchedAccounts: [
        { accountId: 'acc-1', accountName: 'Work GitHub', integrationType: 'github' },
        { accountId: 'acc-2', accountName: 'Work GitLab', integrationType: 'gitlab' },
      ],
    },
    {
      profileId: 'profile-2',
      profileName: 'Personal',
      gitEmail: 'me@personal.com',
      matchedAccounts: [],
    },
  ],
  unmatchedAccounts: [
    {
      accountId: 'acc-3',
      accountName: 'Side Project GitHub',
      integrationType: 'github',
      suggestedProfileId: 'profile-2',
    },
  ],
};

const PREVIEW_EMPTY: MigrationPreview = {
  profiles: [],
  unmatchedAccounts: [],
};

const PREVIEW_NO_UNMATCHED: MigrationPreview = {
  profiles: [
    {
      profileId: 'profile-1',
      profileName: 'Work',
      gitEmail: 'dev@work.com',
      matchedAccounts: [
        { accountId: 'acc-1', accountName: 'Work GitHub', integrationType: 'github' },
      ],
    },
  ],
  unmatchedAccounts: [],
};

// A user who only ever configured accounts (never profiles): there are
// unmatched accounts but zero profiles to assign them to.
const PREVIEW_NO_PROFILES_WITH_UNMATCHED: MigrationPreview = {
  profiles: [],
  unmatchedAccounts: [
    {
      accountId: 'acc-9',
      accountName: 'Solo GitHub',
      integrationType: 'github',
      suggestedProfileId: null,
    },
  ],
};

const MIGRATION_SUCCESS = {
  success: true,
  profilesMigrated: 2,
  accountsMigrated: 3,
  unmatchedAccounts: [],
  errors: [],
};

// -- Helpers --

function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

async function renderDialog(open = true): Promise<GnMigrationDialog> {
  const el = await fixture<GnMigrationDialog>(
    html`<gn-migration-dialog ?open=${open}></gn-migration-dialog>`,
  );
  await el.updateComplete;
  return el;
}

async function waitForUpdate(el: GnMigrationDialog, ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await el.updateComplete;
}

function clickButton(el: GnMigrationDialog, text: string): void {
  const buttons = el.shadowRoot!.querySelectorAll('button');
  const btn = Array.from(buttons).find((b) => b.textContent?.trim().includes(text));
  expect(btn, `Button with text "${text}" should exist`).to.not.be.null;
  btn!.click();
}

// -- Tests --

describe('gn-migration-dialog', () => {
  beforeEach(() => {
    clearHistory();
    mockInvoke = async (command: string) => {
      switch (command) {
        case 'preview_unified_profiles_migration':
          return PREVIEW_WITH_PROFILES;
        case 'execute_unified_profiles_migration':
          return MIGRATION_SUCCESS;
        case 'get_unified_profiles_config':
          return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
        case 'plugin:notification|is_permission_granted':
          return false;
        default:
          return null;
      }
    };
  });

  // ======================================================================
  // Rendering
  // ======================================================================

  describe('Rendering', () => {
    it('renders the dialog overlay when open', async () => {
      const el = await renderDialog(true);
      const overlay = el.shadowRoot!.querySelector('.dialog-overlay');
      expect(overlay).to.not.be.null;
    });

    it('does not render when closed', async () => {
      const el = await renderDialog(false);
      const overlay = el.shadowRoot!.querySelector('.dialog-overlay');
      expect(overlay).to.be.null;
    });

    it('renders the intro view by default', async () => {
      const el = await renderDialog(true);

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('Upgrade to Unified Profiles');

      const introContent = el.shadowRoot!.querySelector('.intro-content');
      expect(introContent).to.not.be.null;
    });

    it('shows intro title and description', async () => {
      const el = await renderDialog(true);

      const introTitle = el.shadowRoot!.querySelector('.intro-title');
      expect(introTitle).to.not.be.null;
      expect(introTitle!.textContent).to.include('Unified Profiles Are Here');

      const introDesc = el.shadowRoot!.querySelector('.intro-description');
      expect(introDesc).to.not.be.null;
    });

    it('shows feature list in intro', async () => {
      const el = await renderDialog(true);

      const featureItems = el.shadowRoot!.querySelectorAll('.feature-item');
      expect(featureItems.length).to.equal(3);
    });

    it('shows Skip and Continue buttons in intro footer', async () => {
      const el = await renderDialog(true);

      const buttons = el.shadowRoot!.querySelectorAll('.dialog-footer button');
      const buttonTexts = Array.from(buttons).map((b) => b.textContent?.trim());
      expect(buttonTexts).to.include('Skip for now');
      expect(buttonTexts).to.include('Continue');
    });
  });

  // ======================================================================
  // Workflow steps: State transitions
  // ======================================================================

  describe('Workflow steps', () => {
    it('transitions from intro to preview when Continue is clicked', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Review Migration');
    });

    it('calls preview_unified_profiles_migration when loading preview', async () => {
      const el = await renderDialog(true);
      clearHistory();

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const previewCalls = findCommands('preview_unified_profiles_migration');
      expect(previewCalls.length).to.equal(1);
    });

    it('shows profiles in preview mode', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const profilePreviews = el.shadowRoot!.querySelectorAll('.profile-preview');
      expect(profilePreviews.length).to.equal(2);
    });

    it('shows profile names and emails in preview', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const profileNames = el.shadowRoot!.querySelectorAll('.profile-name');
      expect(profileNames.length).to.equal(2);
      expect(profileNames[0].textContent).to.equal('Work');
      expect(profileNames[1].textContent).to.equal('Personal');

      const profileEmails = el.shadowRoot!.querySelectorAll('.profile-email');
      expect(profileEmails[0].textContent).to.equal('dev@work.com');
    });

    it('shows matched accounts for profiles', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const accountTags = el.shadowRoot!.querySelectorAll('.account-tag');
      expect(accountTags.length).to.equal(2); // Work profile has 2 matched accounts
    });

    it('shows "No accounts matched" for profiles with no accounts', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const noAccounts = el.shadowRoot!.querySelectorAll('.no-accounts');
      expect(noAccounts.length).to.equal(1);
      expect(noAccounts[0].textContent).to.include('No accounts matched');
    });

    it('shows an explanatory note (not empty selects) when there are unmatched accounts but no profiles', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_NO_PROFILES_WITH_UNMATCHED;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);
      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      // The unmatched section still lists the account…
      const unmatchedNames = el.shadowRoot!.querySelectorAll('.unmatched-account-name');
      expect(unmatchedNames.length).to.equal(1);
      expect(unmatchedNames[0].textContent).to.include('Solo GitHub');

      // …but there are NO empty profile <select> dropdowns (the dead-end).
      const selects = el.shadowRoot!.querySelectorAll('.profile-select');
      expect(selects.length).to.equal(0);

      // Instead an explanatory note about shared global accounts is shown.
      const description = el.shadowRoot!.querySelector('.unmatched-section .section-description');
      expect(description).to.not.be.null;
      expect(description!.textContent).to.include('shared global accounts');

      // And the "Open Profile Manager" affordance is offered in this case.
      const buttons = Array.from(el.shadowRoot!.querySelectorAll('.unmatched-section button'));
      const openMgrBtn = buttons.find((b) => b.textContent?.trim() === 'Open Profile Manager');
      expect(openMgrBtn, 'Open Profile Manager button should exist').to.not.be.undefined;
    });

    it('transitions from preview to migrating when Start Migration is clicked', async () => {
      let resolveExecution: ((value: unknown) => void) | null = null;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            return new Promise((resolve) => {
              resolveExecution = resolve;
            });
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 10);

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Migrating');

      // Clean up
      if (resolveExecution) {
        (resolveExecution as (value: unknown) => void)(MIGRATION_SUCCESS);
        await waitForUpdate(el, 100);
      }
    });

    it('transitions to complete after successful migration', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Migration Complete');
    });

    it('shows success content after migration completes', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const completeContent = el.shadowRoot!.querySelector('.complete-content');
      expect(completeContent).to.not.be.null;

      const doneTitle = el.shadowRoot!.querySelector('.intro-title');
      expect(doneTitle!.textContent).to.include('All Done');
    });

    it('shows migration stats after completion', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const statValues = el.shadowRoot!.querySelectorAll('.stat-value');
      expect(statValues.length).to.equal(2);
      expect(statValues[0].textContent).to.equal('2'); // profilesMigrated
      expect(statValues[1].textContent).to.equal('3'); // accountsMigrated
    });
  });

  // ======================================================================
  // Complete view: failure / partial-success path (real success boolean)
  // ======================================================================

  describe('Complete view with errors', () => {
    const MIGRATION_FAILURE = {
      success: false,
      profilesMigrated: 1,
      accountsMigrated: 2,
      unmatchedAccounts: [],
      errors: ['Account "Side Project GitHub" could not be migrated', 'Profile "Old" was skipped'],
    };

    beforeEach(() => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            return MIGRATION_FAILURE;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };
    });

    it('renders a warning icon instead of the success icon on failure', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      expect(el.shadowRoot!.querySelector('.warning-icon')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.success-icon')).to.be.null;
      const title = el.shadowRoot!.querySelector('.intro-title');
      expect(title!.textContent).to.include('Completed With Issues');
    });

    it('renders the count of skipped items and the error list', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const desc = el.shadowRoot!.querySelector('.intro-description');
      expect(desc!.textContent).to.include('2 items');

      const errorItems = el.shadowRoot!.querySelectorAll('.error-item');
      expect(errorItems.length).to.equal(2);
      expect(errorItems[0].textContent).to.include('Side Project GitHub');
      expect(errorItems[1].textContent).to.include('was skipped');
    });

    it('shows a "Review in Profile Manager" action that dispatches open-profile-manager', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      let opened = false;
      el.addEventListener('open-profile-manager', () => {
        opened = true;
      });

      clickButton(el, 'Review in Profile Manager');
      await waitForUpdate(el, 50);

      expect(opened).to.be.true;
    });
  });

  // ======================================================================
  // Account assignment
  // ======================================================================

  describe('Account assignment', () => {
    it('shows unmatched accounts section when there are unmatched accounts', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const unmatchedSection = el.shadowRoot!.querySelector('.unmatched-section');
      expect(unmatchedSection).to.not.be.null;
    });

    it('renders unmatched account names', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const unmatchedNames = el.shadowRoot!.querySelectorAll('.unmatched-account-name');
      expect(unmatchedNames.length).to.equal(1);
      expect(unmatchedNames[0].textContent).to.equal('Side Project GitHub');
    });

    it('renders profile select dropdowns for unmatched accounts', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const selects = el.shadowRoot!.querySelectorAll('.profile-select');
      expect(selects.length).to.equal(1);
    });

    it('pre-selects the suggested profile for unmatched accounts', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const select = el.shadowRoot!.querySelector('.profile-select') as HTMLSelectElement;
      expect(select).to.not.be.null;
      expect(select.value).to.equal('profile-2'); // suggestedProfileId
    });

    it('allows changing the profile assignment via dropdown', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const select = el.shadowRoot!.querySelector('.profile-select') as HTMLSelectElement;
      select.value = 'profile-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForUpdate(el);

      // The assignment should be updated - verify by starting migration
      clearHistory();
      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const migrationCalls = findCommands('execute_unified_profiles_migration');
      expect(migrationCalls.length).to.equal(1);
      const args = migrationCalls[0].args as Record<string, unknown>;
      const assignments = args.accountAssignments as Record<string, string>;
      expect(assignments['acc-3']).to.equal('profile-1');
    });

    it('does not show unmatched section when all accounts are matched', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_NO_UNMATCHED;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const unmatchedSection = el.shadowRoot!.querySelector('.unmatched-section');
      expect(unmatchedSection).to.be.null;
    });
  });

  // ======================================================================
  // Execute migration
  // ======================================================================

  describe('Execute migration', () => {
    it('calls execute_unified_profiles_migration with account assignments', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);
      clearHistory();

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const migrationCalls = findCommands('execute_unified_profiles_migration');
      expect(migrationCalls.length).to.equal(1);

      const args = migrationCalls[0].args as Record<string, unknown>;
      const assignments = args.accountAssignments as Record<string, string>;
      expect(assignments['acc-3']).to.equal('profile-2'); // suggestedProfileId default
    });

    it('shows Done button after successful migration', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      const buttons = el.shadowRoot!.querySelectorAll('.dialog-footer button');
      const doneBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Done');
      expect(doneBtn).to.not.be.null;
    });

    it('closes dialog when Done is clicked after migration', async () => {
      const el = await renderDialog(true);

      let closeDispatched = false;
      el.addEventListener('close', () => {
        closeDispatched = true;
      });

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      clickButton(el, 'Done');
      await waitForUpdate(el);

      expect(closeDispatched).to.be.true;
    });
  });

  // ======================================================================
  // Error handling
  // ======================================================================

  describe('Error handling', () => {
    it('goes back to preview on migration failure', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            throw new Error('Migration failed: disk full');
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      // Should go back to preview on error
      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Review Migration');

      // Preview content should still be visible
      const profilePreviews = el.shadowRoot!.querySelectorAll('.profile-preview');
      expect(profilePreviews.length).to.equal(2);
    });

    it('allows retrying migration after failure', async () => {
      let callCount = 0;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            callCount++;
            if (callCount === 1) {
              throw new Error('Temporary failure');
            }
            return MIGRATION_SUCCESS;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      // First attempt fails
      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      // Should be back on preview
      let title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Review Migration');

      // Second attempt succeeds
      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 200);

      title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Migration Complete');
    });

    it('handles preview loading failure gracefully', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            throw new Error('Network error');
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      // Should still be on intro (or show error) since preview load failed
      // The component catches the error and shows a toast but doesn't transition
      // viewMode stays at 'intro' because the preview load failed
      const introContent = el.shadowRoot!.querySelector('.intro-content');
      expect(introContent).to.not.be.null;
    });
  });

  // ======================================================================
  // Empty state
  // ======================================================================

  describe('Empty state', () => {
    it('shows empty preview when no profiles or accounts to migrate', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_EMPTY;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const emptyPreview = el.shadowRoot!.querySelector('.empty-preview');
      expect(emptyPreview).to.not.be.null;
      expect(emptyPreview!.textContent).to.include('No profiles or accounts to migrate');
    });

    it('shows Open Profile Manager button in empty state', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_EMPTY;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const buttons = el.shadowRoot!.querySelectorAll('.empty-preview button');
      const profileManagerBtn = Array.from(buttons).find(
        (b) => b.textContent?.trim() === 'Open Profile Manager',
      );
      expect(profileManagerBtn).to.not.be.null;
    });

    it('dispatches open-profile-manager event from empty state', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_EMPTY;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      let eventFired = false;
      el.addEventListener('open-profile-manager', () => {
        eventFired = true;
      });

      clickButton(el, 'Open Profile Manager');
      await waitForUpdate(el);

      expect(eventFired).to.be.true;
    });

    it('shows Refresh button in empty state', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_EMPTY;
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      const buttons = el.shadowRoot!.querySelectorAll('.empty-preview button');
      const refreshBtn = Array.from(buttons).find(
        (b) => b.textContent?.trim() === 'Refresh',
      );
      expect(refreshBtn).to.not.be.null;
    });
  });

  // ======================================================================
  // Dialog open/close behavior
  // ======================================================================

  describe('Dialog open/close behavior', () => {
    it('dispatches close event when Skip is clicked', async () => {
      const el = await renderDialog(true);

      let closeDispatched = false;
      el.addEventListener('close', () => {
        closeDispatched = true;
      });

      clickButton(el, 'Skip for now');
      await waitForUpdate(el);

      expect(closeDispatched).to.be.true;
    });

    it('dispatches close event when Cancel is clicked in preview', async () => {
      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      let closeDispatched = false;
      el.addEventListener('close', () => {
        closeDispatched = true;
      });

      clickButton(el, 'Cancel');
      await waitForUpdate(el);

      expect(closeDispatched).to.be.true;
    });

    it('resets state when dialog is re-opened', async () => {
      const el = await renderDialog(true);

      // Navigate to preview
      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      let title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Review Migration');

      // Close the dialog
      el.open = false;
      await el.updateComplete;
      await waitForUpdate(el);

      // Re-open - this triggers updated() which calls resetState()
      el.open = true;
      await el.updateComplete;
      await waitForUpdate(el);

      // Should be back to intro
      title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Upgrade to Unified Profiles');
    });

    it('shows disabled Migrating button during migration', async () => {
      let resolveExecution: ((value: unknown) => void) | null = null;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            // Hang until we manually resolve
            return new Promise((resolve) => {
              resolveExecution = resolve;
            });
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 10);

      const title = el.shadowRoot!.querySelector('.dialog-title');
      expect(title!.textContent).to.include('Migrating');

      const buttons = el.shadowRoot!.querySelectorAll('.dialog-footer button');
      const migratingBtn = Array.from(buttons).find(
        (b) => b.textContent?.trim() === 'Migrating...',
      );
      expect(migratingBtn).to.not.be.null;
      expect((migratingBtn as HTMLButtonElement).disabled).to.be.true;

      // Clean up by resolving the pending promise
      if (resolveExecution) {
        (resolveExecution as (value: unknown) => void)(MIGRATION_SUCCESS);
        await waitForUpdate(el, 100);
      }
    });

    it('shows migrating content with spinner during migration', async () => {
      let resolveExecution: ((value: unknown) => void) | null = null;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'preview_unified_profiles_migration':
            return PREVIEW_WITH_PROFILES;
          case 'execute_unified_profiles_migration':
            return new Promise((resolve) => {
              resolveExecution = resolve;
            });
          case 'get_unified_profiles_config':
            return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await renderDialog(true);

      clickButton(el, 'Continue');
      await waitForUpdate(el, 100);

      clickButton(el, 'Start Migration');
      await waitForUpdate(el, 10);

      const spinner = el.shadowRoot!.querySelector('.spinner');
      expect(spinner).to.not.be.null;

      const migratingContent = el.shadowRoot!.querySelector('.migrating-content');
      expect(migratingContent).to.not.be.null;
      expect(migratingContent!.textContent).to.include('Migrating Your Data');

      // Clean up
      if (resolveExecution) {
        (resolveExecution as (value: unknown) => void)(MIGRATION_SUCCESS);
        await waitForUpdate(el, 100);
      }
    });
  });

  // D6: opening the profile manager from the migration dialog must also close
  // the migration dialog so it isn't left stacked behind.
  describe('Open Profile Manager (D6)', () => {
    it('dispatches open-profile-manager and then closes the migration dialog', async () => {
      const el = await renderDialog(true);
      await waitForUpdate(el);

      const order: string[] = [];
      el.addEventListener('open-profile-manager', () => order.push('open-profile-manager'));
      el.addEventListener('close', () => order.push('close'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenProfileManager();
      await el.updateComplete;

      expect(order).to.deep.equal(['open-profile-manager', 'close']);
      expect((el as unknown as { open: boolean }).open).to.be.false;
    });
  });
});
