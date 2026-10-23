import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandMock,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the Git Flow Panel (gn-gitflow-panel).
 *
 * The panel renders inside the sidebar and shows:
 * - An initialization prompt when git flow is not configured
 * - Feature / Release / Hotfix sections with active items when initialized
 * - A configuration summary at the bottom
 *
 * NOTE: This component is not yet integrated into the app shell's sidebar.
 * It uses direct DOM injection because no parent component renders it in
 * the app layout. When the component is added to the sidebar (e.g., as a
 * tab in gn-left-panel), these tests should be updated to use the real
 * app flow instead of injection.
 */

/** Inject the gitflow panel component into the page and wait for it to render */
async function injectGitflowPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    // A dev-server URL resolved by Vite inside the browser, not a module
    // specifier tsc can follow. Held in a variable so static resolution does
    // not try — mapping it in tsconfig instead drags all of src/ into this
    // program under the wrong compiler options.
    const panelModule = '/src/components/sidebar/gn-gitflow-panel.ts';
    await import(panelModule);

    const existing = document.querySelector('gn-gitflow-panel');
    if (existing) existing.remove();

    const panel = document.createElement('gn-gitflow-panel') as HTMLElement & {
      repositoryPath: string;
    };
    // The app shell now renders its own gn-gitflow-panel inside the left
    // panel; scope this spec to the injected instance via a unique id so
    // shadow-piercing locators don't match both.
    panel.id = 'e2e-gitflow';
    panel.repositoryPath = '/tmp/test-repo';
    panel.style.cssText = 'display: block; width: 300px; height: 500px;';
    document.body.appendChild(panel);
  });

  // Wait for the component to finish rendering with Playwright auto-piercing locators
  await page
    .locator('gn-gitflow-panel#e2e-gitflow .init-section, gn-gitflow-panel#e2e-gitflow .section, gn-gitflow-panel#e2e-gitflow .load-error, gn-gitflow-panel#e2e-gitflow .loading')
    .first()
    .waitFor({ state: 'visible' });
}

// --------------------------------------------------------------------------
// Not Initialized
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Not Initialized', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: false,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      init_gitflow: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
      ],
    });

    await injectGitflowPanel(page);
  });

  test('should show init section when git flow is not initialized', async ({ page }) => {
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .init-section')).toBeVisible();
  });

  test('should display "Git Flow is not initialized" message', async ({ page }) => {
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .init-description')).toContainText(
      'not initialized'
    );
  });

  test('should show Initialize Git Flow button', async ({ page }) => {
    const btn = page.locator('gn-gitflow-panel#e2e-gitflow .init-section .btn-primary');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Initialize Git Flow');
  });

  test('clicking Initialize should call init_gitflow command', async ({ page }) => {
    await page.locator('gn-gitflow-panel#e2e-gitflow .init-section .btn-primary').click();

    // Wait for the command to be captured
    await expect
      .poll(async () => {
        const cmds = await findCommand(page, 'init_gitflow');
        return cmds.length;
      })
      .toBeGreaterThan(0);
  });

  test('after initialization, section headers should appear', async ({ page }) => {
    // After init_gitflow succeeds, loadConfig() re-fetches get_gitflow_config.
    // Override get_gitflow_config to return initialized config so sections render.
    await injectCommandMock(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
    });

    await page.locator('gn-gitflow-panel#e2e-gitflow .init-section .btn-primary').click();

    // Wait for section headers to appear (Feature, Release, Hotfix)
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .section-header')).toHaveCount(3, {
      timeout: 5000,
    });
  });
});

