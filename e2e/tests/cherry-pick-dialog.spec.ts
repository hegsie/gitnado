import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandError,
} from '../fixtures/test-helpers';

const MOCK_COMMIT = {
  oid: 'abc123def456789012345678901234567890abcd',
  shortId: 'abc123d',
  message: 'Test commit to cherry-pick\n\nThis is the commit body.',
  summary: 'Test commit to cherry-pick',
  body: 'This is the commit body.',
  author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  parentIds: ['parent111222333'],
  timestamp: Math.floor(Date.now() / 1000),
};

async function openCherryPickDialog(page: import('@playwright/test').Page) {
  const dialog = page.locator('gn-cherry-pick-dialog');
  const dialogHandle = await dialog.elementHandle();
  await page.evaluate(([el, commit]) => {
    const d = el as HTMLElement & { open: (c: unknown) => void } | null;
    if (d) {
      d.open(commit);
    }
  }, [dialogHandle, MOCK_COMMIT] as const);

  await page.locator('gn-cherry-pick-dialog gn-modal[open]').waitFor({ state: 'visible' });
}

test.describe('Cherry-Pick Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('dialog opens with commit info pre-filled', async ({ page }) => {
    await openCherryPickDialog(page);

    const dialog = page.locator('gn-cherry-pick-dialog');

    const commitSha = dialog.locator('.commit-sha');
    await expect(commitSha).toContainText('abc123d');

    const commitMessage = dialog.locator('.commit-message');
    await expect(commitMessage).toContainText('Test commit to cherry-pick');

    const commitBody = dialog.locator('.commit-body');
    await expect(commitBody).toContainText('This is the commit body.');

    const commitAuthor = dialog.locator('.commit-author');
    await expect(commitAuthor).toContainText('Test User');
  });

  test('dialog shows current branch as cherry-pick target', async ({ page }) => {
    await openCherryPickDialog(page);

    const targetBranch = page.locator('gn-cherry-pick-dialog .target-branch');
    await expect(targetBranch).toBeVisible();
    await expect(targetBranch).toContainText('main');
  });

  test('confirm calls cherry_pick with correct OID', async ({ page }) => {
    await startCommandCapture(page);
    await openCherryPickDialog(page);

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    await waitForCommand(page, 'cherry_pick');

    const commands = await findCommand(page, 'cherry_pick');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    const args = commands[0].args as { commitOid?: string };
    expect(args.commitOid).toBe('abc123def456789012345678901234567890abcd');

    // Verify the dialog closes after successful cherry-pick
    await expect(page.locator('gn-cherry-pick-dialog gn-modal[open]')).not.toBeVisible({ timeout: 3000 });
  });

  test('successful cherry-pick fires cherry-pick-complete event and closes dialog', async ({
    page,
  }) => {
    await openCherryPickDialog(page);

    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener(
          'cherry-pick-complete',
          () => resolve(true),
          { once: true }
        );
        setTimeout(() => resolve(false), 3000);
      });
    });

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);

    const modal = page.locator('gn-cherry-pick-dialog gn-modal[open]');
    await expect(modal).not.toBeVisible();
  });

  test('cancel closes dialog without invoking cherry_pick', async ({ page }) => {
    await startCommandCapture(page);
    await openCherryPickDialog(page);

    const cancelBtn = page.locator('gn-cherry-pick-dialog button.btn-secondary', {
      hasText: /Cancel/,
    });
    await cancelBtn.click();

    const modal = page.locator('gn-cherry-pick-dialog gn-modal[open]');
    await expect(modal).not.toBeVisible();

    const commands = await findCommand(page, 'cherry_pick');
    expect(commands.length).toBe(0);
  });

  test('error from cherry_pick shows error message in dialog', async ({ page }) => {
    await injectCommandError(page, 'cherry_pick', 'Cherry-pick failed: uncommitted changes');

    await openCherryPickDialog(page);

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    const errorMessage = page.locator('gn-cherry-pick-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('uncommitted changes');

    const modal = page.locator('gn-cherry-pick-dialog gn-modal[open]');
    await expect(modal).toBeVisible();
  });

  test('no-commit checkbox passes noCommit option to cherry_pick', async ({ page }) => {
    await startCommandCapture(page);
    await openCherryPickDialog(page);

    const noCommitCheckbox = page.locator('gn-cherry-pick-dialog #no-commit');
    await noCommitCheckbox.check();

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    await waitForCommand(page, 'cherry_pick');

    const commands = await findCommand(page, 'cherry_pick');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    const args = commands[0].args as { noCommit?: boolean };
    expect(args.noCommit).toBe(true);

    // Verify the dialog closes after successful cherry-pick with no-commit option
    await expect(page.locator('gn-cherry-pick-dialog gn-modal[open]')).not.toBeVisible({ timeout: 3000 });
  });

  test('Cherry-Pick button is disabled while executing', async ({ page }) => {
    await openCherryPickDialog(page);

    // Override cherry_pick to be slow AFTER the dialog is open
    await page.evaluate(() => {
      const originalInvoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;

      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
        if (command === 'cherry_pick') {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return null;
        }
        return originalInvoke(command, args);
      };
    });

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });

    await cherryPickBtn.click();

    // After clicking, the button text changes to "Cherry-picking..." (lowercase p),
    // so re-locate without the hasText filter to avoid case mismatch
    const executingBtn = page.locator('gn-cherry-pick-dialog button.btn-primary');

    await expect(executingBtn).toBeDisabled();
    await expect(executingBtn).toContainText('Cherry-picking...');
  });
});

test.describe('Cherry-Pick Dialog - Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('cherry_pick failure with merge conflict should show error feedback and keep dialog open', async ({
    page,
  }) => {
    await injectCommandError(page, 'cherry_pick', 'Cherry-pick failed: uncommitted changes prevent operation');

    await openCherryPickDialog(page);

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    // Verify error feedback appears (inline error message in dialog)
    const errorMessage = page.locator('gn-cherry-pick-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('uncommitted changes');

    // Verify the dialog remains open so the user can see the error
    const modal = page.locator('gn-cherry-pick-dialog gn-modal[open]');
    await expect(modal).toBeVisible();

    // Verify the commit info is still displayed (dialog state preserved)
    const commitSha = page.locator('gn-cherry-pick-dialog .commit-sha');
    await expect(commitSha).toContainText('abc123d');

    // Verify the cherry-pick button is re-enabled after error (not stuck in loading state)
    await expect(cherryPickBtn).toBeEnabled();
  });
});

test.describe('Cherry-pick Dialog - UI Outcome Verification', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('success: verify dialog closes and cherry-pick-complete event fires after cherry-pick', async ({
    page,
  }) => {
    await openCherryPickDialog(page);

    // Verify the dialog is open
    const modal = page.locator('gn-cherry-pick-dialog gn-modal[open]');
    await expect(modal).toBeVisible();

    // Listen for cherry-pick-complete event
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('cherry-pick-complete', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 3000);
      });
    });

    const cherryPickBtn = page.locator('gn-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/,
    });
    await cherryPickBtn.click();

    // Verify the event was fired
    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);

    // Verify the dialog is closed after successful cherry-pick
    await expect(modal).not.toBeVisible({ timeout: 3000 });

    // Verify the cherry-pick button is no longer visible (dialog gone)
    await expect(cherryPickBtn).not.toBeVisible();
  });

});
