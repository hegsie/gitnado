import { type Page, type Locator } from '@playwright/test';

/**
 * Base dialog helper class
 */
class BaseDialog {
  readonly page: Page;
  // NOT readonly: several subclasses override these in their own constructor
  // with a more precise locator (a role-based query, or one scoped inside the
  // dialog). TypeScript only permits assigning a readonly field in the class
  // that declares it, so those 11 assignments were type errors — invisible
  // because e2e/ was never typechecked, and harmless at runtime only because
  // `readonly` is erased.
  dialog: Locator;
  closeButton: Locator;

  constructor(page: Page, selector: string) {
    this.page = page;
    this.dialog = page.locator(selector);
    this.closeButton = this.dialog.locator('.close-btn, button[aria-label="Close"]');
  }

  async isVisible(): Promise<boolean> {
    return this.dialog.isVisible();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async closeWithEscape(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async waitForOpen(): Promise<void> {
    await this.dialog.waitFor({ state: 'visible' });
  }
}

/**
 * Clone Dialog Page Object
 */
export class CloneDialogPage extends BaseDialog {
  readonly urlInput: Locator;
  readonly pathInput: Locator;
  readonly browseButton: Locator;
  readonly cloneButton: Locator;
  readonly progressBar: Locator;
  readonly branchInput: Locator;
  readonly submodulesCheckbox: Locator;

  constructor(page: Page) {
    super(page, 'lv-clone-dialog');
    // Use direct role selectors (Playwright pierces shadow DOM automatically)
    this.dialog = page.getByRole('dialog', { name: 'Clone Repository' });
    this.closeButton = page.getByRole('button', { name: 'Close' });
    // Use direct getByRole on page since Playwright flattens the accessibility tree
    this.urlInput = page.getByRole('textbox', { name: 'Repository URL' });
    this.pathInput = page.getByRole('textbox', { name: 'Clone to' });
    this.browseButton = page.getByRole('button', { name: /Browse/i });
    // Clone button inside the dialog - use locator within the dialog to avoid matching welcome screen button
    this.cloneButton = page.locator('lv-clone-dialog').getByRole('button', { name: 'Clone', exact: true });
    this.progressBar = this.dialog.locator('.progress-bar, progress');
    // Role selectors, not CSS: two lv-clone-dialog instances are mounted (the
    // toolbar's and the shell's) and only the open one is in the
    // accessibility tree, so a CSS id match is ambiguous while a role match is
    // not.
    this.branchInput = page.getByRole('textbox', { name: /^Branch/ });
    this.submodulesCheckbox = page.getByRole('checkbox', { name: /Clone submodules/i });
  }

  async fillBranch(branch: string): Promise<void> {
    await this.branchInput.fill(branch);
  }

  async checkSubmodules(): Promise<void> {
    await this.submodulesCheckbox.check();
  }

  async fillUrl(url: string): Promise<void> {
    await this.urlInput.fill(url);
  }

  async fillPath(path: string): Promise<void> {
    await this.pathInput.fill(path);
  }

  async clone(): Promise<void> {
    await this.cloneButton.click();
  }

  async isCloneEnabled(): Promise<boolean> {
    return this.cloneButton.isEnabled();
  }
}

/**
 * Init Dialog Page Object
 */
export class InitDialogPage extends BaseDialog {
  readonly pathInput: Locator;
  readonly initialBranchInput: Locator;
  readonly browseButton: Locator;
  readonly initButton: Locator;
  readonly bareCheckbox: Locator;

  constructor(page: Page) {
    super(page, 'lv-init-dialog');
    // Use direct role selectors (Playwright flattens the accessibility tree)
    this.dialog = page.getByRole('dialog', { name: 'Initialize Repository' });
    this.closeButton = page.getByRole('button', { name: 'Close' });
    // Path input has label "Repository Location"
    this.pathInput = page.getByRole('textbox', { name: /Repository Location/i });
    // Initial branch input has label "Initial Branch Name"
    this.initialBranchInput = page.getByRole('textbox', { name: /Initial Branch/i });
    this.browseButton = page.getByRole('button', { name: /Browse/i });
    // Initialize button - may be disabled when no path
    this.initButton = page.getByRole('button', { name: /Initialize/i });
    this.bareCheckbox = page.getByRole('checkbox', { name: /bare/i });
  }

  async fillPath(path: string): Promise<void> {
    await this.pathInput.fill(path);
  }

  async fillInitialBranch(branch: string): Promise<void> {
    await this.initialBranchInput.fill(branch);
  }

  async init(): Promise<void> {
    await this.initButton.click();
  }

  async setBare(bare: boolean): Promise<void> {
    if (bare) {
      await this.bareCheckbox.check();
    } else {
      await this.bareCheckbox.uncheck();
    }
  }
}

/**
 * Create Branch Dialog Page Object
 */
export class CreateBranchDialogPage extends BaseDialog {
  readonly nameInput: Locator;
  readonly createButton: Locator;
  readonly checkoutCheckbox: Locator;

  constructor(page: Page) {
    super(page, 'lv-create-branch-dialog');
    // Use role-based selector for the Branch Name input
    this.nameInput = page.getByRole('textbox', { name: 'Branch Name' });
    // Use exact match for Create Branch button to avoid matching "Create tag" button
    this.createButton = page.locator('lv-create-branch-dialog').getByRole('button', { name: 'Create Branch' });
    this.checkoutCheckbox = this.dialog.locator('input[type="checkbox"]');
  }

  async fillName(name: string): Promise<void> {
    await this.nameInput.fill(name);
  }

  async create(): Promise<void> {
    await this.createButton.click();
  }

  async setCheckoutAfterCreate(checkout: boolean): Promise<void> {
    if (checkout) {
      await this.checkoutCheckbox.check();
    } else {
      await this.checkoutCheckbox.uncheck();
    }
  }
}

/**
 * Settings Dialog Page Object
 */
export class SettingsDialogPage extends BaseDialog {
  readonly themeSelect: Locator;
  readonly vimModeToggle: Locator;
  readonly doneButton: Locator;
  readonly resetButton: Locator;

  constructor(page: Page) {
    // Settings dialog uses lv-modal which adds role="dialog" with aria-labelledby
    super(page, 'lv-modal:has(lv-settings-dialog)');
    // Use locator for modal dialog (lv-modal with Settings title)
    this.dialog = page.locator('lv-modal:has(lv-settings-dialog)');
    // Theme select - the select element inside settings-dialog
    this.themeSelect = page.locator('lv-settings-dialog #theme-select');
    // Toggle switches for boolean settings (showAvatars, showCommitSize, wordWrap, confirmBeforeDiscard)
    // Note: vim mode toggle is in keyboard shortcuts dialog, not settings
    this.vimModeToggle = page.locator('lv-settings-dialog lv-toggle').first();
    this.doneButton = page.locator('lv-settings-dialog button:has-text("Done")');
    this.resetButton = page.locator('lv-settings-dialog button:has-text("Reset to Defaults")');
  }

  async setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
    await this.themeSelect.selectOption(theme);
  }

  async toggleVimMode(): Promise<void> {
    await this.vimModeToggle.click();
  }

  async save(): Promise<void> {
    await this.doneButton.click();
  }
}

/**
 * Profile Manager Dialog Page Object
 */
export class ProfileManagerDialogPage extends BaseDialog {
  readonly profileList: Locator;
  readonly addProfileButton: Locator;
  readonly nameInput: Locator;
  readonly gitNameInput: Locator;
  readonly emailInput: Locator;
  readonly signingKeyInput: Locator;
  readonly urlPatternsInput: Locator;
  readonly colorOptions: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;
  readonly deleteButton: Locator;
  readonly setDefaultButton: Locator;
  readonly accountsSection: Locator;
  readonly addAccountButton: Locator;
  readonly integrationAccountsSection: Locator;
  readonly attachAccountButton: Locator;
  readonly attachedAccountItems: Locator;
  readonly pickerAccountRows: Locator;