// --------------------------------------------------------------------------
// Init Failure
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Init Failure', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: false,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      init_gitflow: { __error__: 'develop branch already exists' },
      get_branches: [],
    });

    await injectGitflowPanel(page);
  });

  test('should show error message when init fails', async ({ page }) => {
    await page.locator('gn-gitflow-panel#e2e-gitflow .init-section .btn-primary').click();

    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .error-banner')).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Initialized - Section Display
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Initialized', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'feature/login-page',
          shorthand: 'feature/login-page',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat1',
          isStale: false,
        },
        {
          name: 'feature/api-update',
          shorthand: 'feature/api-update',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat2',
          isStale: false,
        },
        {
          name: 'release/1.0.0',
          shorthand: 'release/1.0.0',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'rel1',
          isStale: false,
        },
      ],
      gitflow_start_feature: {
        name: 'feature/new-feature',
        shorthand: 'feature/new-feature',
        isHead: true,
        isRemote: false,
        upstream: null,
        targetOid: 'new1',
        isStale: false,
      },
      gitflow_finish_feature: null,
    });

    await injectGitflowPanel(page);
  });

  test('should show Feature, Release, and Hotfix section headers', async ({ page }) => {
    const sectionTitles = page.locator('gn-gitflow-panel#e2e-gitflow .section-header .section-title');
    await expect(sectionTitles).toHaveCount(3);
    await expect(sectionTitles.nth(0)).toContainText('Feature');
    await expect(sectionTitles.nth(1)).toContainText('Release');
    await expect(sectionTitles.nth(2)).toContainText('Hotfix');
  });

  test('Feature section should show active feature branches with count', async ({ page }) => {
    // Feature section title should show count (2)
    const featureTitle = page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.section-title');
    await expect(featureTitle).toContainText('(2)');

    // Feature section should list 2 items
    const featureItems = page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.item');
    await expect(featureItems).toHaveCount(2);
  });

  test('each active feature should show its name, finish and squash buttons', async ({ page }) => {
    const featureSection = page.locator('gn-gitflow-panel#e2e-gitflow .section').first();
    const itemNames = featureSection.locator('.item-name');
    const finishBtns = featureSection.locator('.item-finish-btn:not(.item-squash-btn)');
    const squashBtns = featureSection.locator('.item-squash-btn');

    await expect(itemNames).toHaveCount(2);
    await expect(itemNames.nth(0)).toHaveText('login-page');
    await expect(itemNames.nth(1)).toHaveText('api-update');

    await expect(finishBtns).toHaveCount(2);
    await expect(squashBtns).toHaveCount(2);
  });

  test('Hotfix section should show empty message when no active hotfixes', async ({ page }) => {
    // Hotfix is the third section
    const hotfixSection = page.locator('gn-gitflow-panel#e2e-gitflow .section').nth(2);
    await expect(hotfixSection.locator('.empty-section')).toHaveText('No active items');
  });

  test('should show config summary with branch names at the bottom', async ({ page }) => {
    const configSummary = page.locator('gn-gitflow-panel#e2e-gitflow .config-summary');
    await expect(configSummary).toBeVisible();

    const configRows = configSummary.locator('.config-row');
    await expect(configRows).toHaveCount(5);

    // Verify specific config values
    await expect(configRows.nth(0).locator('.config-label')).toHaveText('Master:');
    await expect(configRows.nth(0).locator('.config-value')).toHaveText('main');
    await expect(configRows.nth(1).locator('.config-label')).toHaveText('Develop:');
    await expect(configRows.nth(1).locator('.config-value')).toHaveText('develop');
    await expect(configRows.nth(2).locator('.config-label')).toHaveText('Feature:');
    await expect(configRows.nth(2).locator('.config-value')).toHaveText('feature/*');
  });

  test('each section header should have a Start button', async ({ page }) => {
    const startButtons = page.locator('gn-gitflow-panel#e2e-gitflow .section-actions .action-btn');
    await expect(startButtons).toHaveCount(3);
  });
});

