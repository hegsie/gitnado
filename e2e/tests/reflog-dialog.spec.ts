import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  injectCommandHang,
  openViaCommandPalette,
  autoConfirmDialogs,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Reflog Dialog
 * Tests reflog display, context menus, and undo operations
 */

const REFLOG_ENTRIES = [
  {
    oid: 'abc123def456',
    shortId: 'abc123d',
    index: 0,
    message: 'checkout: moving from main to feature',
    action: 'checkout',
    timestamp: Date.now() / 1000,
    author: 'Test User',
  },
  {
    oid: 'def456abc789',
    shortId: 'def456a',
    index: 1,
    message: 'commit: Add feature',
    action: 'commit',
    timestamp: Date.now() / 1000 - 3600,
    author: 'Test User',
  },
  {
    oid: 'ghi789jkl012',
    shortId: 'ghi789j',
    index: 2,
    message: 'reset: moving to HEAD~1',
    action: 'reset',
    timestamp: Date.now() / 1000 - 7200,
    author: 'Test User',
  },
];

/** Open the reflog dialog via command palette and wait for it to render */
async function openReflogDialog(page: import('@playwright/test').Page): Promise<void> {
  // Settle any navigation still in flight from setup BEFORE opening the
  // dialog. Under a full parallel run a late reload landed mid-assertion —
  // Playwright logged "waiting for navigation to finish ... navigated to" —
  // which tore the dialog (and the installed Tauri mocks) down after the
  // helper had already seen it open.
  await page.waitForLoadState('domcontentloaded');
  await openViaCommandPalette(page, 'Undo');
  await page.locator('gn-reflog-dialog[open]').waitFor({ state: 'attached', timeout: 5000 });
  await expect(page.locator('gn-reflog-dialog .entry').first()).toBeAttached();
}