  constructor(page: Page) {
    super(page, 'lv-profile-manager-dialog');
    // The dialog header contains "Profiles" text - use that to verify visibility
    // Custom element tags aren't in accessibility tree, so use text matching
    this.dialog = page.locator('lv-profile-manager-dialog[open]');
    // Fallback - check for the New Profile button which is only visible in the dialog
    this.profileList = page.locator('lv-profile-manager-dialog[open] .profile-list');
    // "New Profile" button - use accessible role selector
    this.addProfileButton = page.getByRole('button', { name: 'New Profile' });
    // Profile name input (placeholder: "e.g., Work, Personal, Open Source")
    this.nameInput = page.getByPlaceholder(/Work, Personal/i);
    // Git name input (placeholder: "John Doe")
    this.gitNameInput = page.getByPlaceholder('John Doe');
    // Git email input (placeholder: "john@example.com")
    this.emailInput = page.getByPlaceholder('john@example.com');
    // Signing key input (placeholder: "Key ID or fingerprint")
    this.signingKeyInput = page.getByPlaceholder(/Key ID|fingerprint/i);
    // URL patterns textarea
    this.urlPatternsInput = page.getByPlaceholder(/github.com\/mycompany/i);
    this.colorOptions = page.locator('.color-option, .color-swatch');
    this.saveButton = page.getByRole('button', { name: /save|create|done/i });
    this.cancelButton = page.getByRole('button', { name: /cancel|back/i });
    this.deleteButton = page.getByRole('button', { name: /delete/i });
    this.setDefaultButton = page.getByRole('button', { name: /set as default|make default/i });
    this.accountsSection = page.locator('.accounts-section, [data-section="accounts"]');
    this.addAccountButton = page.getByRole('button', { name: /add account/i });
    // The "Integration Accounts" section of the profile edit form (distinct from
    // the "Assigned Repositories" section, which shares the .accounts-section class).
    this.integrationAccountsSection = page
      .locator('lv-profile-manager-dialog .accounts-section')
      .filter({ hasText: 'Integration Accounts' });
    this.attachAccountButton = this.integrationAccountsSection.getByRole('button', {
      name: 'Add',
      exact: true,
    });
    this.attachedAccountItems = this.integrationAccountsSection.locator('.account-item');
    // Selectable rows shown in the account picker (select-account view).
    this.pickerAccountRows = page.locator('lv-profile-manager-dialog .account-item.selectable');
  }