// --------------------------------------------------------------------------
// Section Expansion / Collapse
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Section Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'feature/test-feature',
          shorthand: 'feature/test-feature',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat1',
          isStale: false,
        },
      ],
    });

    await injectGitflowPanel(page);
  });

  test('clicking a section header should collapse the section', async ({ page }) => {
    const firstHeader = page.locator('gn-gitflow-panel#e2e-gitflow .section-header').first();
    await firstHeader.click();

    // After collapsing, the section icon should have the 'collapsed' class
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.section-icon.collapsed')
    ).toBeVisible();
  });

  test('clicking a collapsed section header should expand it again', async ({ page }) => {
    const firstHeader = page.locator('gn-gitflow-panel#e2e-gitflow .section-header').first();

    // Collapse
    await firstHeader.click();
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.section-icon.collapsed')
    ).toBeVisible();

    // Expand
    await firstHeader.click();

    // The collapsed class should be removed - section-icon without .collapsed should exist
    // and section-icon.collapsed should not
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.section-icon.collapsed')
    ).toHaveCount(0);
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.section-icon')
    ).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Operations - Feature Start & Finish
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Operations', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'feature/existing-feature',
          shorthand: 'feature/existing-feature',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat1',
          isStale: false,
        },
      ],
      gitflow_start_feature: {
        name: 'feature/new-feature',
        shorthand: 'feature/new-feature',
        isHead: true,
        isRemote: false,
        upstream: null,
        targetOid: 'new1',
        isStale: false,
      },
      gitflow_finish_feature: null,
    });

    await injectGitflowPanel(page);
  });

  test('clicking Finish on a feature should call gitflow_finish_feature', async ({ page }) => {
    await page.locator('gn-gitflow-panel#e2e-gitflow .item-finish-btn:not(.item-squash-btn)').first().click();

    await expect
      .poll(async () => {
        const cmds = await findCommand(page, 'gitflow_finish_feature');
        return cmds.length;
      })
      .toBeGreaterThan(0);
  });

  test('after finishing a feature, it should be removed from the UI list', async ({ page }) => {
    // Verify we start with 1 feature item
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .item')).toHaveCount(1);

    // Mock get_branches to return empty features after finish
    await page.evaluate(() => {
      const originalInvoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;

      const newInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_branches') {
          return [
            {
              name: 'main',
              shorthand: 'main',
              isHead: false,
              isRemote: false,
              upstream: null,
              targetOid: 'abc123',
              isStale: false,
            },
            {
              name: 'develop',
              shorthand: 'develop',
              isHead: true,
              isRemote: false,
              upstream: null,
              targetOid: 'def456',
              isStale: false,
            },
          ];
        }
        return originalInvoke(command, args);
      };

      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke = newInvoke;
    });

    await page.locator('gn-gitflow-panel#e2e-gitflow .item-finish-btn:not(.item-squash-btn)').first().click();

    // After finishing, the feature should be removed and empty message shown
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .section').first().locator('.empty-section')).toHaveText(
      'No active items'
    );
  });

  test('clicking Start on Feature section should call gitflow_start_feature', async ({
    page,
  }) => {
    // Click the Start button in the Feature section (first section-actions .action-btn)
    await page.locator('gn-gitflow-panel#e2e-gitflow .section-actions .action-btn').first().click();

    // The component uses showPrompt() which renders gn-prompt-dialog with gn-modal
    const promptInput = page.locator('gn-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible({ timeout: 3000 });
    await promptInput.fill('new-feature');

    // Click the OK/confirm button in the prompt dialog
    const confirmBtn = page.locator('gn-prompt-dialog .btn-primary');
    await confirmBtn.click();

    // Verify gitflow_start_feature was called
    await expect
      .poll(async () => {
        const cmds = await findCommand(page, 'gitflow_start_feature');
        return cmds.length;
      })
      .toBeGreaterThan(0);

    // Verify the correct name was passed
    const cmds = await findCommand(page, 'gitflow_start_feature');
    expect((cmds[0].args as { name: string }).name).toBe('new-feature');
  });
});

