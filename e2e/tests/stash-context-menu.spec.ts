import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { LeftPanelPage } from '../pages/panels.page';
import {
  startCommandCaptureWithMocks,
  startCommandCapture,
  findCommand,
  injectCommandError,
  injectCommandMock,
  waitForRepositoryChanged,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

test.describe('Stash List Context Menu', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
        { index: 1, message: 'WIP on feature: def456 second stash', oid: 'stash2' },
        { index: 2, message: 'WIP on develop: ghi789 third stash', oid: 'stash3' },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('should display stash items', async ({ page }) => {
    await leftPanel.expandStashes();

    const stashCount = await leftPanel.getStashCount();
    expect(stashCount).toBe(3);
  });

  test('should open context menu on right-click', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .stash-context-menu');
    await expect(contextMenu).toBeVisible();
  });

  test('should show Apply option in context menu', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
  });

  test('should show Pop option in context menu', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
    await expect(popOption).toBeVisible();
  });

  test('should show Drop option in context menu', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop|delete/i });
    await expect(dropOption).toBeVisible();
  });

  test('should close context menu after clicking Apply', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    const contextMenu = page.locator('.context-menu, .stash-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke apply_stash command', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    const applyCommands = await findCommand(page, 'apply_stash');
    expect(applyCommands.length).toBeGreaterThan(0);
  });

  test('should close context menu after clicking Pop', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
    await expect(popOption).toBeVisible();
    await popOption.click();

    const contextMenu = page.locator('.context-menu, .stash-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke pop_stash command', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
    await expect(popOption).toBeVisible();
    await popOption.click();

    const popCommands = await findCommand(page, 'pop_stash');
    expect(popCommands.length).toBeGreaterThan(0);

    const stashCount = await leftPanel.getStashCount();
    expect(stashCount).toBe(2);
  });

  test('should close context menu after clicking Drop', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop|delete/i });
    await expect(dropOption).toBeVisible();
    await dropOption.click();

    const contextMenu = page.locator('.context-menu, .stash-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke drop_stash command', async ({ page }) => {
    await leftPanel.expandStashes();

    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop|delete/i });
    await expect(dropOption).toBeVisible();
    await dropOption.click();

    const dropCommands = await findCommand(page, 'drop_stash');
    expect(dropCommands.length).toBeGreaterThan(0);

    const stashCount = await leftPanel.getStashCount();
    expect(stashCount).toBe(2);
  });

  test('should pass correct stash index to commands', async ({ page }) => {
    await leftPanel.expandStashes();

    const secondStash = leftPanel.getStash(1);
    await secondStash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    const applyCommands = await findCommand(page, 'apply_stash');
    expect(applyCommands.length).toBeGreaterThan(0);
    expect((applyCommands[0]?.args as { index?: number })?.index).toBe(1);
  });
});

test.describe('Stash Context Menu - Event Propagation', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
      ],
    });

    await injectCommandMock(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('should dispatch repository-changed event after stash apply', async ({ page }) => {
    await leftPanel.expandStashes();

    const eventReceived = await waitForRepositoryChanged(page, async () => {
      const stash = leftPanel.getStash(0);
      await stash.click({ button: 'right' });

      const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
      await expect(applyOption).toBeVisible();
      await applyOption.click();
    });

    expect(eventReceived).toBe(true);
  });

  test('should dispatch repository-changed event after stash pop', async ({ page }) => {
    await leftPanel.expandStashes();

    const eventReceived = await waitForRepositoryChanged(page, async () => {
      const stash = leftPanel.getStash(0);
      await stash.click({ button: 'right' });

      const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
      await expect(popOption).toBeVisible();
      await popOption.click();
    });

    expect(eventReceived).toBe(true);
  });

  test('should dispatch repository-changed event after stash drop', async ({ page }) => {
    await leftPanel.expandStashes();

    const eventReceived = await waitForRepositoryChanged(page, async () => {
      const stash = leftPanel.getStash(0);
      await stash.click({ button: 'right' });

      const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop/i });
      await expect(dropOption).toBeVisible();
      await dropOption.click();
    });

    expect(eventReceived).toBe(true);
  });
});