  async getProfileCount(): Promise<number> {
    return this.profileList.locator('.profile-item, .profile-card').count();
  }

  async getProfileNames(): Promise<string[]> {
    const items = this.profileList.locator('.profile-item, .profile-card');
    const count = await items.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = await items.nth(i).locator('.profile-name, .name').textContent();
      if (name) names.push(name.trim());
    }
    return names;
  }

  async selectProfile(name: string): Promise<void> {
    await this.profileList.locator('.profile-item, .profile-card', { hasText: name }).click();
  }

  async addProfile(name: string, gitName: string, email: string): Promise<void> {
    await this.addProfileButton.click();
    await this.nameInput.fill(name);
    await this.gitNameInput.fill(gitName);
    await this.emailInput.fill(email);
  }

  async fillProfileForm(data: {
    name?: string;
    gitName?: string;
    gitEmail?: string;
    signingKey?: string;
    urlPatterns?: string;
  }): Promise<void> {
    if (data.name) await this.nameInput.fill(data.name);
    if (data.gitName) await this.gitNameInput.fill(data.gitName);
    if (data.gitEmail) await this.emailInput.fill(data.gitEmail);
    if (data.signingKey) await this.signingKeyInput.fill(data.signingKey);
    if (data.urlPatterns) await this.urlPatternsInput.fill(data.urlPatterns);
  }

  async selectColor(index: number): Promise<void> {
    await this.colorOptions.nth(index).click();
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async deleteProfile(): Promise<void> {
    await this.deleteButton.click();
  }

  async setAsDefault(): Promise<void> {
    await this.setDefaultButton.click();
  }

  async isDefaultProfile(name: string): Promise<boolean> {
    const profile = this.profileList.locator('.profile-item, .profile-card', { hasText: name });
    const defaultBadge = profile.locator('.default-badge, :text("Default")');
    return defaultBadge.isVisible();
  }
}

/**
 * GitHub Dialog Page Object
 */
export class GitHubDialogPage extends BaseDialog {
  // Tabs
  readonly connectionTab: Locator;
  readonly pullRequestsTab: Locator;
  readonly issuesTab: Locator;
  readonly releasesTab: Locator;
  readonly actionsTab: Locator;

  // Connection tab
  readonly tokenInput: Locator;
  readonly connectButton: Locator;
  readonly connectionStatus: Locator;

  // OAuth elements
  readonly authMethodToggle: Locator;
  readonly oauthButton: Locator;
  readonly patButton: Locator;
  readonly oauthSignInButton: Locator;
  readonly oauthSpinner: Locator;
  readonly oauthStatus: Locator;
  readonly oauthDivider: Locator;

  // GitHub App elements
  readonly appButton: Locator;
  readonly appIdInput: Locator;
  readonly appPrivateKeyInput: Locator;
  readonly appInstallationInput: Locator;
  readonly connectViaAppButton: Locator;

  // Pull requests tab
  readonly prList: Locator;
  readonly createPrButton: Locator;

  // Issues tab
  readonly issueList: Locator;
  readonly createIssueButton: Locator;

  constructor(page: Page) {
    super(page, 'lv-github-dialog');
    // GitHub dialog uses lv-modal wrapper - check the modal's dialog role
    this.dialog = page.getByRole('dialog', { name: 'GitHub' });

    // Tabs - buttons with class .tab inside .tabs container
    this.connectionTab = page.locator('lv-github-dialog .tab:has-text("Connection")');
    this.pullRequestsTab = page.locator('lv-github-dialog .tab:has-text("Pull Requests")');
    this.issuesTab = page.locator('lv-github-dialog .tab:has-text("Issues")');
    this.releasesTab = page.locator('lv-github-dialog .tab:has-text("Releases")');
    this.actionsTab = page.locator('lv-github-dialog .tab:has-text("Actions")');

    // Connection
    this.tokenInput = page.locator('lv-github-dialog input[type="password"]');
    this.connectButton = page.locator('lv-github-dialog button:has-text("Connect to GitHub")');
    this.connectionStatus = page.locator('lv-github-dialog .connection-status');

    // OAuth elements
    this.authMethodToggle = page.locator('lv-github-dialog .auth-method-toggle');
    this.oauthButton = page.locator('lv-github-dialog .auth-method-toggle button:has-text("Sign in with GitHub")');
    this.patButton = page.locator('lv-github-dialog .auth-method-toggle button:has-text("Personal Access Token")');
    this.oauthSignInButton = page.locator('lv-github-dialog .btn-oauth');
    this.oauthSpinner = page.locator('lv-github-dialog .oauth-spinner');
    this.oauthStatus = page.locator('lv-github-dialog .oauth-status');
    this.oauthDivider = page.locator('lv-github-dialog .oauth-divider');

    // GitHub App elements
    this.appButton = page.locator('lv-github-dialog .auth-method-toggle button:has-text("GitHub App")');
    this.appIdInput = page.locator('lv-github-dialog input[placeholder="123456"]');
    this.appPrivateKeyInput = page.locator('lv-github-dialog textarea[placeholder^="Paste your private key"]');
    this.appInstallationInput = page.locator('lv-github-dialog input[placeholder^="Installation ID"]');
    this.connectViaAppButton = page.locator('lv-github-dialog button:has-text("Connect via GitHub App")');

    // PRs
    this.prList = page.locator('lv-github-dialog .pr-list');
    this.createPrButton = page.locator('lv-github-dialog button:has-text("New PR")');

    // Issues
    this.issueList = page.locator('lv-github-dialog .issue-list');
    this.createIssueButton = page.locator('lv-github-dialog button:has-text("New Issue")');
  }