test.describe('Reflog Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Every reset mode is confirm-gated now, not just hard.
    await autoConfirmDialogs(page);

    await startCommandCaptureWithMocks(page, {
      get_reflog: REFLOG_ENTRIES,
      reset_to_reflog: REFLOG_ENTRIES[1],
    });

    await openReflogDialog(page);
  });

  test('should display reflog entries when dialog is opened', async ({ page }) => {
    const dialog = page.locator('gn-reflog-dialog[open]');
    await expect(dialog).toBeAttached();

    const commands = await findCommand(page, 'get_reflog');
    expect(commands.length).toBeGreaterThan(0);
  });

  test('each entry should show the commit hash', async ({ page }) => {
    const dialog = page.locator('gn-reflog-dialog[open]');
    await expect(dialog).toBeAttached();

    await expect(page.locator('gn-reflog-dialog .entry-oid').first()).toBeAttached();
    expect(await page.locator('gn-reflog-dialog .entry-oid').count()).toBeGreaterThan(0);
  });

  test('each entry should show the action message', async ({ page }) => {
    await expect(page.locator('gn-reflog-dialog .entry-message').first()).toBeAttached();
    expect(await page.locator('gn-reflog-dialog .entry-message').count()).toBeGreaterThan(0);
  });

  test('each entry should show a timestamp', async ({ page }) => {
    await expect(page.locator('gn-reflog-dialog .entry-meta').first()).toBeAttached();
    expect(await page.locator('gn-reflog-dialog .entry-meta').count()).toBeGreaterThan(0);
  });

  test('right-clicking a non-current entry should show context menu', async ({ page }) => {
    const entries = page.locator('gn-reflog-dialog .entry');
    await expect(entries).toHaveCount(3);

    await entries.nth(1).click({ button: 'right' });

    await expect(page.locator('gn-reflog-dialog .context-menu')).toBeAttached();
  });

  test('context menu should have Undo to this state option', async ({ page }) => {
    const entries = page.locator('gn-reflog-dialog .entry');
    await expect(entries).toHaveCount(3);

    await entries.nth(1).click({ button: 'right' });

    await expect(page.locator('gn-reflog-dialog .context-menu-item').filter({ hasText: 'Undo to this state' })).toBeAttached();
  });

  test('context menu should have Copy commit hash option', async ({ page }) => {
    const entries = page.locator('gn-reflog-dialog .entry');
    await expect(entries).toHaveCount(3);

    await entries.nth(1).click({ button: 'right' });

    await expect(page.locator('gn-reflog-dialog .context-menu-item').filter({ hasText: 'Copy commit hash' })).toBeAttached();
  });

  test('clicking Undo to this state should call reset_to_reflog', async ({ page }) => {
    const entries = page.locator('gn-reflog-dialog .entry');
    await expect(entries).toHaveCount(3);

    await entries.nth(1).click({ button: 'right' });

    await page.locator('gn-reflog-dialog .context-menu-item').filter({ hasText: 'Undo to this state' }).click();

    const commands = await findCommand(page, 'reset_to_reflog');
    expect(commands.length).toBeGreaterThan(0);
  });

  test('non-current entries should show Undo and Hard reset buttons on hover', async ({ page }) => {
    await expect(page.locator('gn-reflog-dialog .entry-actions').first()).toBeAttached();
    await expect(page.locator('gn-reflog-dialog .reset-btn').first()).toBeAttached();
    await expect(page.locator('gn-reflog-dialog .reset-btn.hard').first()).toBeAttached();
  });

  test('clicking the Undo button should call reset_to_reflog with mixed mode', async ({ page }) => {
    await page.locator('gn-reflog-dialog .reset-btn:not(.hard)').first().click();

    const commands = await findCommand(page, 'reset_to_reflog');
    expect(commands.length).toBeGreaterThan(0);
    const args = commands[0].args as Record<string, unknown>;
    expect(args.mode).toBe('mixed');
  });

  test('dialog should close on Escape key', async ({ page }) => {
    const dialog = page.locator('gn-reflog-dialog[open]');
    await expect(dialog).toBeAttached();

    await page.keyboard.press('Escape');

    await expect(page.locator('gn-reflog-dialog[open]')).not.toBeAttached();
  });

  // The dialog's own dismiss() refuses to close mid-reset, but the keyboard
  // service registers a SEPARATE document-level Escape handler that reaches
  // app-shell and flips the dialog's `open` binding directly. That second path
  // has to honour the same guard, or the reset carries on with no visible
  // surface and its success path later slams shut whatever the user reopened.
  test('Escape must not close the dialog while a reset is in flight', async ({ page }) => {
    await injectCommandHang(page, 'reset_to_reflog');

    await page.locator('gn-reflog-dialog .reset-btn:not(.hard)').first().click();
    await waitForCommand(page, 'reset_to_reflog');

    await page.keyboard.press('Escape');

    await expect(page.locator('gn-reflog-dialog[open]')).toBeAttached();
    // Still mid-reset (so the guard is what kept it open, not a stalled test):
    // the reset affordances stay disabled for the same reason.
    await expect(page.locator('gn-reflog-dialog .reset-btn').first()).toBeDisabled();
  });

  test('dialog should close when clicking the close button', async ({ page }) => {
    await page.locator('gn-reflog-dialog .close-btn').click();

    await expect(page.locator('gn-reflog-dialog[open]')).not.toBeAttached();
  });

  test('first entry should show Current badge and no action buttons', async ({ page }) => {
    const firstEntry = page.locator('gn-reflog-dialog .entry').first();
    await expect(firstEntry.locator('.current-badge')).toBeAttached();
    await expect(firstEntry.locator('.entry-actions')).not.toBeAttached();
  });
});

test.describe('Reflog Dialog - repository-refresh after undo', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Every reset mode is confirm-gated now, not just hard.
    await autoConfirmDialogs(page);

    await startCommandCaptureWithMocks(page, {
      get_reflog: REFLOG_ENTRIES,
      reset_to_reflog: REFLOG_ENTRIES[1],
    });
  });

  test('completing an undo should trigger a repository refresh', async ({ page }) => {
    const refreshPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('repository-refresh', () => {
          resolve(true);
        }, { once: true });
        setTimeout(() => resolve(false), 5000);
      });
    });

    await openReflogDialog(page);

    await page.locator('gn-reflog-dialog .reset-btn:not(.hard)').first().click();

    const refreshFired = await refreshPromise;
    expect(refreshFired).toBe(true);
  });
});

test.describe('Reflog Dialog - Error handling', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Every reset mode is confirm-gated now, not just hard.
    await autoConfirmDialogs(page);

    await startCommandCaptureWithMocks(page, {
      get_reflog: REFLOG_ENTRIES,
      reset_to_reflog: { __error__: 'Reset failed: working tree has uncommitted changes' },
    });
  });

  test('failed undo operation should not close the dialog', async ({ page }) => {
    await openReflogDialog(page);

    await page.locator('gn-reflog-dialog .reset-btn:not(.hard)').first().click();

    await expect(page.locator('gn-reflog-dialog[open]')).toBeAttached();
  });
});

