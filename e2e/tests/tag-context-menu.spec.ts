import { test, expect, type Locator } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { LeftPanelPage } from '../pages/panels.page';
import {
  startCommandCaptureWithMocks,
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

/**
 * Click a context menu item via JavaScript to avoid viewport boundary issues.
 * The tag list context menu uses position:fixed and may extend beyond the viewport
 * when tags are near the bottom of the sidebar.
 */
async function clickMenuItem(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).click());
}

test.describe('Tag List Context Menu', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    // Use tags all within v1.x so they fall into a single group (no group headers)
    // This keeps the tag list compact and avoids context menus going off-viewport
    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
        {
          name: 'v1.1.0',
          targetOid: 'def456',
          message: 'Release v1.1.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
        {
          name: 'v1.2.0-beta',
          targetOid: 'ghi789',
          message: null,
          tagger: null,
          isAnnotated: false,
        },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
      checkout_with_autostash: { success: true, message: 'Switched to tag' },
    });
  });

  test('should display tags after expanding section', async ({ page }) => {
    await leftPanel.expandTags();

    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(3);
  });

  test('should open context menu on right-click', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).toBeVisible();
  });

  test('should show Checkout option in context menu', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const checkoutOption = page.locator('.context-menu-item, .menu-item', { hasText: /checkout/i });
    await expect(checkoutOption).toBeVisible();
  });

  test('should show Delete option in context menu', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
  });

  test('should show Push option in context menu', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
  });

  test('push menu item names the destination remote', async ({ page }) => {
    // "Push to Remote" named no destination and always meant origin. With a
    // single remote the item says where the tag actually goes.
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    // hasText regex matches raw textContent (the button wraps an svg), so no anchors.
    const pushOption = page.locator('.context-menu-item', { hasText: /Push to origin/ });
    await expect(pushOption).toBeVisible();
  });

  test('should close context menu after clicking Checkout', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const checkoutOption = page.locator('.context-menu-item, .menu-item', { hasText: /checkout/i });
    await expect(checkoutOption).toBeVisible();
    await clickMenuItem(checkoutOption);

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke checkout command for tag', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const checkoutOption = page.locator('.context-menu-item, .menu-item', { hasText: /checkout/i });
    await expect(checkoutOption).toBeVisible();
    await clickMenuItem(checkoutOption);

    const checkoutCommands = await findCommand(page, 'checkout_with_autostash');
    expect(checkoutCommands.length).toBeGreaterThan(0);
  });

  test('should close context menu after clicking Delete', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke delete_tag command', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    const deleteCommands = await findCommand(page, 'delete_tag');
    expect(deleteCommands.length).toBeGreaterThan(0);

    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(2);
  });

  test('should close context menu after clicking Push', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke push_tag command', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    await waitForCommand(page, 'push_tag');
    const pushCommands = await findCommand(page, 'push_tag');
    expect(pushCommands.length).toBeGreaterThan(0);
  });

  test('should show Create Tag Here option', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).toBeVisible();

    const createTagOption = page.locator('.context-menu-item, .menu-item', { hasText: /create tag here/i });
    await expect(createTagOption.first()).toBeVisible();
  });

  test('context menu should close when clicking elsewhere', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).toBeVisible();

    await page.locator('body').click({ position: { x: 10, y: 10 } });

    await expect(contextMenu).not.toBeVisible();
  });

  test('context menu should close and reopen when right-clicking a different tag', async ({ page }) => {
    await leftPanel.expandTags();

    // Right-click first tag to open the context menu
    const tag1 = leftPanel.getTag('v1.0.0');
    await tag1.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).toBeVisible();

    // Close the context menu first by clicking elsewhere
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(contextMenu).not.toBeVisible();

    // Right-click a different tag - a new context menu should appear
    const tag2 = leftPanel.getTag('v1.1.0');
    await tag2.click({ button: 'right' });

    await expect(contextMenu).toBeVisible();
  });

  test('should pass correct tag name to delete command', async ({ page }) => {
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.2.0-beta');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    const deleteCommands = await findCommand(page, 'delete_tag');
    expect(deleteCommands.length).toBeGreaterThan(0);
    const args = deleteCommands[0].args as { name?: string; tagName?: string };
    expect(args?.name || args?.tagName).toContain('v1.2.0-beta');
  });
});

