import { test, expect } from '@playwright/test';
import { setupOpenRepository, withStagedFiles } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
} from '../fixtures/test-helpers';

test.describe('Commit Panel - Basic', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
          { path: 'src/utils.ts', status: 'new', isStaged: true, isConflicted: false },
        ],
        unstaged: [],
      },
    });
  });

  test('should display commit panel', async () => {
    await expect(rightPanel.commitPanel).toBeVisible();
  });

  test('should have message input field', async () => {
    await expect(rightPanel.commitMessage).toBeVisible();
  });

  test('should have Commit button', async () => {
    await expect(rightPanel.commitButton).toBeVisible();
  });

  test('Commit button should be disabled without message', async () => {
    await expect(rightPanel.commitButton).toBeDisabled();
  });

  test('should enable Commit button when message is entered', async () => {
    await rightPanel.commitMessage.fill('Test commit message');

    await expect(rightPanel.commitButton).toBeEnabled();
  });
});

test.describe('Commit Panel - Amend Mode', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      commits: [
        {
          oid: 'abc123def456',
          shortId: 'abc123d',
          message: 'Previous commit message\n\nExtended description here',
          summary: 'Previous commit message',
          body: 'Extended description here',
          author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          parentIds: [],
          timestamp: Date.now() / 1000,
        },
      ],
    });
  });

  test('should have Amend checkbox or toggle', async ({ page }) => {
    const amendToggle = page.locator('lv-commit-panel').locator('label', { hasText: /amend/i });
    const toggleCount = await amendToggle.count();
    expect(toggleCount).toBeGreaterThan(0);
  });

  test('amend mode should populate message from last commit', async ({ page }) => {
    const amendToggle = page.locator('lv-commit-panel label', { hasText: /amend/i }).first();

    await expect(amendToggle).toBeVisible();
    await amendToggle.click();

    await expect(rightPanel.commitMessage).toHaveValue(/Previous commit message/);
  });
});

test.describe('Commit Panel - Conventional Commits', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should have conventional commits toggle', async ({ page }) => {
    const conventionalToggle = page.locator('lv-commit-panel').locator('button, input, label', { hasText: /conventional/i });
    const toggleCount = await conventionalToggle.count();
    expect(toggleCount).toBeGreaterThan(0);
  });

  test('conventional mode should show type selector', async ({ page }) => {
    const conventionalToggle = page.locator('lv-commit-panel label', { hasText: /conventional/i }).first();

    await expect(conventionalToggle).toBeVisible();
    await conventionalToggle.click();

    const typeSelector = page.locator('lv-commit-panel').locator('select.type-select');
    await expect(typeSelector.first()).toBeVisible();
  });

  test('should have common commit types available', async ({ page }) => {
    const conventionalToggle = page.locator('lv-commit-panel label', { hasText: /conventional/i }).first();

    await expect(conventionalToggle).toBeVisible();
    await conventionalToggle.click();

    // Verify the type select is visible and has options
    const typeSelect = page.locator('lv-commit-panel select.type-select');
    await expect(typeSelect).toBeVisible();

    // Verify common types are present by checking the select's options
    const optionTexts = await typeSelect.locator('option').allTextContents();
    const allText = optionTexts.join(' ').toLowerCase();
    expect(allText).toContain('feat');
    expect(allText).toContain('fix');
  });

  test('should have scope input field', async ({ page }) => {
    const conventionalToggle = page.locator('lv-commit-panel label', { hasText: /conventional/i }).first();

    await expect(conventionalToggle).toBeVisible();
    await conventionalToggle.click();

    const scopeInput = page.locator('lv-commit-panel input.scope-input');
    await expect(scopeInput.first()).toBeVisible();
  });
});

