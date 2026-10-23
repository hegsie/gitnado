import type { Page, Locator } from '@playwright/test';

/**
 * Left Panel Page Object
 * Provides access to branches, stashes, and tags
 */
export class LeftPanelPage {
  readonly page: Page;
  readonly panel: Locator;

  // Section headers (for expanding/collapsing)
  readonly stashesHeader: Locator;
  readonly tagsHeader: Locator;

  // Branch list
  readonly branchList: Locator;
  readonly localBranches: Locator;
  readonly remoteBranches: Locator;
  readonly currentBranch: Locator;

  // Stash list
  readonly stashList: Locator;
  readonly stashItems: Locator;
  readonly stashDetails: Locator;

  // Tag list
  readonly tagList: Locator;
  readonly tagItems: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.locator('gn-left-panel');

    // Section headers - used to expand/collapse sections
    this.stashesHeader = page.getByText('Stashes').first();
    this.tagsHeader = page.getByText('Tags').first();

    // Branch list - use role-based selectors that work with shadow DOM
    this.branchList = page.locator('gn-branch-list');
    // Local branches are branch-item elements inside .local-section
    this.localBranches = this.branchList.locator('.local-section li.branch-item');
    // Remote branches are branch-item elements inside .group (remote groups)
    this.remoteBranches = this.branchList.locator('.group li.branch-item');
    this.currentBranch = this.branchList.locator('li.branch-item.active').first();

    // Stash list - the component itself
    this.stashList = page.locator('gn-stash-list');
    // Stash items are rendered with stash-item class
    this.stashItems = this.stashList.locator('.stash-item');
    // The inline `git stash show` preview, revealed by clicking a stash row
    this.stashDetails = this.stashList.locator('.stash-details');

    // Tag list - the component itself
    this.tagList = page.locator('gn-tag-list');
    // Tag items are rendered with tag-item class
    this.tagItems = this.tagList.locator('.tag-item');
  }

  /**
   * Expand the stashes section
   */
  async expandStashes(): Promise<void> {
    await this.stashesHeader.click();
  }

  /**
   * Expand the tags section
   */
  async expandTags(): Promise<void> {
    await this.tagsHeader.click();
  }

  /**
   * Get a branch item by name
   */
  getBranch(name: string): Locator {
    // Search within the branch list component by title attribute (shorthand name)
    return this.branchList.locator(`li.branch-item[title="${name}"]`);
  }

  /**
   * Expand a remote group (e.g., 'origin')
   */
  async expandRemote(remoteName: string): Promise<void> {
    // Wait for branch list to be visible
    await this.branchList.waitFor({ state: 'visible' });

    // Wait for branches to be loaded by checking that the "Loading branches..." text is gone.
    // Use Playwright locators which auto-pierce shadow DOM.
    const loadingIndicator = this.branchList.locator('.loading');
    await loadingIndicator.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {
      // If loading indicator was never present (already loaded), that's fine
    });

    // The component auto-expands remote groups in loadBranches().
    // Check if remote branch items are already visible using Playwright locators.
    // With shorthand names, remote branches have titles like "origin/feature-x"
    const remoteBranchItems = this.branchList.locator(`li.branch-item[title^="${remoteName}/"]`);
    const itemCount = await remoteBranchItems.count().catch(() => 0);

    if (itemCount === 0) {
      // Try clicking the group header that contains the remote name
      // Group headers have class .group-name containing the remote name text
      const groupHeader = this.branchList.locator('.group-header', { has: this.page.locator(`.group-name:text("${remoteName}")`) });
      const headerCount = await groupHeader.count();
      if (headerCount > 0) {
        await groupHeader.first().click();
      }

      // Wait for remote branch items to appear
      await remoteBranchItems.first().waitFor({ state: 'visible', timeout: 10000 });
    }
  }

  /**
   * Get a remote branch item by remote name and branch shorthand
   * @param remoteName The remote name (e.g., 'origin')
   * @param shorthand The branch shorthand without remote prefix (e.g., 'feature/my-branch')
   */
  getRemoteBranch(remoteName: string, shorthand: string): Locator {
    // Remote branches are <li> elements with title="${remoteName}/${shorthand}"
    // The title attribute contains the shorthand branch name
    return this.branchList.locator(`li.branch-item[title="${remoteName}/${shorthand}"]`);
  }

  /**
   * Click on a branch to checkout
   */
  async checkoutBranch(name: string): Promise<void> {
    await this.getBranch(name).click();
  }

  /**
   * Right-click a branch to open context menu
   */
  async openBranchContextMenu(name: string): Promise<void> {
    await this.getBranch(name).click({ button: 'right' });
  }

  /**
   * Get a stash item by index
   */
  getStash(index: number): Locator {
    return this.stashItems.nth(index);
  }

  /**
   * Get a tag by name
   */
  getTag(name: string): Locator {
    return this.tagItems.filter({ hasText: name });
  }

  /**
   * Check if panel is visible
   */
  async isVisible(): Promise<boolean> {
    return this.panel.isVisible();
  }

  /**
   * Count local branches
   */
  async getLocalBranchCount(): Promise<number> {
    return this.localBranches.count();
  }

  /**
   * Count stashes
   */
  async getStashCount(): Promise<number> {
    return this.stashItems.count();
  }

  /**
   * Count tags
   */
  async getTagCount(): Promise<number> {
    return this.tagItems.count();
  }
}