test.describe('Tag Context Menu - Event Propagation', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
    });

    await injectCommandMock(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
      checkout_with_autostash: { success: true, message: 'Switched to tag' },
    });
  });

  test('should dispatch tag-checkout event after tag checkout', async ({ page }) => {
    // Listen for tag-checkout event (the component dispatches this, not repository-changed)
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('tag-checkout', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 3000);
      });
    });

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const checkoutOption = page.locator('.context-menu-item, .menu-item', { hasText: /checkout/i });
    await expect(checkoutOption).toBeVisible();
    await clickMenuItem(checkoutOption);

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);
  });

  test('should successfully delete tag and update UI', async ({ page }) => {
    await startCommandCapture(page);

    await leftPanel.expandTags();

    // Verify tag is present before deletion
    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(1);

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    // Verify the delete_tag command was invoked
    const deleteCommands = await findCommand(page, 'delete_tag');
    expect(deleteCommands.length).toBeGreaterThan(0);
    const args = deleteCommands[0].args as { name?: string; tagName?: string };
    expect(args?.name || args?.tagName).toBe('v1.0.0');

    // Verify the tag was removed from the UI
    // After deletion with 0 tags remaining, the tag list section collapses
    await expect(leftPanel.tagItems).toHaveCount(0);
  });

  test('deleting a pushed tag also offers to delete it on the remote', async ({ page }) => {
    // delete_tag only removes the local ref, and the tag fetch refspec
    // (refs/tags/*:refs/tags/*) copies the remote's copy straight back — so
    // without the follow-up the "deleted" tag returns on the next fetch.
    await startCommandCapture(page);

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    await waitForCommand(page, 'delete_remote_tag');
    const remoteDeletes = await findCommand(page, 'delete_remote_tag');
    expect(remoteDeletes.length).toBeGreaterThan(0);
    const args = remoteDeletes[0].args as { name?: string; remote?: string };
    expect(args?.name).toBe('v1.0.0');
    expect(args?.remote).toBe('origin');

    await expect(page.locator('.toast', { hasText: 'Deleted tag v1.0.0 on origin' })).toBeVisible();
  });
});

test.describe('Tag Context Menu - Error Handling', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    // Use only v1.x tags for single group (no group headers, compact layout)
    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
        {
          name: 'v1.1.0',
          targetOid: 'def456',
          message: 'Release v1.1.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
    });
  });

  test('should show error toast when push_tag fails', async ({ page }) => {
    await injectCommandError(page, 'push_tag', 'Push failed: remote rejected');

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    // Push-tag failures now route through the suggestion service, like every
    // other push surface: the server's own words are shown (or a recovery
    // suggestion when one matches), rather than a "Failed to push tag:" prefix.
    const toast = page.locator('gn-toast-container .toast');
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText('remote rejected');
  });

  test('should show error toast when delete_tag fails', async ({ page }) => {
    await injectCommandMock(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await injectCommandError(page, 'delete_tag', 'Delete failed: tag is protected');

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    // The component calls showToast which adds to the UI store, rendered by gn-toast-container
    const toast = page.locator('gn-toast-container .toast');
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText('delete tag');
  });

  test('should keep tag list unchanged after push failure', async ({ page }) => {
    await injectCommandError(page, 'push_tag', 'Push failed: no remote');

    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(2);
  });

  test('should dispatch tag-pushed event after successful push', async ({ page }) => {
    // Listen for tag-pushed event (the component dispatches this, not repository-changed)
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('tags-changed', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 3000);
      });
    });

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);
  });

  test('should invoke push_tag with correct tag name', async ({ page }) => {
    await startCommandCapture(page);

    await leftPanel.expandTags();
    const tag = leftPanel.getTag('v1.1.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    await waitForCommand(page, 'push_tag');
    const pushCommands = await findCommand(page, 'push_tag');
    expect(pushCommands.length).toBeGreaterThan(0);
    const args = pushCommands[0].args as { name?: string; tagName?: string };
    expect(args?.name || args?.tagName).toContain('v1.1.0');
  });
});

