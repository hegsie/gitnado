import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { injectCommandMock } from '../fixtures/test-helpers';

/**
 * The scan dialog against a folder that becomes a repository underneath it.
 *
 * Dropping a folder that is not a repository offers to scan it or to
 * initialize one there. The user can take the offer, get a list of results and
 * tick some of them — and then create a repository in that same folder and
 * drop it again to open it. The shell used to close the dialog on that,
 * whatever it was showing: the results and the ticks went with it, recoverable
 * only by walking the whole folder again, and a scan still running was aborted.
 *
 * The offer itself, and the empty-results screen, do go: both say "this folder
 * is not a Git repository" and both offer to initialize one, which is no longer
 * true of the folder.
 *
 * The two window events below are exactly what `window-drop.service` dispatches
 * for an OS folder drop, which Playwright cannot perform against the webview.
 */
const DROPPED = '/tmp/projects';

type Page = import('@playwright/test').Page;

async function dropNonRepository(page: Page): Promise<void> {
  await page.evaluate((path) => {
    window.dispatchEvent(new CustomEvent('repository-scan-offer', { detail: { path } }));
  }, DROPPED);
  await expect(page.locator('lv-scan-repositories-dialog .offer-actions')).toBeVisible();
}

async function dropAgainAsRepository(page: Page): Promise<void> {
  await page.evaluate((path) => {
    window.dispatchEvent(new CustomEvent('repository-scan-resolved', { detail: { path } }));
  }, DROPPED);
}

test.describe('Scan dialog - the folder becomes a repository', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('keeps the results and the selections it is showing', async ({ page }) => {
    await injectCommandMock(page, {
      scan_for_repositories: {
        root: DROPPED,
        repositories: [
          { path: `${DROPPED}/alpha`, name: 'alpha', isBare: false },
          { path: `${DROPPED}/beta`, name: 'beta', isBare: false },
        ],
        scannedDirectories: 40,
        truncated: false,
        cancelled: false,
      },
    });
    await dropNonRepository(page);

    await page
      .locator('lv-scan-repositories-dialog .offer-actions button', {
        hasText: 'Scan it for repositories',
      })
      .click();
    const results = page.locator('lv-scan-repositories-dialog .result-item');
    await expect(results).toHaveCount(2);
    await results.first().locator('input[type="checkbox"]').check();

    await dropAgainAsRepository(page);

    // The walk and the tick are work the user did; the drop has already said
    // what it did on its own ("Opened …"), so there is nothing to take away.
    await expect(results).toHaveCount(2);
    await expect(results.first().locator('input[type="checkbox"]')).toBeChecked();
    await expect(
      page.locator('lv-scan-repositories-dialog .btn-primary', { hasText: 'Open selected' })
    ).toBeVisible();
  });

  test('closes the offer, which is now asking about a repository', async ({ page }) => {
    await dropNonRepository(page);

    await dropAgainAsRepository(page);

    // "This folder is not a Git repository" is false now, and its Initialize
    // action would hand a real repository to `init`. (The dialog element stays
    // mounted in the shell; what goes is the modal it renders.)
    await expect(page.locator('lv-scan-repositories-dialog .offer-actions')).toBeHidden();
  });

  test('closes the empty-results screen, whose only action is Initialize', async ({ page }) => {
    await injectCommandMock(page, {
      scan_for_repositories: {
        root: DROPPED,
        repositories: [],
        scannedDirectories: 40,
        truncated: false,
        cancelled: false,
      },
    });
    await dropNonRepository(page);

    await page
      .locator('lv-scan-repositories-dialog .offer-actions button', {
        hasText: 'Scan it for repositories',
      })
      .click();
    await expect(page.locator('lv-scan-repositories-dialog .explanation')).toContainText(
      'No Git repositories were found'
    );

    await dropAgainAsRepository(page);

    await expect(page.locator('lv-scan-repositories-dialog .explanation')).toBeHidden();
  });
});