/**
 * Right Panel Page Object
 * Provides access to file status, staging, and commit
 */
export class RightPanelPage {
  readonly page: Page;
  readonly panel: Locator;

  // Tabs
  readonly changesTab: Locator;
  readonly detailsTab: Locator;
  readonly analyticsTab: Locator;

  // Analytics panel
  readonly analyticsPanel: Locator;

  // File status (Changes tab)
  readonly fileStatus: Locator;
  readonly stagedSection: Locator;
  readonly unstagedSection: Locator;
  readonly stagedFiles: Locator;
  readonly unstagedFiles: Locator;

  // Stage/unstage buttons
  readonly stageAllButton: Locator;
  readonly unstageAllButton: Locator;

  // Commit panel
  readonly commitPanel: Locator;
  readonly commitMessage: Locator;
  readonly commitButton: Locator;
  readonly aiGenerateButton: Locator;

  // Commit details (Details tab)
  readonly commitDetails: Locator;
  readonly commitSha: Locator;
  readonly commitAuthor: Locator;
  readonly commitDate: Locator;
  readonly commitFilesChanged: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.locator('gn-right-panel');

    // Tabs - use getByRole for buttons with tab-like behavior
    this.changesTab = page.getByRole('button', { name: /^Changes/ });
    this.detailsTab = page.getByRole('button', { name: 'Details' });
    this.analyticsTab = page.getByRole('button', { name: 'Analytics' });

    // Analytics panel
    this.analyticsPanel = page.locator('gn-analytics-panel');

    // File status - use accessible selectors
    this.fileStatus = page.locator('gn-file-status');
    // Staged section - look for the section containing "Staged" text
    this.stagedSection = page.locator('gn-file-status').filter({ hasText: 'Staged' });
    // Unstaged section contains "Changes" header (not to be confused with tab)
    this.unstagedSection = page.locator('gn-file-status');
    // Files are listitem elements within gn-file-status (to avoid matching left panel branches)
    this.stagedFiles = page.locator('gn-file-status').getByRole('listitem');
    this.unstagedFiles = page.locator('gn-file-status').getByRole('listitem');

    // Stage/unstage buttons - use accessible roles with exact match to avoid ambiguity
    this.stageAllButton = page.getByRole('button', { name: 'Stage all files', exact: true });
    this.unstageAllButton = page.getByRole('button', { name: 'Unstage all files', exact: true });

    // Commit panel - use getByRole for accessible elements
    this.commitPanel = page.locator('gn-commit-panel');
    this.commitMessage = page.getByRole('textbox', { name: /Summary/i });
    this.commitButton = page.getByRole('button', { name: 'Commit', exact: true });
    // AI generate button - use class selector for reliability (text varies: "Generate with AI" or "Configure AI")
    this.aiGenerateButton = page.locator('gn-commit-panel .generate-btn');