  async switchToConnectionTab(): Promise<void> {
    await this.connectionTab.click();
  }

  async switchToPullRequestsTab(): Promise<void> {
    await this.pullRequestsTab.click();
  }

  async switchToIssuesTab(): Promise<void> {
    await this.issuesTab.click();
  }

  async switchToReleasesTab(): Promise<void> {
    await this.releasesTab.click();
  }

  async switchToActionsTab(): Promise<void> {
    await this.actionsTab.click();
  }

  async connect(token: string): Promise<void> {
    // Switch to PAT mode if OAuth toggle is visible
    if (await this.authMethodToggle.isVisible()) {
      await this.patButton.click();
    }
    await this.tokenInput.fill(token);
    await this.connectButton.click();
  }

  async selectOAuthMethod(): Promise<void> {
    await this.oauthButton.click();
  }

  async selectPATMethod(): Promise<void> {
    await this.patButton.click();
  }

  async selectAppMethod(): Promise<void> {
    await this.appButton.click();
  }

  async connectViaApp(
    appId: string,
    privateKey: string,
    installationId: string
  ): Promise<void> {
    await this.appIdInput.fill(appId);
    await this.appPrivateKeyInput.fill(privateKey);
    await this.appInstallationInput.fill(installationId);
    await this.connectViaAppButton.click();
  }

  async isOAuthConfigured(): Promise<boolean> {
    // OAuth is configured if the toggle is visible and the OAuth button is enabled
    const toggleVisible = await this.authMethodToggle.isVisible();
    if (!toggleVisible) return false;
    return this.oauthButton.isEnabled();
  }

  async isOAuthPending(): Promise<boolean> {
    return this.oauthSpinner.isVisible();
  }

  async isConnected(): Promise<boolean> {
    const status = await this.connectionStatus.textContent();
    return status?.toLowerCase().includes('connected') ?? false;
  }
}

/**
 * GitLab Dialog Page Object
 */
export class GitLabDialogPage extends BaseDialog {
  // Tabs
  readonly connectionTab: Locator;
  readonly mergeRequestsTab: Locator;
  readonly issuesTab: Locator;
  readonly pipelinesTab: Locator;

  // Create-issue tab
  readonly labelChips: Locator;

  // Connection tab
  readonly instanceUrlInput: Locator;
  readonly tokenInput: Locator;
  readonly connectButton: Locator;
  readonly connectionStatus: Locator;

  // OAuth elements
  readonly authMethodToggle: Locator;
  readonly oauthButton: Locator;
  readonly patButton: Locator;
  readonly oauthSignInButton: Locator;
  readonly oauthSpinner: Locator;
  readonly oauthStatus: Locator;

  constructor(page: Page) {
    super(page, 'lv-gitlab-dialog');
    // Use element locator since the modal title attribute may vary
    this.dialog = page.locator('lv-gitlab-dialog lv-modal[open]');

    // Tabs
    this.connectionTab = page.locator('lv-gitlab-dialog .tab:has-text("Connection")');
    this.mergeRequestsTab = page.locator('lv-gitlab-dialog .tab:has-text("Merge Requests")');
    this.issuesTab = page.locator('lv-gitlab-dialog .tab:has-text("Issues")');
    this.pipelinesTab = page.locator('lv-gitlab-dialog .tab:has-text("Pipelines")');

    // Create-issue label picker
    this.labelChips = page.locator('lv-gitlab-dialog .label-chip');

    // Connection
    this.instanceUrlInput = page.locator('lv-gitlab-dialog input[type="text"]').first();
    this.tokenInput = page.locator('lv-gitlab-dialog input[type="password"]');
    this.connectButton = page.locator('lv-gitlab-dialog button:has-text("Connect with Token")');
    this.connectionStatus = page.locator('lv-gitlab-dialog .connection-status');

    // OAuth
    this.authMethodToggle = page.locator('lv-gitlab-dialog .auth-method-toggle');
    this.oauthButton = page.locator('lv-gitlab-dialog .auth-method-toggle button:has-text("Sign in with GitLab")');
    this.patButton = page.locator('lv-gitlab-dialog .auth-method-toggle button:has-text("Personal Access Token")');
    this.oauthSignInButton = page.locator('lv-gitlab-dialog .btn-oauth');
    this.oauthSpinner = page.locator('lv-gitlab-dialog .oauth-spinner');
    this.oauthStatus = page.locator('lv-gitlab-dialog .oauth-status');
  }