test.describe('Stash Context Menu - Error Handling', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
      ],
    });
  });

  test('should show error toast when apply_stash fails', async ({ page }) => {
    // A GENUINE failure, not a conflict. A conflicting apply is classified
    // separately now (the stash content lands in the working tree, so it warns
    // rather than erroring) — see the conflict test below. The old message here
    // contained the word "conflicts" and so exercised that path instead of this
    // one, which is what the test name claims to cover.
    await injectCommandError(page, 'apply_stash', 'Apply failed: could not read stash entry');

    await leftPanel.expandStashes();
    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    const errorToast = page.locator('gn-toast-container .toast.error').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('Apply failed');
  });

  test('should show error toast when pop_stash fails', async ({ page }) => {
    await injectCommandError(page, 'pop_stash', 'Pop failed: working directory not clean');

    // Mock the Tauri confirm dialog used by showConfirm() in handlePopStash
    await autoConfirmDialogs(page);

    await leftPanel.expandStashes();
    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
    await expect(popOption).toBeVisible();
    await popOption.click();

    const errorToast = page.locator('gn-toast-container .toast.error').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('Pop failed');
  });

  test('should show error toast when drop_stash fails', async ({ page }) => {
    await injectCommandMock(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await injectCommandError(page, 'drop_stash', 'Drop failed: stash not found');

    await leftPanel.expandStashes();
    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop|delete/i });
    await expect(dropOption).toBeVisible();
    await dropOption.click();

    const errorToast = page.locator('gn-toast-container .toast.error').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('Drop failed');
  });

  test('should keep stash list unchanged after apply failure', async ({ page }) => {
    await injectCommandError(page, 'apply_stash', 'Apply failed: conflicts');

    await leftPanel.expandStashes();

    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    const stashCount = await leftPanel.getStashCount();
    expect(stashCount).toBe(1);
  });

  test('should verify drop triggers get_stashes refresh on success', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await leftPanel.expandStashes();
    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const dropOption = page.locator('.context-menu-item, .menu-item', { hasText: /drop|delete/i });
    await expect(dropOption).toBeVisible();
    await dropOption.click();

    const stashCommands = await findCommand(page, 'get_stashes');
    expect(stashCommands.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Extended Tests - Additional Coverage
// ============================================================================

test.describe('Stash Context Menu - Extended Tests', () => {
  let leftPanel: LeftPanelPage;

  test('apply with CONFLICT reports that the stash landed and needs resolving', async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
        { index: 1, message: 'WIP on feature: def456 second stash', oid: 'stash2' },
      ],
    });

    await injectCommandError(page, 'apply_stash', 'CONFLICT (content): Merge conflict in src/main.ts');
    // The conflicting apply opens the resolution dialog, which loads the
    // conflict list. Unmocked, that load fails and raises its OWN error toast —
    // a fixture gap that would mask the assertion below.
    await injectCommandMock(page, {
      get_conflicts: [{ path: 'src/main.ts', ours: 'a', theirs: 'b', ancestor: null }],
    });

    await leftPanel.expandStashes();
    const stash = leftPanel.getStash(0);
    await stash.click({ button: 'right' });

    const applyOption = page.locator('.context-menu-item, .menu-item', { hasText: /apply/i });
    await expect(applyOption).toBeVisible();
    await applyOption.click();

    // A conflict is not a failure: the stash content DID land in the working
    // tree and the resolution dialog is about to open. A red toast beside it
    // reads as "nothing happened" — the same reason pull, the dashboard and
    // every auto-stash path warn instead.
    const warnToast = page.locator('gn-toast-container .toast.warning').first();
    await expect(warnToast).toBeVisible({ timeout: 5000 });
    await expect(warnToast).toContainText(/applied/i);
    await expect(page.locator('gn-toast-container .toast.error')).toHaveCount(0);

    // Apply (unlike pop) keeps the entry, so the list is unchanged.
    const stashCount = await leftPanel.getStashCount();
    expect(stashCount).toBe(2);
  });

  test('pop should remove stash from the list on success', async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
        { index: 1, message: 'WIP on feature: def456 second stash', oid: 'stash2' },
        { index: 2, message: 'WIP on develop: ghi789 third stash', oid: 'stash3' },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await leftPanel.expandStashes();

    // Verify initial count is 3
    const initialCount = await leftPanel.getStashCount();
    expect(initialCount).toBe(3);

    // Pop the first stash
    const firstStash = leftPanel.getStash(0);
    await firstStash.click({ button: 'right' });

    const popOption = page.locator('.context-menu-item, .menu-item', { hasText: /pop/i });
    await expect(popOption).toBeVisible();
    await popOption.click();

    // Verify pop_stash command was called
    const popCommands = await findCommand(page, 'pop_stash');
    expect(popCommands.length).toBeGreaterThan(0);

    // Verify the stash count decreased to 2
    const finalCount = await leftPanel.getStashCount();
    expect(finalCount).toBe(2);
  });
});