    // Commit details - gn-commit-details component
    this.commitDetails = page.locator('gn-commit-details');
    this.commitSha = this.commitDetails.locator('.commit-sha');
    this.commitAuthor = this.commitDetails.locator('.commit-author');
    this.commitDate = this.commitDetails.locator('.commit-date');
    this.commitFilesChanged = this.commitDetails.locator('.file-item');
  }

  /**
   * Switch to Changes tab
   */
  async switchToChanges(): Promise<void> {
    await this.changesTab.click();
  }

  /**
   * Switch to Details tab
   */
  async switchToDetails(): Promise<void> {
    await this.detailsTab.click();
  }

  /**
   * Switch to Analytics tab
   */
  async switchToAnalytics(): Promise<void> {
    await this.analyticsTab.click();
  }

  /**
   * Get an unstaged file by path
   */
  getUnstagedFile(path: string): Locator {
    // File items are <li> elements with title="<path>" within gn-file-status
    return this.page.locator(`gn-file-status li.file-item[title="${path}"]`);
  }

  /**
   * Get a staged file by path
   */
  getStagedFile(path: string): Locator {
    // File items are <li> elements with title="<path>" within gn-file-status
    return this.page.locator(`gn-file-status li.file-item[title="${path}"]`);
  }

  /**
   * Stage a specific file
   */
  async stageFile(path: string): Promise<void> {
    const file = this.getUnstagedFile(path);
    // Hover first to reveal the file action buttons (hidden until hover)
    await file.hover();
    await file.locator('.stage-btn, button[title="Stage"]').click();
  }

  /**
   * Unstage a specific file
   */
  async unstageFile(path: string): Promise<void> {
    const file = this.getStagedFile(path);
    // Hover first to reveal the file action buttons (hidden until hover)
    await file.hover();
    await file.locator('.unstage-btn, button[title="Unstage"]').click();
  }

  /**
   * Stage all files
   */
  async stageAll(): Promise<void> {
    await this.stageAllButton.click();
  }

  /**
   * Unstage all files
   */
  async unstageAll(): Promise<void> {
    await this.unstageAllButton.click();
  }

  /**
   * Enter commit message and commit
   */
  async commit(message: string): Promise<void> {
    await this.commitMessage.fill(message);
    await this.commitButton.click();
  }

  /**
   * Click the AI generate button
   */
  async generateCommitMessage(): Promise<void> {
    await this.aiGenerateButton.click();
  }

  /**
   * Wait for gn-file-status to finish loading before reading its counts.
   *
   * The count readers below cannot distinguish "genuinely zero" from "the
   * section has not rendered yet" — both look like an absent section — so they
   * return 0 for either. That turned a slow load into a hard assertion failure
   * rather than a retry: `expect(await getStagedCount()).toBe(2)` reads once,
   * gets 0 because the panel is still on its "Loading changes..." branch, and
   * fails permanently. Under a full-suite parallel run that is exactly what
   * happened, on a different spec each time. Settling here fixes every call
   * site at once instead of adding a wait to each of the ~57 of them.
   */
  private async waitForFileStatusSettled(): Promise<void> {
    const panel = this.page.locator('gn-file-status');
    if ((await panel.count()) === 0) return;
    await panel.locator('.loading').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {
      // Never rendered a loading state at all — nothing to wait for.
    });
  }

  /**
   * Get count of staged files
   */
  async getStagedCount(): Promise<number> {
    // The staged section has a .section-count showing the number of staged files
    // The section structure is: .section-header > .section-title "Staged" + .section-count "N"
    await this.waitForFileStatusSettled();
    try {
      const stagedSection = this.page.locator('gn-file-status .section-header:has-text("Staged")');
      const isVisible = await stagedSection.isVisible({ timeout: 1000 });
      if (!isVisible) return 0;

      // Get the count from the .section-count element
      const countText = await stagedSection.locator('.section-count').textContent();
      return parseInt(countText || '0', 10);
    } catch {
      return 0;
    }
  }

  /**
   * Get count of unstaged files
   */
  async getUnstagedCount(): Promise<number> {
    // The unstaged section shows "Changes" with a .section-count
    // When there are no files, the section might not exist
    await this.waitForFileStatusSettled();
    try {
      const changesSection = this.page.locator('gn-file-status .section-header:has-text("Changes")');
      const isVisible = await changesSection.isVisible({ timeout: 1000 });
      if (!isVisible) return 0;

      const countText = await changesSection.locator('.section-count').textContent();
      return parseInt(countText || '0', 10);
    } catch {
      return 0;
    }
  }

  /**
   * Check if commit button is enabled
   */
  async isCommitEnabled(): Promise<boolean> {
    return this.commitButton.isEnabled();
  }

  /**
   * Click on a file to open diff view
   */
  async openFileDiff(path: string): Promise<void> {
    const file = this.getUnstagedFile(path).or(this.getStagedFile(path));
    await file.click();
  }

  /**
   * Check if panel is visible
   */
  async isVisible(): Promise<boolean> {
    return this.panel.isVisible();
  }
}

/**
 * Graph Panel Page Object
 * Provides access to the commit graph canvas
 */
export class GraphPanelPage {
  readonly page: Page;
  readonly canvas: Locator;
  readonly diffOverlay: Locator;
  readonly blameOverlay: Locator;

  constructor(page: Page) {
    this.page = page;
    this.canvas = page.locator('gn-graph-canvas');
    this.diffOverlay = page.locator('gn-diff-view');
    this.blameOverlay = page.locator('gn-blame-view');
  }

  /**
   * Check if graph canvas is visible
   */
  async isVisible(): Promise<boolean> {
    return this.canvas.isVisible();
  }

  /**
   * Check if diff overlay is visible
   */
  async isDiffVisible(): Promise<boolean> {
    return this.diffOverlay.isVisible();
  }

  /**
   * Close diff overlay
   */
  async closeDiff(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.diffOverlay.waitFor({ state: 'hidden' });
  }

  /**
   * Check if blame overlay is visible
   */
  async isBlameVisible(): Promise<boolean> {
    return this.blameOverlay.isVisible();
  }

  /**
   * Close blame overlay
   */
  async closeBlame(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.blameOverlay.waitFor({ state: 'hidden' });
  }

  /**
   * Navigate commits with keyboard
   */
  async navigateDown(): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press('ArrowDown');
  }

  /**
   * Navigate commits with keyboard
   */
  async navigateUp(): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press('ArrowUp');
  }

  /**
   * Navigate to first commit
   */
  async navigateToFirst(): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press('Home');
  }

  /**
   * Navigate to last commit
   */
  async navigateToLast(): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press('End');
  }
}