  async switchToConnectionTab(): Promise<void> {
    await this.connectionTab.click();
  }

  async isOAuthConfigured(): Promise<boolean> {
    return this.authMethodToggle.isVisible();
  }

  async selectOAuthMethod(): Promise<void> {
    await this.oauthButton.click();
  }

  async selectPATMethod(): Promise<void> {
    await this.patButton.click();
  }
}

/**
 * Azure DevOps Dialog Page Object
 */
export class AzureDevOpsDialogPage extends BaseDialog {
  // Tabs
  readonly connectionTab: Locator;
  readonly pullRequestsTab: Locator;
  readonly workItemsTab: Locator;
  readonly pipelinesTab: Locator;

  // Connection tab
  readonly organizationInput: Locator;
  readonly tokenInput: Locator;
  readonly connectButton: Locator;
  readonly connectionStatus: Locator;

  // OAuth elements
  readonly authMethodToggle: Locator;
  readonly oauthButton: Locator;
  readonly patButton: Locator;
  readonly oauthSignInButton: Locator;
  readonly oauthSpinner: Locator;
  readonly oauthStatus: Locator;

  constructor(page: Page) {
    super(page, 'lv-azure-devops-dialog');
    // Use element locator since the modal title attribute may vary
    this.dialog = page.locator('lv-azure-devops-dialog lv-modal[open]');

    // Tabs
    this.connectionTab = page.locator('lv-azure-devops-dialog .tab:has-text("Connection")');
    this.pullRequestsTab = page.locator('lv-azure-devops-dialog .tab:has-text("Pull Requests")');
    this.workItemsTab = page.locator('lv-azure-devops-dialog .tab:has-text("Work Items")');
    this.pipelinesTab = page.locator('lv-azure-devops-dialog .tab:has-text("Pipelines")');

    // Connection
    this.organizationInput = page.locator('lv-azure-devops-dialog input[type="text"]').first();
    this.tokenInput = page.locator('lv-azure-devops-dialog input[type="password"]');
    this.connectButton = page.locator('lv-azure-devops-dialog .btn-primary:has-text("Connect")');
    this.connectionStatus = page.locator('lv-azure-devops-dialog .connection-status');

    // OAuth
    this.authMethodToggle = page.locator('lv-azure-devops-dialog .auth-method-toggle');
    this.oauthButton = page.locator('lv-azure-devops-dialog .auth-method-toggle button:has-text("Sign in with Microsoft")');
    this.patButton = page.locator('lv-azure-devops-dialog .auth-method-toggle button:has-text("Personal Access Token")');
    this.oauthSignInButton = page.locator('lv-azure-devops-dialog .btn-oauth');
    this.oauthSpinner = page.locator('lv-azure-devops-dialog .oauth-spinner');
    this.oauthStatus = page.locator('lv-azure-devops-dialog .oauth-status');
  }

  async switchToConnectionTab(): Promise<void> {
    await this.connectionTab.click();
  }

  async isOAuthConfigured(): Promise<boolean> {
    return this.authMethodToggle.isVisible();
  }

  async selectOAuthMethod(): Promise<void> {
    await this.oauthButton.click();
  }

  async selectPATMethod(): Promise<void> {
    await this.patButton.click();
  }
}

/**
 * Bitbucket Dialog Page Object
 */
export class BitbucketDialogPage extends BaseDialog {
  // Tabs
  readonly connectionTab: Locator;
  readonly pullRequestsTab: Locator;
  readonly issuesTab: Locator;
  readonly pipelinesTab: Locator;

  // Connection tab
  readonly usernameInput: Locator;
  readonly appPasswordInput: Locator;
  readonly connectButton: Locator;
  readonly connectionStatus: Locator;

  // OAuth elements
  readonly authMethodToggle: Locator;
  readonly oauthButton: Locator;
  readonly appPasswordButton: Locator;
  readonly oauthSignInButton: Locator;
  readonly oauthCancelButton: Locator;
  readonly oauthSpinner: Locator;
  readonly oauthStatus: Locator;