test.describe('Tag Context Menu - UI Outcome Verification', () => {
  let leftPanel: LeftPanelPage;

  test('checkout tag: verify current branch indicator changes to detached HEAD', async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
      checkout_with_autostash: { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'Switched to tag' },
    });

    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const checkoutOption = page.locator('.context-menu-item, .menu-item', { hasText: /checkout/i });
    await expect(checkoutOption).toBeVisible();
    await clickMenuItem(checkoutOption);

    // Verify the checkout_with_autostash command was invoked
    const checkoutCommands = await findCommand(page, 'checkout_with_autostash');
    expect(checkoutCommands.length).toBeGreaterThan(0);

    // After checking out a tag, the branch list should reflect the change.
    // The tag-checkout event fires, triggering a UI refresh.
    // Verify the context menu is closed (operation completed).
    const contextMenu = page.locator('.context-menu, .tag-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('error toast: verify specific error message text on push_tag failure', async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
    });

    // Inject a specific error message for push_tag
    await injectCommandError(page, 'push_tag', 'Authentication failed: invalid credentials for remote origin');

    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item, .menu-item', { hasText: /push/i });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    // An auth failure matches a suggestion, so the user gets the actionable
    // wording plus an Open Settings button instead of the raw string.
    const toast = page.locator('gn-toast-container .toast');
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText(/authentication failed/i);

    // The tag list should remain unchanged after the failed operation
    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(1);
  });

  test('error toast: verify specific error message text on delete_tag failure', async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
    });

    // Set up dialog confirmation mocks and inject a specific delete error
    await injectCommandMock(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
    await injectCommandError(page, 'delete_tag', 'Tag is protected and cannot be deleted');

    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const deleteOption = page.locator('.context-menu-item, .menu-item', { hasText: /delete/i });
    await expect(deleteOption).toBeVisible();
    await clickMenuItem(deleteOption);

    // Verify the error toast appears
    const toast = page.locator('gn-toast-container .toast');
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText('delete tag');

    // Tag should still be present since the operation failed
    const tagCount = await leftPanel.getTagCount();
    expect(tagCount).toBe(1);
  });
});

test.describe('Tag Context Menu - Push destination', () => {
  let leftPanel: LeftPanelPage;

  test.beforeEach(async ({ page }) => {
    leftPanel = new LeftPanelPage(page);

    await setupOpenRepository(page, {
      tags: [
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: 'Release v1.0.0',
          tagger: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
          isAnnotated: true,
        },
      ],
      remotes: [
        { name: 'origin', url: 'https://github.com/test/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/upstream/repo.git', pushUrl: null },
      ],
    });

    await startCommandCapture(page);
  });

  test('a fork checkout is asked which remote the tag goes to', async ({ page }) => {
    // origin + upstream: silently picking origin is how a fork's tag ends up
    // on the canonical repo, so the menu asks instead.
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    const pushOption = page.locator('.context-menu-item', { hasText: /Push to Remote/ });
    await expect(pushOption).toBeVisible();
    await clickMenuItem(pushOption);

    const upstreamChoice = page.locator('.push-remote-item', { hasText: /^\s*upstream\s*$/ });
    await expect(upstreamChoice).toBeVisible();
    await clickMenuItem(upstreamChoice);

    await waitForCommand(page, 'push_tag');
    const pushCommands = await findCommand(page, 'push_tag');
    expect(pushCommands.length).toBe(1);
    const args = pushCommands[0].args as { name?: string; remote?: string };
    expect(args.name).toBe('v1.0.0');
    expect(args.remote).toBe('upstream');

    const toast = page.locator('gn-toast-container .toast');
    await expect(toast.first()).toContainText('Pushed tag v1.0.0 to upstream');
  });

  test('the force retry goes back to the remote the rejected push was aimed at', async ({
    page,
  }) => {
    // The rejected push was aimed at upstream. A retry that re-resolved the
    // destination would force-move the tag on origin — a destructive write to
    // the canonical repo — and report it as success.
    await autoConfirmDialogs(page);
    await injectCommandError(page, 'push_tag', 'cannot push non-fastforwardable reference');
    await leftPanel.expandTags();

    const tag = leftPanel.getTag('v1.0.0');
    await tag.click({ button: 'right' });

    await clickMenuItem(page.locator('.context-menu-item', { hasText: /Push to Remote/ }));
    await clickMenuItem(page.locator('.push-remote-item', { hasText: /^\s*upstream\s*$/ }));

    const forceAction = page.locator('gn-toast-container .toast button', {
      hasText: /Force Push Tag/,
    });
    await expect(forceAction).toBeVisible();
    await forceAction.click();

    await page.waitForFunction(
      () =>
        ((window as unknown as { __INVOKED_COMMANDS__?: { command: string }[] })
          .__INVOKED_COMMANDS__ ?? []).filter((c) => c.command === 'push_tag').length === 2
    );
    const pushCommands = await findCommand(page, 'push_tag');
    const retry = pushCommands[1].args as { remote?: string; force?: boolean };
    expect(retry.force).toBe(true);
    expect(retry.remote).toBe('upstream');
  });
});