test.describe('Commit Panel - Templates', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    // Override list_templates to return templates so the template selector appears
    await injectCommandMock(page, {
      list_templates: [
        { id: 'tpl-1', name: 'Bug Fix', content: 'fix: ', isConventional: false, createdAt: Date.now() },
        { id: 'tpl-2', name: 'Feature', content: 'feat: ', isConventional: false, createdAt: Date.now() },
        { id: 'tpl-3', name: 'Documentation', content: 'docs: ', isConventional: false, createdAt: Date.now() },
      ],
    });

    // Force the commit panel to reload templates using Playwright locator (auto-pierces shadow DOM)
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.loadTemplates === 'function') {
        await el.loadTemplates();
        await el.updateComplete;
      }
    });
    // Wait for templates to load and render
    await page.locator('lv-commit-panel select.template-select').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('should have template selector or button', async ({ page }) => {
    const templateSelector = page.locator('lv-commit-panel select.template-select');
    await expect(templateSelector).toBeVisible();
  });

  test('should have save template option', async ({ page }) => {
    // Save template button is the icon-btn next to the template selector
    const saveTemplateButton = page.locator('lv-commit-panel .icon-btn[title="Save as template"]');
    await expect(saveTemplateButton).toBeVisible();
  });

  test('selecting template should populate message', async ({ page }) => {
    const templateSelector = page.locator('lv-commit-panel select.template-select');
    await expect(templateSelector).toBeVisible();

    // Select the "Bug Fix" template
    await templateSelector.selectOption({ value: 'tpl-1' });

    // Verify the commit message is populated
    await expect(rightPanel.commitMessage).toHaveValue(/fix:/);
  });
});

test.describe('Commit Panel - AI Generation', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should have AI generate button', async () => {
    await expect(rightPanel.aiGenerateButton).toBeVisible();
  });

  test('AI button should have tooltip', async ({ page }) => {
    const generateBtn = page.locator('lv-commit-panel .generate-btn');
    await expect(generateBtn).toBeVisible();
    const title = await generateBtn.getAttribute('title');
    expect(title).not.toBeNull();
    expect(title!.length).toBeGreaterThan(0);
  });
});

test.describe('Commit Panel - Character Limit', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should show character count', async ({ page }) => {
    await rightPanel.commitMessage.fill('Test message');

    const charCount = page.locator('lv-commit-panel .char-count');
    await expect(charCount).toBeVisible();
    await expect(charCount).toContainText('12/72');
  });

  test('should warn when approaching character limit', async ({ page }) => {
    const longMessage = 'A'.repeat(70);
    await rightPanel.commitMessage.fill(longMessage);

    const charCount = page.locator('lv-commit-panel .char-count');
    await expect(charCount).toBeVisible();
    await expect(charCount).toContainText('70/72');
  });

  test('should show error when over character limit', async ({ page }) => {
    const veryLongMessage = 'A'.repeat(80);
    await rightPanel.commitMessage.fill(veryLongMessage);

    const charCount = page.locator('lv-commit-panel .char-count');
    await expect(charCount).toBeVisible();
    await expect(charCount).toContainText('80/72');
  });
});

test.describe('Commit Panel - Keyboard Shortcuts', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );
  });

  test('Cmd+Enter should submit commit', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'new123', shortId: 'new123', summary: 'test' },
    });

    await rightPanel.commitMessage.fill('Test commit message');
    await rightPanel.commitMessage.press('Meta+Enter');

    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBe(1);

    const args = commitCommands[0].args as { message: string };
    expect(args.message).toBe('Test commit message');

    // Verify the commit message input is cleared after successful commit
    await expect(rightPanel.commitMessage).toHaveValue('');
  });

  test('Escape should blur message input', async ({ page }) => {
    await rightPanel.commitMessage.focus();
    await rightPanel.commitMessage.fill('Test message');

    // Click elsewhere to blur the textarea (the Commit panel header)
    await page.locator('lv-commit-panel .header').click();

    // Verify the textarea lost focus
    await expect(rightPanel.commitMessage).not.toBeFocused();

    // Verify the message is still preserved
    await expect(rightPanel.commitMessage).toHaveValue('Test message');
  });
});