  constructor(page: Page) {
    super(page, 'lv-bitbucket-dialog');
    // Use element locator since the modal title attribute may vary
    this.dialog = page.locator('lv-bitbucket-dialog lv-modal[open]');

    // Tabs
    this.connectionTab = page.locator('lv-bitbucket-dialog .tab:has-text("Connection")');
    this.pullRequestsTab = page.locator('lv-bitbucket-dialog .tab:has-text("Pull Requests")');
    this.issuesTab = page.locator('lv-bitbucket-dialog .tab:has-text("Issues")');
    this.pipelinesTab = page.locator('lv-bitbucket-dialog .tab:has-text("Pipelines")');

    // Connection
    this.usernameInput = page.locator('lv-bitbucket-dialog input[type="text"]').first();
    this.appPasswordInput = page.locator('lv-bitbucket-dialog input[type="password"]');
    this.connectButton = page.locator('lv-bitbucket-dialog button:has-text("Connect with App Password")');
    this.connectionStatus = page.locator('lv-bitbucket-dialog .connection-status');

    // OAuth
    this.authMethodToggle = page.locator('lv-bitbucket-dialog .auth-method-toggle');
    this.oauthButton = page.locator('lv-bitbucket-dialog .auth-method-toggle button:has-text("Sign in with Bitbucket")');
    this.appPasswordButton = page.locator('lv-bitbucket-dialog .auth-method-toggle button:has-text("App Password")');
    this.oauthSignInButton = page.locator('lv-bitbucket-dialog .btn-oauth');
    this.oauthCancelButton = page.locator('lv-bitbucket-dialog .oauth-cancel');
    this.oauthSpinner = page.locator('lv-bitbucket-dialog .oauth-spinner');
    this.oauthStatus = page.locator('lv-bitbucket-dialog .oauth-status');
  }

  async switchToConnectionTab(): Promise<void> {
    await this.connectionTab.click();
  }

  async isOAuthConfigured(): Promise<boolean> {
    return this.authMethodToggle.isVisible();
  }

  /** Wait for the dialog's async open-load to settle (it sets `data-ready` when
   * loadInitialData finishes), so interactions don't race its re-renders. */
  async waitUntilReady(): Promise<void> {
    await this.authMethodToggle
      .page()
      .locator('lv-bitbucket-dialog[data-ready]')
      .waitFor({ state: 'attached', timeout: 10000 });
  }

  async selectOAuthMethod(): Promise<void> {
    await this.waitUntilReady();
    if (await this.authMethodToggle.isVisible()) {
      await this.oauthButton.click();
    }
  }

  async selectAppPasswordMethod(): Promise<void> {
    await this.waitUntilReady();
    if (await this.authMethodToggle.isVisible()) {
      await this.appPasswordButton.click();
    }
  }
}

/**
 * Keyboard Shortcuts Dialog Page Object
 */
export class KeyboardShortcutsDialogPage extends BaseDialog {
  readonly shortcutList: Locator;
  readonly vimModeToggle: Locator;

  constructor(page: Page) {
    // Keyboard shortcuts dialog has [open] attribute when visible
    super(page, 'lv-keyboard-shortcuts-dialog[open]');
    // The dialog is the component with [open] attribute
    this.dialog = page.locator('lv-keyboard-shortcuts-dialog[open]');
    // Shortcuts are in .content > .category > .shortcuts-list with .shortcut-row items
    this.shortcutList = page.locator('lv-keyboard-shortcuts-dialog[open] .content');
    // Vim toggle is the lv-toggle switch in the footer
    this.vimModeToggle = page
      .locator('lv-keyboard-shortcuts-dialog[open]')
      .getByRole('switch', { name: 'Vim-style navigation' });
  }

  async getShortcutCount(): Promise<number> {
    return this.page.locator('lv-keyboard-shortcuts-dialog[open] .shortcut-row').count();
  }

  async toggleVimMode(): Promise<void> {
    await this.vimModeToggle.click();
  }
}

/**
 * Command Palette Page Object
 */
export class CommandPalettePage {
  readonly page: Page;
  readonly palette: Locator;
  readonly input: Locator;
  readonly resultList: Locator;
  readonly results: Locator;

  constructor(page: Page) {
    this.page = page;
    // Command palette uses [open] attribute when visible
    this.palette = page.locator('lv-command-palette[open]');
    // Input has class .search-input
    this.input = this.palette.locator('.search-input');
    // Results are in .results div with .command items
    this.resultList = this.palette.locator('.results');
    this.results = this.resultList.locator('.command');
  }

  async open(): Promise<void> {
    await this.page.keyboard.press('Meta+p');
    await this.page.locator('lv-command-palette[open]').waitFor({ state: 'visible' });
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.locator('lv-command-palette[open]').waitFor({ state: 'hidden' });
  }

  async isVisible(): Promise<boolean> {
    return this.palette.isVisible();
  }

  async search(query: string): Promise<void> {
    await this.input.fill(query);
  }

  async selectResult(index: number): Promise<void> {
    await this.results.nth(index).click();
  }

  async selectResultByText(text: string): Promise<void> {
    await this.resultList.locator('.command', { hasText: text }).click();
  }

  async executeFirst(): Promise<void> {
    await this.page.keyboard.press('Enter');
  }