test.describe('Stash Contents Preview', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
        { index: 1, message: 'WIP on feature: def456 second stash', oid: 'stash2' },
        { index: 2, message: 'WIP on develop: ghi789 third stash', oid: 'stash3' },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('clicking a stash reveals its file list', async ({ page }) => {
    await leftPanel.expandStashes();

    await injectCommandMock(page, {
      stash_show: {
        index: 0,
        oid: 'stash1',
        message: 'WIP on main',
        files: [{ path: 'src/app.ts', additions: 4, deletions: 2, status: 'modified' }],
        totalAdditions: 4,
        totalDeletions: 2,
        patch: null,
      },
    });

    await leftPanel.getStash(0).click();

    await expect(leftPanel.stashDetails).toBeVisible();
    await expect(page.locator('.stash-file-path')).toHaveText('src/app.ts');

    const showCommands = await findCommand(page, 'stash_show');
    expect(showCommands.length).toBeGreaterThan(0);
  });

  test('clicking the stash again hides its file list', async ({ page }) => {
    await leftPanel.expandStashes();

    await leftPanel.getStash(0).click();
    await expect(leftPanel.stashDetails).toBeVisible();

    await leftPanel.getStash(0).click();
    await expect(leftPanel.stashDetails).toHaveCount(0);
  });

  test('a failed read shows an inline error, not a blank box', async ({ page }) => {
    await leftPanel.expandStashes();

    await injectCommandError(page, 'stash_show', 'Stash entry 0 not found');

    await leftPanel.getStash(0).click();

    await expect(page.locator('.stash-details-error')).toContainText('Stash entry 0 not found');
  });

  test('Show Contents in the context menu opens the preview', async ({ page }) => {
    await leftPanel.expandStashes();

    await leftPanel.getStash(0).click({ button: 'right' });

    const showOption = page.locator('.context-menu-item', { hasText: /show contents/i });
    await expect(showOption).toBeVisible();
    await showOption.click();

    await expect(leftPanel.stashDetails).toBeVisible();
  });
});

test.describe('Stash creation', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      stashes: [
        { index: 0, message: 'WIP on main: abc123 first stash', oid: 'stash1' },
        { index: 1, message: 'WIP on feature: def456 second stash', oid: 'stash2' },
        { index: 2, message: 'WIP on develop: ghi789 third stash', oid: 'stash3' },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      create_stash: { index: 0, message: 'On main: fix parser', oid: 'stash-new' },
    });
  });

  // Without a message every stash falls back to git's "WIP on <branch>: <sha>
  // <subject>" — the commit it was based on, not the stashed work — so several
  // stashes on one branch are indistinguishable before a destructive Pop/Drop.
  test('naming a stash sends the message to create_stash', async ({ page }) => {
    await leftPanel.expandStashes();

    await page.locator('gn-stash-list .stash-btn').click();

    const promptInput = page.locator('gn-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('fix parser');
    await page.locator('gn-prompt-dialog .btn-primary').click();

    await expect
      .poll(async () => (await findCommand(page, 'create_stash')).length)
      .toBe(1);

    const calls = await findCommand(page, 'create_stash');
    expect((calls[0].args as { message?: string }).message).toBe('fix parser');

    await expect(page.locator('gn-toast-container .toast.success')).toBeVisible();
  });

  test('cancelling the prompt creates no stash', async ({ page }) => {
    await leftPanel.expandStashes();
    expect(await leftPanel.getStashCount()).toBe(3);

    await page.locator('gn-stash-list .stash-btn').click();

    await expect(page.locator('gn-prompt-dialog .prompt-input')).toBeVisible();
    await page.locator('gn-prompt-dialog .btn-secondary').click();
    await expect(page.locator('gn-prompt-dialog .prompt-input')).toBeHidden();

    expect(await findCommand(page, 'create_stash')).toHaveLength(0);
    expect(await leftPanel.getStashCount()).toBe(3);
  });
});