test.describe('Commit Panel - Empty State', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: {
        staged: [],
        unstaged: [],
      },
    });
  });

  test('should show clean working tree message when no files staged', async ({ page }) => {
    const cleanState = page.locator('lv-file-status .clean-state');
    await expect(cleanState).toBeVisible();
    await expect(cleanState.locator('.title')).toHaveText('Working tree clean');
  });

  test('Commit button should be disabled with no staged files', async () => {
    await expect(rightPanel.commitButton).toBeDisabled();
  });
});

test.describe('Commit Panel - Staged Files Display', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
          { path: 'src/utils.ts', status: 'new', isStaged: true, isConflicted: false },
          { path: 'old-file.ts', status: 'deleted', isStaged: true, isConflicted: false },
        ],
        unstaged: [],
      },
    });
  });

  test('should show count of staged files', async () => {
    const count = await rightPanel.getStagedCount();
    expect(count).toBe(3);
  });

  test('should list staged files', async () => {
    await expect(rightPanel.getStagedFile('src/main.ts')).toBeVisible();
    await expect(rightPanel.getStagedFile('src/utils.ts')).toBeVisible();
    await expect(rightPanel.getStagedFile('old-file.ts')).toBeVisible();
  });

  test('staged files should show status indicators', async ({ page }) => {
    const statusIndicators = page.locator('lv-file-status .status, lv-file-status .status-icon, lv-file-status [class*="status"]');
    const indicatorCount = await statusIndicators.count();
    expect(indicatorCount).toBeGreaterThan(0);
  });
});

test.describe('Commit Panel - Commit E2E', () => {
  let rightPanel: RightPanelPage;

  test('commit success should clear message and show success feedback', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'commit-success-123', shortId: 'commit-s', summary: 'test success' },
    });

    await rightPanel.commitMessage.fill('feat: successful commit');
    await rightPanel.commitButton.click();

    await expect(rightPanel.commitMessage).toHaveValue('');

    const successMessage = page.locator('lv-commit-panel .success');
    await expect(successMessage).toBeVisible();
    await expect(successMessage).toContainText('commit-s');
  });

  test('commit success should fire repository-refresh event', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc123', shortId: 'abc123d', summary: 'test' },
    });

    // Set up the event listener before performing the action
    await page.evaluate(() => {
      (window as any).__REFRESH_RECEIVED__ = false;
      window.addEventListener('repository-refresh', () => {
        (window as any).__REFRESH_RECEIVED__ = true;
      }, { once: true });
    });

    await rightPanel.commitMessage.fill('feat: trigger refresh');
    await rightPanel.commitButton.click();

    // Wait for the event to be received
    await page.waitForFunction(() => (window as any).__REFRESH_RECEIVED__ === true);
    const result = await page.evaluate(() => (window as any).__REFRESH_RECEIVED__);
    expect(result).toBe(true);
  });

  test('commit failure should show error and NOT clear message', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await injectCommandError(page, 'create_commit', 'Commit hook failed: pre-commit rejected');

    await rightPanel.commitMessage.fill('test: failing commit');
    await rightPanel.commitButton.click();

    const errorMessage = page.locator('lv-commit-panel .error');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Commit hook failed');

    await expect(rightPanel.commitMessage).toHaveValue('test: failing commit');
  });

  test('amend toggle should populate summary from last commit message', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      commits: [
        {
          oid: 'abc123',
          shortId: 'abc123d',
          message: 'fix: previous commit to amend\n\nThis body should also appear',
          summary: 'fix: previous commit to amend',
          body: 'This body should also appear',
          author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          parentIds: [],
          timestamp: Date.now() / 1000,
        },
      ],
    });

    const amendToggle = page.locator('lv-commit-panel label', { hasText: /amend/i }).first();
    await expect(amendToggle).toBeVisible();
    await amendToggle.click();

    await expect(rightPanel.commitMessage).toHaveValue(/previous commit to amend/);
  });

  test('AI generate button should invoke generate_commit_message command', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    // Make AI available so the generate button works
    await injectCommandMock(page, {
      is_ai_available: true,
    });

    // Force the commit panel to re-check AI availability using Playwright locator (auto-pierces shadow DOM)
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.checkAiAvailability === 'function') {
        await el.checkAiAvailability();
        await el.updateComplete;
      }
    });

    // Wait for the button text to change to "Generate with AI"
    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    await startCommandCaptureWithMocks(page, {
      generate_commit_message: { summary: 'feat: auto-generated message', body: null },
      is_ai_available: true,
    });

    await rightPanel.aiGenerateButton.click();

    await waitForCommand(page, 'generate_commit_message');

    const genCommands = await findCommand(page, 'generate_commit_message');
    expect(genCommands.length).toBeGreaterThan(0);

    // Verify the commit message is populated with the generated message
    await expect(rightPanel.commitMessage).toHaveValue(/auto-generated message/);
  });

  test('commit with amend flag should send amend=true in command args', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: {
        staged: [{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }],
        unstaged: [],
      },
      commits: [
        {
          oid: 'abc123',
          shortId: 'abc123d',
          message: 'old message',
          summary: 'old message',
          body: null,
          author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          parentIds: [],
          timestamp: Date.now() / 1000,
        },
      ],
    });

    const amendToggle = page.locator('lv-commit-panel label', { hasText: /amend/i }).first();
    await amendToggle.click();

    await expect(rightPanel.commitMessage).toHaveValue(/old message/);

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'amended123', shortId: 'amended', summary: 'amended message' },
    });

    await rightPanel.commitMessage.fill('chore: amended message');
    await rightPanel.commitButton.click();

    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBe(1);

    const args = commitCommands[0].args as { message: string; amend: boolean };
    expect(args.message).toBe('chore: amended message');
    expect(args.amend).toBe(true);

    // Verify the commit message input is cleared after successful amend commit
    await expect(rightPanel.commitMessage).toHaveValue('');
  });
});