// --------------------------------------------------------------------------
// Operations - Finish Failure
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Finish Feature Failure', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'feature/conflict-feature',
          shorthand: 'feature/conflict-feature',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat1',
          isStale: false,
        },
      ],
      gitflow_finish_feature: { __error__: 'Merge conflict during finish' },
    });

    await injectGitflowPanel(page);
  });

  test('should show error message when finish feature fails', async ({ page }) => {
    await page.locator('gn-gitflow-panel#e2e-gitflow .item-finish-btn:not(.item-squash-btn)').first().click();

    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .error-banner')).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Operations - Release Finish Refused (version tag collision)
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Release Finish Tag Collision', () => {
  const COLLISION =
    "Tag 'v2.0.0' already exists and does not contain 'release/2.0.0'. "
    + 'Delete or rename the tag, or finish with a different version.';

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'release/2.0.0',
          shorthand: 'release/2.0.0',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'rel1',
          isStale: false,
        },
      ],
      gitflow_finish_release: { __error__: COLLISION },
    });

    await injectGitflowPanel(page);
  });

  test('should show the tag-collision error and keep the release listed', async ({ page }) => {
    const releaseSection = page.locator('gn-gitflow-panel#e2e-gitflow .section').nth(1);
    await expect(releaseSection.locator('.item-name')).toHaveText('2.0.0');

    await releaseSection.locator('.item-finish-btn:not(.item-squash-btn)').first().click();

    // Finishing a release prompts for the tag message first.
    const promptInput = page.locator('gn-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible({ timeout: 3000 });
    await page.locator('gn-prompt-dialog .btn-primary').click();

    const banner = page.locator('gn-gitflow-panel#e2e-gitflow .error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Tag 'v2.0.0' already exists");

    // The refusal is not a merge conflict — no resolution dialog.
    await expect(page.locator('gn-conflict-resolution-dialog[open]')).toHaveCount(0);

    // The release survives the refused finish.
    await expect(releaseSection.locator('.item-name')).toHaveText('2.0.0');
  });
});

// --------------------------------------------------------------------------
// Loading State
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Loading State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [],
    });
  });

  test('should call get_gitflow_config on load', async ({ page }) => {
    await injectGitflowPanel(page);

    const commands = await findCommand(page, 'get_gitflow_config');
    expect(commands.length).toBeGreaterThan(0);
  });
});


// --------------------------------------------------------------------------
// Config Load Failure
// --------------------------------------------------------------------------
// A failed get_gitflow_config must not be presented as "not initialized" —
// the Initialize button rewrites the repo's gitflow config with the defaults.
test.describe('GitFlow Panel - Config Load Failure', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { get_branches: [] });
    await injectCommandError(page, 'get_gitflow_config', 'failed to open repository');
    await injectGitflowPanel(page);
  });

  test('shows the load error instead of the initialize prompt', async ({ page }) => {
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .load-error')).toBeVisible();
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .load-error-message')
    ).toContainText('failed to open repository');
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .init-section')).toHaveCount(0);
  });

  test('Retry re-runs the config load', async ({ page }) => {
    await injectCommandMock(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'feature/x',
          shorthand: 'feature/x',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
      ],
    });

    await page.locator('gn-gitflow-panel#e2e-gitflow .load-error .btn').click();

    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .section').first()).toBeVisible();
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .section-header')).toHaveCount(3);
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .item-name')).toContainText('x');
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .load-error')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Branch Listing Failure
// --------------------------------------------------------------------------
test.describe('GitFlow Panel - Branch Listing Failure', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_gitflow_config: {
        initialized: true,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      },
      get_branches: [
        {
          name: 'main',
          shorthand: 'main',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
        {
          name: 'develop',
          shorthand: 'develop',
          isHead: true,
          isRemote: false,
          upstream: null,
          targetOid: 'def456',
          isStale: false,
        },
        {
          name: 'feature/existing-feature',
          shorthand: 'feature/existing-feature',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'feat1',
          isStale: false,
        },
      ],
    });

    await injectGitflowPanel(page);
  });

  test('should clear active items and show the error banner when the branch listing fails on repository switch', async ({
    page,
  }) => {
    // The first repo's active feature is listed.
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .item')).toHaveCount(1);

    // Switch to a repo whose config loads but whose branch listing fails. The
    // Finish buttons bind to these rows, so keeping the previous repo's items
    // would aim a Finish at the wrong repository's branch.
    await injectCommandError(page, 'get_branches', 'failed to open repository');
    await page.evaluate(() => {
      const panel = document.querySelector('gn-gitflow-panel#e2e-gitflow') as HTMLElement & {
        repositoryPath: string;
      };
      panel.repositoryPath = '/tmp/other-repo';
    });

    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .item')).toHaveCount(0);
    await expect(page.locator('gn-gitflow-panel#e2e-gitflow .error-banner')).toBeVisible();
    await expect(
      page.locator('gn-gitflow-panel#e2e-gitflow .empty-section').first()
    ).toHaveText('No active items');
  });
});
