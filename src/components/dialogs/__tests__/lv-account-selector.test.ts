/**
 * Account Selector Component Tests
 *
 * Tests the lv-account-selector Lit component for rendering,
 * filtering, event dispatching, and dropdown behavior.
 */

// Mock Tauri API before importing any modules that use it
const mockInvoke = (): Promise<unknown> => Promise.resolve(null);
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { createEmptyIntegrationAccount } from '../../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';
import '../lv-account-selector.ts';
import type { LvAccountSelector } from '../lv-account-selector.ts';

// Helper: create a test account with overrides
function createTestAccount(
  overrides: Partial<IntegrationAccount> & { id: string }
): IntegrationAccount {
  const base = createEmptyIntegrationAccount(overrides.integrationType ?? 'github');
  return {
    ...base,
    name: 'Test Account',
    isDefault: false,
    cachedUser: null,
    ...overrides,
  } as IntegrationAccount;
}

describe('lv-account-selector', () => {
  // Test accounts
  let githubAccount1: IntegrationAccount;
  let githubAccount2: IntegrationAccount;
  let gitlabAccount1: IntegrationAccount;

  beforeEach(() => {
    // Reset the store
    unifiedProfileStore.getState().reset();

    // Create test accounts
    githubAccount1 = createTestAccount({
      id: 'acc-1',
      name: 'Work GitHub',
      integrationType: 'github',
      isDefault: true,
      cachedUser: {
        username: 'workuser',
        displayName: 'Work User',
        avatarUrl: null,
        email: 'work@example.com',
      },
    });

    githubAccount2 = createTestAccount({
      id: 'acc-2',
      name: 'Personal GitHub',
      integrationType: 'github',
      isDefault: false,
      cachedUser: {
        username: 'personaluser',
        displayName: 'Personal User',
        avatarUrl: null,
        email: 'personal@example.com',
      },
    });

    gitlabAccount1 = createTestAccount({
      id: 'acc-3',
      name: 'My GitLab',
      integrationType: 'gitlab',
      config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
      isDefault: true,
      cachedUser: {
        username: 'gitlabuser',
        displayName: 'GitLab User',
        avatarUrl: null,
        email: 'gl@example.com',
      },
    });

    // Set up accounts in the store
    unifiedProfileStore.getState().setAccounts([
      githubAccount1,
      githubAccount2,
      gitlabAccount1,
    ]);
  });

  it('renders with the selected account name displayed', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    const accountName = el.shadowRoot!.querySelector('.account-name');
    expect(accountName).to.not.be.null;
    expect(accountName!.textContent).to.include('Work GitHub');
  });

  it('filters accounts by integration type', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open the dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    expect(selectorBtn).to.not.be.null;
    selectorBtn.click();
    await el.updateComplete;

    // Should only show github accounts (2), not gitlab
    const items = el.shadowRoot!.querySelectorAll('.dropdown-item');
    expect(items.length).to.equal(2);
  });

  it('shows "No account selected" when selectedAccountId is null', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${null}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    const noAccount = el.shadowRoot!.querySelector('.no-account');
    expect(noAccount).to.not.be.null;
    expect(noAccount!.textContent).to.include('No account selected');
  });

  it('opens dropdown on click', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Dropdown should not be visible initially
    let dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).to.be.null;

    // Click the selector button
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Dropdown should now be visible
    dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).to.not.be.null;
  });

  it('dropdown shows all accounts for the integration type', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.dropdown-item');
    expect(items.length).to.equal(2);

    // Verify account names are present
    const itemTexts = Array.from(items).map((item) => item.textContent);
    expect(itemTexts.some((t) => t?.includes('Work GitHub'))).to.be.true;
    expect(itemTexts.some((t) => t?.includes('Personal GitHub'))).to.be.true;
  });

  it('shows "Default" badge on the default account', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    const defaultBadges = el.shadowRoot!.querySelectorAll('.default-badge');
    expect(defaultBadges.length).to.equal(1);
    expect(defaultBadges[0].textContent).to.include('Default');
  });

  it('dispatches account-change event when selecting a different account', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Listen for the event
    let eventDetail: unknown = null;
    el.addEventListener('account-change', ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    // Click the second account (not the currently selected one)
    const items = el.shadowRoot!.querySelectorAll('.dropdown-item');
    const secondItem = items[1] as HTMLButtonElement;
    secondItem.click();
    await el.updateComplete;

    expect(eventDetail).to.not.be.null;
    expect((eventDetail as { account: IntegrationAccount }).account.id).to.equal('acc-2');
  });

  it('does NOT dispatch account-change when re-selecting the already-selected account', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Listen for the event
    let eventFired = false;
    el.addEventListener('account-change', (() => {
      eventFired = true;
    }) as EventListener);

    // Click the first account (the currently selected one, acc-1)
    const items = el.shadowRoot!.querySelectorAll('.dropdown-item');
    const firstItem = items[0] as HTMLButtonElement;
    firstItem.click();
    await el.updateComplete;

    expect(eventFired).to.be.false;
  });

  it('dispatches add-account event when "Add Account" is clicked', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Listen for add-account event
    let eventDetail: unknown = null;
    el.addEventListener('add-account', ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    // Click the "Add Account" action button
    const actionButtons = el.shadowRoot!.querySelectorAll('.dropdown-action');
    const addButton = Array.from(actionButtons).find((btn) =>
      btn.textContent?.includes('Add Account')
    ) as HTMLButtonElement;
    expect(addButton).to.not.be.undefined;
    addButton.click();
    await el.updateComplete;

    expect(eventDetail).to.not.be.null;
    expect((eventDetail as { integrationType: string }).integrationType).to.equal('github');
  });

  it('dispatches manage-accounts event when "Manage Accounts" is clicked', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Listen for manage-accounts event
    let eventDetail: unknown = null;
    el.addEventListener('manage-accounts', ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    // Click the "Manage Accounts" action button
    const actionButtons = el.shadowRoot!.querySelectorAll('.dropdown-action');
    const manageButton = Array.from(actionButtons).find((btn) =>
      btn.textContent?.includes('Manage Accounts')
    ) as HTMLButtonElement;
    expect(manageButton).to.not.be.undefined;
    manageButton.click();
    await el.updateComplete;

    expect(eventDetail).to.not.be.null;
    expect((eventDetail as { integrationType: string }).integrationType).to.equal('github');
  });

  describe('disabled', () => {
    async function mountDisabled(): Promise<LvAccountSelector> {
      const el = await fixture<LvAccountSelector>(html`
        <lv-account-selector
          integrationType="github"
          .selectedAccountId=${'acc-1'}
          disabled
        ></lv-account-selector>
      `);
      await el.updateComplete;
      return el;
    }

    it('cannot be opened', async () => {
      const el = await mountDisabled();
      const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
      expect(selectorBtn.disabled, 'the trigger is disabled').to.be.true;

      // Belt and braces: a synthetic click on a disabled button still runs the
      // handler in some engines, so the handler itself must refuse too.
      selectorBtn.dispatchEvent(new Event('click', { bubbles: true }));
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.dropdown')).to.equal(null);
    });

    it('does not dispatch add-account or manage-accounts', async () => {
      const el = await mountDisabled();
      const dispatched: string[] = [];
      for (const name of ['add-account', 'manage-accounts']) {
        el.addEventListener(name, () => dispatched.push(name));
      }

      const internal = el as unknown as {
        handleAddAccount: () => void;
        handleManageAccounts: () => void;
      };
      internal.handleAddAccount();
      internal.handleManageAccounts();
      await el.updateComplete;

      expect(dispatched, 'no navigation request leaves a disabled selector').to.deep.equal([]);
    });

    it('folds an open dropdown away and disables its actions when disabled mid-way', async () => {
      const el = await fixture<LvAccountSelector>(html`
        <lv-account-selector
          integrationType="github"
          .selectedAccountId=${'acc-1'}
        ></lv-account-selector>
      `);
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement).click();
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.dropdown'), 'open before').to.not.equal(null);

      el.disabled = true;
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.dropdown'), 'closed once disabled').to.equal(null);
      expect(
        (el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement).disabled,
      ).to.be.true;

      // And the actions are inert even if the dropdown were forced open.
      (el as unknown as { isOpen: boolean }).isOpen = true;
      await el.updateComplete;
      const actions = Array.from(
        el.shadowRoot!.querySelectorAll('.dropdown-action'),
      ) as HTMLButtonElement[];
      expect(actions.length, 'both actions rendered').to.equal(2);
      expect(actions.every((b) => b.disabled), 'both actions disabled').to.be.true;
    });
  });

  // D7: clicking add/manage must give immediate inline feedback (not be silent).
  it('shows a busy "Opening…" label and disables actions after clicking Add Account', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    const actionButtons = el.shadowRoot!.querySelectorAll('.dropdown-action');
    const addButton = Array.from(actionButtons).find((btn) =>
      btn.textContent?.includes('Add Account')
    ) as HTMLButtonElement;
    addButton.click();
    await el.updateComplete;

    // Inline busy feedback is visible (dropdown stays open).
    const addAfter = Array.from(el.shadowRoot!.querySelectorAll('.dropdown-action')).find((b) =>
      b.textContent?.includes('Opening')
    );
    expect(addAfter, 'busy label shown').to.not.be.undefined;
    // Both actions are disabled while pending.
    el.shadowRoot!.querySelectorAll('.dropdown-action').forEach((b) => {
      expect((b as HTMLButtonElement).disabled).to.be.true;
    });
  });

  it('shows a busy "Opening…" label after clicking Manage Accounts', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    const actionButtons = el.shadowRoot!.querySelectorAll('.dropdown-action');
    const manageButton = Array.from(actionButtons).find((btn) =>
      btn.textContent?.includes('Manage Accounts')
    ) as HTMLButtonElement;
    manageButton.click();
    await el.updateComplete;

    const manageAfter = Array.from(el.shadowRoot!.querySelectorAll('.dropdown-action')).find((b) =>
      b.textContent?.includes('Opening')
    );
    expect(manageAfter, 'busy label shown').to.not.be.undefined;
    expect((el as unknown as { pendingAction: string | null }).pendingAction).to.equal('manage');
  });

  // Review fix: the busy state must not get stuck if the parent never navigates.
  it('clears the pending busy state when the dropdown is reopened', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    const addButton = Array.from(el.shadowRoot!.querySelectorAll('.dropdown-action')).find((btn) =>
      btn.textContent?.includes('Add Account')
    ) as HTMLButtonElement;
    addButton.click();
    await el.updateComplete;
    expect((el as unknown as { pendingAction: string | null }).pendingAction).to.equal('add');

    // Parent didn't navigate; user closes and reopens the selector.
    selectorBtn.click(); // close
    await el.updateComplete;
    selectorBtn.click(); // reopen
    await el.updateComplete;

    expect((el as unknown as { pendingAction: string | null }).pendingAction).to.be.null;
    el.shadowRoot!.querySelectorAll('.dropdown-action').forEach((b) => {
      expect((b as HTMLButtonElement).disabled).to.be.false;
    });
  });

  it('dropdown closes after selecting an account', async () => {
    const el = await fixture<LvAccountSelector>(html`
      <lv-account-selector
        integrationType="github"
        .selectedAccountId=${'acc-1'}
      ></lv-account-selector>
    `);
    await el.updateComplete;

    // Open dropdown
    const selectorBtn = el.shadowRoot!.querySelector('.selector-btn') as HTMLButtonElement;
    selectorBtn.click();
    await el.updateComplete;

    // Dropdown should be open
    let dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).to.not.be.null;

    // Click a different account
    const items = el.shadowRoot!.querySelectorAll('.dropdown-item');
    const secondItem = items[1] as HTMLButtonElement;
    secondItem.click();
    await el.updateComplete;

    // Dropdown should be closed
    dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).to.be.null;
  });
});