test.describe('Reflog Dialog - Injected reset_to_reflog error', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Every reset mode is confirm-gated now, not just hard.
    await autoConfirmDialogs(page);

    await startCommandCaptureWithMocks(page, {
      get_reflog: REFLOG_ENTRIES,
      reset_to_reflog: null,
    });
  });

  test('should keep dialog open when reset_to_reflog fails', async ({ page }) => {
    await openReflogDialog(page);

    // Inject error after dialog is open so get_reflog still works
    await injectCommandError(page, 'reset_to_reflog', 'Reset failed: cannot reset with uncommitted changes');

    // Click the Undo button on a non-current entry
    await page.locator('gn-reflog-dialog .reset-btn:not(.hard)').first().click();

    // Dialog should remain open because the reset failed
    await expect(page.locator('gn-reflog-dialog[open]')).toBeAttached();
  });
});

test.describe('Reflog Dialog - Extended Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Every reset mode is confirm-gated now, not just hard.
    await autoConfirmDialogs(page);

    await startCommandCaptureWithMocks(page, {
      get_reflog: REFLOG_ENTRIES,
      reset_to_reflog: REFLOG_ENTRIES[1],
    });
  });

  test('entry should display action text matching the reflog message', async ({ page }) => {
    await openReflogDialog(page);

    // Verify the first entry shows the checkout action message
    const firstMessage = page.locator('gn-reflog-dialog .entry-message').first();
    await expect(firstMessage).toBeAttached();
    await expect(firstMessage).toContainText(/checkout|moving/i);

    // Verify the second entry shows the commit action message
    const secondMessage = page.locator('gn-reflog-dialog .entry-message').nth(1);
    await expect(secondMessage).toBeAttached();
    await expect(secondMessage).toContainText(/commit|Add feature/i);

    // Verify the third entry shows the reset action message
    const thirdMessage = page.locator('gn-reflog-dialog .entry-message').nth(2);
    await expect(thirdMessage).toBeAttached();
    await expect(thirdMessage).toContainText(/reset|moving/i);
  });

  test('clicking Undo to this state context menu item calls reset_to_reflog with correct OID', async ({ page }) => {
    await openReflogDialog(page);

    const entries = page.locator('gn-reflog-dialog .entry');
    await expect(entries).toHaveCount(3);

    // Right-click on the second entry (index 1, non-current)
    await entries.nth(1).click({ button: 'right' });

    // The context menu should appear
    const contextMenu = page.locator('gn-reflog-dialog .context-menu');
    await expect(contextMenu).toBeAttached();

    // Click "Undo to this state"
    const undoItem = page.locator('gn-reflog-dialog .context-menu-item').filter({ hasText: 'Undo to this state' });
    await expect(undoItem).toBeAttached();
    await undoItem.click();

    // Verify reset_to_reflog was called
    const commands = await findCommand(page, 'reset_to_reflog');
    expect(commands.length).toBeGreaterThan(0);

    // Verify the command was called with the correct reflog index from the second entry
    const args = commands[0].args as Record<string, unknown>;
    expect(args.reflogIndex).toBe(1);
  });
});

/**
 * A first page that comes back completely full — the only signal available
 * that older entries may exist, since get_reflog reports no total.
 */
const FIFTY_ENTRIES = Array.from({ length: 50 }, (_, i) => ({
  oid: `oid${i}`.padEnd(12, '0'),
  shortId: `oid${i}`.padEnd(7, '0').slice(0, 7),
  index: i,
  action: 'commit',
  message: `commit: entry ${i}`,
  timestamp: Date.now() / 1000 - i * 60,
  author: 'Test User',
}));

test.describe('Reflog Dialog pagination', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { get_reflog: FIFTY_ENTRIES });
    await openReflogDialog(page);
  });

  test('offers older entries when the first page fills up', async ({ page }) => {
    await expect(page.locator('gn-reflog-dialog .show-more-btn')).toBeVisible();
    await expect(page.locator('gn-reflog-dialog .list-note')).toContainText('first 50');

    await page.locator('gn-reflog-dialog .show-more-btn').click();

    await expect
      .poll(async () => {
        const calls = await findCommand(page, 'get_reflog');
        return (calls[calls.length - 1].args as { limit?: number }).limit;
      })
      .toBe(100);

    // The mock returns the same 50 for a limit of 100, so the list is now
    // known-complete and the control must retire rather than sit there dead.
    await expect(page.locator('gn-reflog-dialog .show-more-btn')).toHaveCount(0);
    await expect(page.locator('gn-reflog-dialog .list-note')).toContainText('Showing all 50');
  });
});