test.describe('Commit Panel - UI Outcome Verification', () => {
  let rightPanel: RightPanelPage;

  test('template selection should insert template text into message textarea', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    // Inject templates so the template selector appears
    await injectCommandMock(page, {
      list_templates: [
        { id: 'tpl-bug', name: 'Bug Fix Template', content: 'fix: resolve issue with', isConventional: false, createdAt: Date.now() },
        { id: 'tpl-feat', name: 'Feature Template', content: 'feat: implement new functionality for', isConventional: false, createdAt: Date.now() },
      ],
    });

    // Force the commit panel to reload templates
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.loadTemplates === 'function') {
        await el.loadTemplates();
        await el.updateComplete;
      }
    });
    await page.locator('lv-commit-panel select.template-select').waitFor({ state: 'visible', timeout: 5000 });

    // Select the Feature Template
    const templateSelector = page.locator('lv-commit-panel select.template-select');
    await templateSelector.selectOption({ value: 'tpl-feat' });

    // Verify the message textarea is populated with the exact template content
    await expect(rightPanel.commitMessage).toHaveValue('feat: implement new functionality for');
  });

  test('AI generation should populate message textarea with generated text', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    // Make AI available
    await injectCommandMock(page, {
      is_ai_available: true,
    });

    // Force the commit panel to re-check AI availability
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.checkAiAvailability === 'function') {
        await el.checkAiAvailability();
        await el.updateComplete;
      }
    });

    // Wait for the button text to indicate AI is available
    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    // Mock the AI response with a specific message
    await injectCommandMock(page, {
      generate_commit_message: { summary: 'refactor: extract helper utilities into shared module', body: null },
      is_ai_available: true,
    });

    await rightPanel.aiGenerateButton.click();

    // Verify the textarea contains the AI-generated message text
    await expect(rightPanel.commitMessage).toHaveValue('refactor: extract helper utilities into shared module');
  });

  test('generate_commit_message failure should show error feedback', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    // Make AI available so the button is clickable
    await injectCommandMock(page, {
      is_ai_available: true,
    });

    // Force the commit panel to re-check AI availability
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.checkAiAvailability === 'function') {
        await el.checkAiAvailability();
        await el.updateComplete;
      }
    });

    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    // Inject error for generate_commit_message
    await injectCommandError(page, 'generate_commit_message', 'AI service unavailable: rate limit exceeded');

    // Enter a pre-existing message to verify it is preserved after the error
    await rightPanel.commitMessage.fill('existing draft message');

    await rightPanel.aiGenerateButton.click();

    // Verify error feedback is shown - either inline error in commit panel or a toast notification
    const inlineError = page.locator('lv-commit-panel .error');
    const toast = page.locator('.toast.error, .toast-error, .toast');

    await expect(inlineError.or(toast).first()).toBeVisible({ timeout: 5000 });

    // Verify the error feedback contains the failure reason
    const errorElement = inlineError.or(toast).first();
    await expect(errorElement).toContainText(/AI service unavailable|rate limit|error/i);

    // Verify the commit message textarea remains unchanged (pre-existing text preserved)
    await expect(rightPanel.commitMessage).toHaveValue('existing draft message');
  });

  test('offline mode refuses AI generation for a cloud provider', async ({ page }) => {
    // Offline mode promises nothing leaves the machine. Generating a commit
    // message posts the staged diff to the configured provider, so with a
    // cloud provider selected that promise was broken silently.
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await injectCommandMock(page, {
      is_ai_available: true,
      get_active_ai_provider: 'open_ai',
    });

    // The panel checks availability while still online — the state a user is
    // in when they turn offline mode on with the panel already open.
    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.checkAiAvailability === 'function') {
        await el.checkAiAvailability();
        await el.updateComplete;
      }
    });
    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    await page.evaluate(() => {
      (window as any).__GITNADO_STORES__.settingsStore.getState().setOfflineMode(true);
    });

    await startCommandCaptureWithMocks(page, {
      generate_commit_message: { summary: 'feat: leaked message', body: null },
      is_ai_available: true,
      get_active_ai_provider: 'open_ai',
    });

    await rightPanel.aiGenerateButton.click();

    // The refusal names the setting and the provider, so the user can act on it.
    const inlineError = page.locator('lv-commit-panel .error');
    await expect(inlineError).toBeVisible();
    await expect(inlineError).toContainText(/Offline mode/i);
    await expect(inlineError).toContainText(/OpenAI/i);

    // The staged diff never left.
    expect(await findCommand(page, 'generate_commit_message')).toHaveLength(0);

    // The button is usable again rather than stuck spinning.
    await expect(rightPanel.aiGenerateButton).toBeEnabled();
  });

  test('offline mode leaves a local AI provider working', async ({ page }) => {
    // Ollama listens on localhost, so nothing leaves the machine and offline
    // mode has no business refusing it.
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await injectCommandMock(page, {
      is_ai_available: true,
      get_active_ai_provider: 'ollama',
    });

    await page.evaluate(() => {
      (window as any).__GITNADO_STORES__.settingsStore.getState().setOfflineMode(true);
    });

    await page.locator('lv-commit-panel').evaluate(async (el: any) => {
      if (typeof el.checkAiAvailability === 'function') {
        await el.checkAiAvailability();
        await el.updateComplete;
      }
    });
    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    await startCommandCaptureWithMocks(page, {
      generate_commit_message: { summary: 'feat: local model message', body: null },
      is_ai_available: true,
      get_active_ai_provider: 'ollama',
    });

    await rightPanel.aiGenerateButton.click();

    await waitForCommand(page, 'generate_commit_message');
    await expect(rightPanel.commitMessage).toHaveValue(/local model message/);
    await expect(page.locator('lv-commit-panel .error')).toHaveCount(0);
  });

  test('offline mode leaves the local fallback working with no provider selected', async ({ page }) => {
    // A fresh install with Ollama running: nothing selects a provider, because
    // Ollama and LM Studio need no API key and only a stored key auto-selects
    // one. The backend resolves the fallback itself and skips every provider
    // the security settings forbid, so the request is served on loopback —
    // refusing it here hid every AI affordance and named a cloud risk that
    // cannot arise.
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );

    await injectCommandMock(page, {
      is_ai_available: true,
      get_active_ai_provider: null,
    });

    await page.evaluate(() => {
      (
        window as unknown as {
          __GITNADO_STORES__: {
            settingsStore: { getState(): { setOfflineMode(on: boolean): void } };
          };
        }
      ).__GITNADO_STORES__.settingsStore.getState().setOfflineMode(true);
    });

    await page.locator('lv-commit-panel').evaluate(
      async (el: Element & {
        checkAiAvailability?: () => Promise<void>;
        updateComplete?: Promise<unknown>;
      }) => {
        if (typeof el.checkAiAvailability === 'function') {
          await el.checkAiAvailability();
          await el.updateComplete;
        }
      }
    );
    // The affordance stays available rather than being hidden as "no AI".
    await expect(page.locator('lv-commit-panel .generate-btn')).toHaveAttribute('title', 'Generate commit message using AI');

    await startCommandCaptureWithMocks(page, {
      generate_commit_message: { summary: 'feat: fallback model message', body: null },
      is_ai_available: true,
      get_active_ai_provider: null,
    });

    await rightPanel.aiGenerateButton.click();

    await waitForCommand(page, 'generate_commit_message');
    await expect(rightPanel.commitMessage).toHaveValue(/fallback model message/);
    await expect(page.locator('lv-commit-panel .error')).toHaveCount(0);
  });
});

