import type { Page, Locator } from '@playwright/test';

/**
 * Main App Page Object
 * Provides access to the main application elements and common operations
 */
export class AppPage {
  readonly page: Page;

  // Main layout containers
  readonly appShell: Locator;
  readonly toolbar: Locator;
  readonly leftPanel: Locator;
  readonly centerPanel: Locator;
  readonly rightPanel: Locator;
  readonly statusBar: Locator;

  // Welcome screen
  readonly welcomeScreen: Locator;
  readonly welcomeLogo: Locator;
  readonly welcomeTagline: Locator;

  // Welcome action buttons
  readonly openButton: Locator;
  readonly cloneButton: Locator;
  readonly initButton: Locator;
  readonly scanButton: Locator;

  // Recent repositories
  readonly recentSection: Locator;
  readonly recentItems: Locator;
  readonly clearRecentButton: Locator;

  // Dialogs
  readonly cloneDialog: Locator;
  readonly initDialog: Locator;
  readonly settingsDialog: Locator;

  // Command palette
  readonly commandPalette: Locator;
  readonly commandInput: Locator;

  constructor(page: Page) {
    this.page = page;

    // Main layout - pierce shadow DOM with locator chaining
    this.appShell = page.locator('app-shell');
    this.toolbar = page.locator('lv-toolbar');
    this.leftPanel = page.locator('lv-left-panel');
    this.centerPanel = page.locator('lv-graph-canvas');
    this.rightPanel = page.locator('lv-right-panel');
    this.statusBar = page.locator('lv-status-bar');

    // Welcome screen elements
    this.welcomeScreen = page.locator('lv-welcome');
    this.welcomeLogo = this.welcomeScreen.locator('.logo');
    this.welcomeTagline = this.welcomeScreen.locator('.tagline');

    // Welcome action buttons - use text content to identify
    this.openButton = this.welcomeScreen.locator('.action-btn', { hasText: 'Open' });
    this.cloneButton = this.welcomeScreen.locator('.action-btn', { hasText: 'Clone' });
    this.initButton = this.welcomeScreen.locator('.action-btn', { hasText: 'Init' });
    this.scanButton = this.welcomeScreen.locator('.action-btn', { hasText: 'Scan' });

    // Recent repos
    this.recentSection = this.welcomeScreen.locator('.recent-section');
    this.recentItems = this.welcomeScreen.locator('.recent-item');
    this.clearRecentButton = this.welcomeScreen.locator('.clear-btn');

    // Dialogs
    this.cloneDialog = page.locator('lv-clone-dialog');
    // More than one <lv-init-dialog> is mounted at a time: the toolbar keeps
    // its own for the Init button, and the welcome screen (no repository) or
    // app-shell (a repository open) mounts the one the scan/drop flows use. A
    // bare `lv-init-dialog` locator therefore matches all of them and trips
    // Playwright's strict mode. This resolves to the one actually on screen —
    // `open` is reflected onto the inner <lv-modal>, and the host itself has
    // no box of its own to be "visible". Its fields are slotted, so they are
    // NOT descendants of this locator: reach them through
    // `DialogsPage.init`'s role-based locators.
    this.initDialog = page.locator('lv-init-dialog lv-modal[open]');
    this.settingsDialog = page.locator('lv-settings-dialog');

    // Command palette
    this.commandPalette = page.locator('lv-command-palette');
    this.commandInput = this.commandPalette.locator('input');
  }

  /**
   * Navigate to the app
   */
  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  /**
   * Wait for the app to be ready (welcome screen or main view)
   */
  async waitForReady(): Promise<void> {
    // Wait for either welcome screen or main view to be visible
    await this.page.waitForSelector('lv-welcome, lv-graph-canvas', { timeout: 10000 });
  }

  /**
   * Check if the welcome screen is visible
   */
  async isWelcomeScreenVisible(): Promise<boolean> {
    return this.welcomeScreen.isVisible();
  }

  /**
   * Check if the main view (with repo open) is visible
   */
  async isMainViewVisible(): Promise<boolean> {
    return this.centerPanel.isVisible();
  }

  /**
   * Open the command palette with keyboard shortcut
   */
  async openCommandPalette(): Promise<void> {
    await this.page.keyboard.press('Meta+p');
    await this.commandPalette.waitFor({ state: 'visible' });
  }

  /**
   * Close the command palette
   */
  async closeCommandPalette(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.commandPalette.waitFor({ state: 'hidden' });
  }

  /**
   * Execute a command from the command palette
   */
  async executeCommand(command: string): Promise<void> {
    await this.openCommandPalette();
    await this.commandInput.fill(command);
    await this.page.keyboard.press('Enter');
  }

  /**
   * Wait for a toast/notification to appear
   */
  async waitForToast(message?: string): Promise<Locator> {
    const toast = this.page.locator('.toast');
    await toast.waitFor({ state: 'visible' });
    if (message) {
      await this.page.locator('.toast', { hasText: message }).waitFor({ state: 'visible' });
    }
    return toast;
  }

  /**
   * Open settings dialog
   */
  async openSettings(): Promise<void> {
    await this.page.keyboard.press('Meta+,');
    await this.settingsDialog.waitFor({ state: 'visible' });
  }

  /**
   * Get the page title
   */
  async getTitle(): Promise<string> {
    return this.page.title();
  }
}