  async getResultCount(): Promise<number> {
    return this.results.count();
  }
}

/**
 * Config Dialog Page Object
 */
export class ConfigDialogPage extends BaseDialog {
  readonly identityTab: Locator;
  readonly settingsTab: Locator;
  readonly aliasesTab: Locator;
  readonly nameInput: Locator;
  readonly emailInput: Locator;
  readonly scopeRepositoryBtn: Locator;
  readonly scopeGlobalBtn: Locator;
  readonly saveButton: Locator;
  readonly settingsList: Locator;
  readonly aliasList: Locator;
  readonly addAliasForm: Locator;
  readonly errorBanner: Locator;

  constructor(page: Page) {
    super(page, 'lv-config-dialog');
    this.identityTab = page.locator('lv-config-dialog .tab', { hasText: 'Identity' });
    this.settingsTab = page.locator('lv-config-dialog .tab', { hasText: 'Settings' });
    this.aliasesTab = page.locator('lv-config-dialog .tab', { hasText: 'Aliases' });
    this.nameInput = page.locator('lv-config-dialog .form-group input').first();
    this.emailInput = page.locator('lv-config-dialog .form-group input').nth(1);
    this.scopeRepositoryBtn = page.locator('lv-config-dialog .scope-btn', { hasText: 'Repository' });
    this.scopeGlobalBtn = page.locator('lv-config-dialog .scope-btn', { hasText: 'Global' });
    this.saveButton = page.locator('lv-config-dialog .btn-primary');
    this.settingsList = page.locator('lv-config-dialog .settings-list');
    this.aliasList = page.locator('lv-config-dialog .alias-list');
    this.addAliasForm = page.locator('lv-config-dialog .add-alias-form');
    this.errorBanner = page.locator('lv-config-dialog .error-banner');
  }

  async switchToIdentity(): Promise<void> {
    await this.identityTab.click();
  }

  async switchToSettings(): Promise<void> {
    await this.settingsTab.click();
  }

  async switchToAliases(): Promise<void> {
    await this.aliasesTab.click();
  }

  async fillName(name: string): Promise<void> {
    await this.nameInput.fill(name);
  }

  async fillEmail(email: string): Promise<void> {
    await this.emailInput.fill(email);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async addAlias(name: string, command: string): Promise<void> {
    const inputs = this.addAliasForm.locator('input');
    await inputs.first().fill(name);
    await inputs.nth(1).fill(command);
    await this.addAliasForm.locator('button').click();
  }

  async deleteAlias(index: number): Promise<void> {
    await this.aliasList.locator('.btn-icon.danger').nth(index).click();
  }
}

/**
 * Reflog Dialog Page Object
 */
export class ReflogDialogPage extends BaseDialog {
  readonly entries: Locator;
  readonly currentBadge: Locator;

  constructor(page: Page) {
    super(page, 'lv-reflog-dialog');
    this.entries = page.locator('lv-reflog-dialog .entry');
    this.currentBadge = page.locator('lv-reflog-dialog .current-badge');
  }

  getEntry(index: number): Locator {
    return this.entries.nth(index);
  }

  async getEntryOid(index: number): Promise<string> {
    return (await this.entries.nth(index).locator('.entry-oid').textContent()) ?? '';
  }

  async openContextMenu(index: number): Promise<void> {
    await this.entries.nth(index).click({ button: 'right' });
  }

  async clickContextMenuItem(text: string): Promise<void> {
    await this.page.locator('.context-menu .menu-item', { hasText: text }).click();
  }

  async clickUndoButton(index: number): Promise<void> {
    await this.entries.nth(index).locator('.reset-btn:not(.hard)').click();
  }

  async clickHardResetButton(index: number): Promise<void> {
    await this.entries.nth(index).locator('.reset-btn.hard').click();
  }
}

/**
 * Remote Dialog Page Object
 */
export class RemoteDialogPage extends BaseDialog {
  readonly remoteList: Locator;
  readonly nameInput: Locator;
  readonly urlInput: Locator;
  readonly addButton: Locator;
  readonly editButton: Locator;
  readonly deleteButton: Locator;

  constructor(page: Page) {
    super(page, 'lv-remote-dialog');
    this.remoteList = page.locator('lv-remote-dialog .remote-list, lv-remote-dialog .remote-item');
    this.nameInput = page.locator('lv-remote-dialog input').first();
    this.urlInput = page.locator('lv-remote-dialog input').nth(1);
    this.addButton = page.locator('lv-remote-dialog .btn-primary, lv-remote-dialog button', { hasText: 'Add' });
    this.editButton = page.locator('lv-remote-dialog button', { hasText: 'Edit' });
    this.deleteButton = page.locator('lv-remote-dialog button', { hasText: 'Delete' });
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.nameInput.fill(name);
    await this.urlInput.fill(url);
    await this.addButton.click();
  }

  async editRemote(name: string, newUrl: string): Promise<void> {
    await this.remoteList.locator(`text=${name}`).click();
    await this.editButton.click();
    await this.urlInput.fill(newUrl);
    await this.addButton.click();
  }

  async deleteRemote(name: string): Promise<void> {
    await this.remoteList.locator(`text=${name}`).click();
    await this.deleteButton.click();
  }