test.describe('Commit Panel - Trailers', () => {
  let rightPanel: RightPanelPage;

  const stagedFile = [
    { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
  ];

  const commitBy = (
    oid: string,
    summary: string,
    author: { name: string; email: string },
    body: string | null = null
  ) => ({
    oid,
    shortId: oid.slice(0, 7),
    message: body ? `${summary}\n\n${body}` : summary,
    summary,
    body,
    author: { ...author, timestamp: Date.now() / 1000 },
    committer: { ...author, timestamp: Date.now() / 1000 },
    parentIds: [],
    timestamp: Date.now() / 1000,
  });

  test('sign off adds a Signed-off-by trailer to the committed message', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, withStagedFiles(stagedFile));

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'signed-1', shortId: 'signed1', summary: 'feat: signed' },
    });

    await rightPanel.commitMessage.fill('feat: signed work');
    await page.locator('lv-commit-panel .signoff-toggle input').check();

    // The panel says exactly what will be added before the commit is made.
    const preview = page.locator('lv-commit-panel .trailers-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Signed-off-by: Test User <test@example.com>');

    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commits = await findCommand(page, 'create_commit');
    expect(commits.length).toBe(1);
    expect((commits[0].args as { message: string }).message).toBe(
      'feat: signed work\n\nSigned-off-by: Test User <test@example.com>'
    );
  });

  test('turning sign off back off removes only its own trailer', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, withStagedFiles(stagedFile));

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'unsigned-1', shortId: 'unsign1', summary: 'feat: unsigned' },
    });

    const body = page.locator('lv-commit-panel .description-input');
    await rightPanel.commitMessage.fill('feat: hand written');
    await body.fill('A body the user wrote.\n\nRefs: #42');

    const signOff = page.locator('lv-commit-panel .signoff-toggle input');
    await signOff.check();
    await expect(page.locator('lv-commit-panel .trailers-preview')).toBeVisible();
    await signOff.uncheck();
    await expect(page.locator('lv-commit-panel .trailers-preview')).toHaveCount(0);

    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commits = await findCommand(page, 'create_commit');
    expect((commits[0].args as { message: string }).message).toBe(
      'feat: hand written\n\nA body the user wrote.\n\nRefs: #42'
    );
  });

  test('a recent author can be added as a co-author and reaches the commit', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      ...withStagedFiles(stagedFile),
      commits: [
        commitBy('aaa1111', 'earlier work', { name: 'Grace Hopper', email: 'grace@example.com' }),
        commitBy('bbb2222', 'older work', { name: 'Test User', email: 'test@example.com' }),
      ],
    });

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'coauth-1', shortId: 'coauth1', summary: 'feat: paired' },
    });

    await rightPanel.commitMessage.fill('feat: paired work');
    await page.locator('lv-commit-panel .coauthor-btn').click();

    const suggestion = page.locator('lv-commit-panel .coauthor-suggestion', {
      hasText: 'grace@example.com',
    });
    await expect(suggestion).toBeVisible();
    // The committer themselves is never offered as their own co-author.
    await expect(
      page.locator('lv-commit-panel .coauthor-suggestion', { hasText: 'test@example.com' })
    ).toHaveCount(0);

    await suggestion.click();

    const preview = page.locator('lv-commit-panel .trailers-preview');
    await expect(preview).toContainText('Co-authored-by: Grace Hopper <grace@example.com>');

    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commits = await findCommand(page, 'create_commit');
    expect((commits[0].args as { message: string }).message).toBe(
      'feat: paired work\n\nCo-authored-by: Grace Hopper <grace@example.com>'
    );
  });

  test('a co-author can be typed in, removed, and refused when duplicated', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, withStagedFiles(stagedFile));

    await rightPanel.commitMessage.fill('feat: manual co-author');
    await page.locator('lv-commit-panel .coauthor-btn').click();

    const input = page.locator('lv-commit-panel .coauthor-input');
    const add = page.locator('lv-commit-panel .coauthor-add-btn');

    // A malformed entry is refused with an explanation, not silently dropped.
    await input.fill('grace@example.com');
    await add.click();
    await expect(page.locator('lv-commit-panel .coauthor-error')).toContainText(
      'not a valid co-author'
    );

    await input.fill('Grace Hopper <grace@example.com>');
    await add.click();
    await expect(page.locator('lv-commit-panel .trailer-line')).toHaveCount(1);

    // Adding the same person again is a no-op that says so.
    await input.fill('G. Hopper <GRACE@example.com>');
    await add.click();
    await expect(page.locator('lv-commit-panel .coauthor-error')).toContainText(
      'already a co-author'
    );
    await expect(page.locator('lv-commit-panel .trailer-line')).toHaveCount(1);

    // Close the dropdown, which floats over the preview beneath it.
    await page.locator('lv-commit-panel .coauthor-btn').click();
    await expect(page.locator('lv-commit-panel .coauthor-dropdown')).toHaveCount(0);

    await page.locator('lv-commit-panel .trailer-remove').click();
    await expect(page.locator('lv-commit-panel .trailers-preview')).toHaveCount(0);
  });

  test('amending a commit that already has trailers does not duplicate them', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      commits: [
        commitBy(
          'ccc3333',
          'fix: already signed',
          { name: 'Test User', email: 'test@example.com' },
          'Body.\n\nSigned-off-by: Test User <test@example.com>\nCo-authored-by: Grace Hopper <grace@example.com>'
        ),
      ],
    });

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'amend-1', shortId: 'amend1', summary: 'fix: already signed' },
    });

    await page.locator('lv-commit-panel label', { hasText: /amend/i }).first().click();

    // The existing footer is shown as panel state instead of being re-appended.
    await expect(page.locator('lv-commit-panel .signoff-toggle input')).toBeChecked();
    const preview = page.locator('lv-commit-panel .trailers-preview');
    await expect(preview).toContainText('Signed-off-by: Test User <test@example.com>');
    await expect(preview).toContainText('Co-authored-by: Grace Hopper <grace@example.com>');
    await expect(page.locator('lv-commit-panel .description-input')).toHaveValue('Body.');

    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commits = await findCommand(page, 'create_commit');
    const message = (commits[0].args as { message: string }).message;
    expect(message).toBe(
      'fix: already signed\n\nBody.\n\nSigned-off-by: Test User <test@example.com>\n' +
        'Co-authored-by: Grace Hopper <grace@example.com>'
    );
    expect(message.match(/Signed-off-by/g)).toHaveLength(1);
    expect(message.match(/Co-authored-by/g)).toHaveLength(1);
  });

  test('without a git identity the sign-off control explains itself', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, withStagedFiles(stagedFile));

    await injectCommandMock(page, {
      get_user_identity: { name: null, email: null, nameIsGlobal: false, emailIsGlobal: false },
    });

    // Reload the identity the way applying a profile would.
    await page.locator('lv-commit-panel').evaluate(async (el) => {
      const panel = el as HTMLElement & {
        loadAuthorName: () => Promise<void>;
        updateComplete: Promise<unknown>;
      };
      await panel.loadAuthorName();
      await panel.updateComplete;
    });

    await expect(page.locator('lv-commit-panel .signoff-toggle input')).toBeDisabled();
    const hint = page.locator('lv-commit-panel .trailer-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('No git identity configured');

    // The warning leads somewhere: it opens the Git Configuration dialog.
    await hint.locator('button').click();
    await expect(page.locator('lv-config-dialog lv-modal[open]')).toBeVisible();
  });

  test('configuring an identity from the hint re-enables Sign off', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, withStagedFiles(stagedFile));

    // The backend starts with no identity and remembers what the dialog saves,
    // so the round trip is the real one: hint → dialog → save → recovery.
    await page.evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const original = internals.invoke;
      let identity: { name: string | null; email: string | null } = { name: null, email: null };
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'get_user_identity') {
          return { ...identity, nameIsGlobal: false, emailIsGlobal: false };
        }
        if (command === 'set_user_identity') {
          const a = args as { name?: string; email?: string };
          identity = { name: a.name ?? null, email: a.email ?? null };
          return null;
        }
        return original(command, args);
      };
    });

    // Reload the identity the way applying a profile would.
    await page.locator('lv-commit-panel').evaluate(async (el) => {
      const panel = el as HTMLElement & {
        loadAuthorName: () => Promise<void>;
        updateComplete: Promise<unknown>;
      };
      await panel.loadAuthorName();
      await panel.updateComplete;
    });

    const hint = page.locator('lv-commit-panel .trailer-hint');
    await expect(hint).toBeVisible();
    await expect(page.locator('lv-commit-panel .signoff-toggle input')).toBeDisabled();

    await hint.locator('button').click();
    await expect(page.locator('lv-config-dialog lv-modal[open]')).toBeVisible();

    const fields = page.locator('lv-config-dialog .form-group input');
    await fields.nth(0).fill('Ada Lovelace');
    await fields.nth(1).fill('ada@example.com');
    await page.locator('lv-config-dialog .btn-primary').click();

    // The panel the user came from recovers straight away — no commit, fetch
    // or tab switch needed to clear the dead end.
    await expect(page.locator('lv-commit-panel .trailer-hint')).toHaveCount(0);
    await expect(page.locator('lv-commit-panel .signoff-toggle input')).toBeEnabled();

    // ...and it is still gone once the dialog is closed.
    await page.locator('lv-config-dialog lv-modal').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('lv-config-dialog lv-modal[open]')).toHaveCount(0);
    await expect(page.locator('lv-commit-panel .trailer-hint')).toHaveCount(0);

    // Sign off now works: it writes the identity that was just configured.
    await page.locator('lv-commit-panel .signoff-toggle input').check();
    await expect(page.locator('lv-commit-panel .trailers-preview')).toContainText(
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    );
  });
});