  async getRemoteCount(): Promise<number> {
    return this.page.locator('lv-remote-dialog .remote-item').count();
  }
}

/**
 * Submodule Dialog Page Object
 */
export class SubmoduleDialogPage extends BaseDialog {
  readonly submoduleList: Locator;
  readonly urlInput: Locator;
  readonly pathInput: Locator;
  readonly addButton: Locator;
  readonly updateButton: Locator;
  readonly removeButton: Locator;

  constructor(page: Page) {
    super(page, 'lv-submodule-dialog');
    this.submoduleList = page.locator('lv-submodule-dialog .submodule-list, lv-submodule-dialog .submodule-item');
    this.urlInput = page.locator('lv-submodule-dialog input').first();
    this.pathInput = page.locator('lv-submodule-dialog input').nth(1);
    this.addButton = page.locator('lv-submodule-dialog .btn-primary, lv-submodule-dialog button', { hasText: 'Add' });
    this.updateButton = page.locator('lv-submodule-dialog button', { hasText: 'Update' });
    this.removeButton = page.locator('lv-submodule-dialog button', { hasText: 'Remove' });
  }

  async addSubmodule(url: string, path: string): Promise<void> {
    await this.urlInput.fill(url);
    await this.pathInput.fill(path);
    await this.addButton.click();
  }

  async updateSubmodule(name: string): Promise<void> {
    await this.submoduleList.locator(`text=${name}`).click();
    await this.updateButton.click();
  }

  async removeSubmodule(name: string): Promise<void> {
    await this.submoduleList.locator(`text=${name}`).click();
    await this.removeButton.click();
  }

  async getSubmoduleCount(): Promise<number> {
    return this.page.locator('lv-submodule-dialog .submodule-item').count();
  }
}

/**
 * Repository Health Dialog Page Object
 */
export class RepositoryHealthDialogPage extends BaseDialog {
  readonly statCards: Locator;
  readonly gcButton: Locator;
  readonly aggressiveGcButton: Locator;
  readonly fsckButton: Locator;
  readonly pruneButton: Locator;
  readonly doneButton: Locator;
  readonly recommendations: Locator;

  constructor(page: Page) {
    super(page, 'lv-repository-health-dialog');
    this.statCards = page.locator('lv-repository-health-dialog .stat-card');
    this.gcButton = page.locator('lv-repository-health-dialog button', { hasText: 'Run GC' });
    this.aggressiveGcButton = page.locator('lv-repository-health-dialog button', { hasText: 'Aggressive' });
    this.fsckButton = page.locator('lv-repository-health-dialog button', { hasText: 'Check' });
    this.pruneButton = page.locator('lv-repository-health-dialog button', { hasText: 'Prune' });
    this.doneButton = page.locator('lv-repository-health-dialog button', { hasText: 'Done' });
    this.recommendations = page.locator('lv-repository-health-dialog .recommendation');
  }

  async runGc(): Promise<void> {
    await this.gcButton.click();
  }

  async runFsck(): Promise<void> {
    await this.fsckButton.click();
  }

  async runPrune(): Promise<void> {
    await this.pruneButton.click();
  }

  async close(): Promise<void> {
    await this.doneButton.click();
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async getStatValue(label: string): Promise<string> {
    const card = this.statCards.filter({ hasText: label });
    return (await card.locator('.stat-value').textContent()) ?? '';
  }
}

/**
 * Dialogs Page Object - Factory for all dialogs
 */
export class DialogsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get clone(): CloneDialogPage {
    return new CloneDialogPage(this.page);
  }

  get init(): InitDialogPage {
    return new InitDialogPage(this.page);
  }

  get createBranch(): CreateBranchDialogPage {
    return new CreateBranchDialogPage(this.page);
  }

  get settings(): SettingsDialogPage {
    return new SettingsDialogPage(this.page);
  }

  get profileManager(): ProfileManagerDialogPage {
    return new ProfileManagerDialogPage(this.page);
  }

  get github(): GitHubDialogPage {
    return new GitHubDialogPage(this.page);
  }

  get gitlab(): GitLabDialogPage {
    return new GitLabDialogPage(this.page);
  }

  get azureDevOps(): AzureDevOpsDialogPage {
    return new AzureDevOpsDialogPage(this.page);
  }

  get bitbucket(): BitbucketDialogPage {
    return new BitbucketDialogPage(this.page);
  }

  get keyboardShortcuts(): KeyboardShortcutsDialogPage {
    return new KeyboardShortcutsDialogPage(this.page);
  }

  get commandPalette(): CommandPalettePage {
    return new CommandPalettePage(this.page);
  }

  get config(): ConfigDialogPage {
    return new ConfigDialogPage(this.page);
  }

  get reflog(): ReflogDialogPage {
    return new ReflogDialogPage(this.page);
  }

  get remote(): RemoteDialogPage {
    return new RemoteDialogPage(this.page);
  }

  get submodule(): SubmoduleDialogPage {
    return new SubmoduleDialogPage(this.page);
  }

  get repositoryHealth(): RepositoryHealthDialogPage {
    return new RepositoryHealthDialogPage(this.page);
  }
}
