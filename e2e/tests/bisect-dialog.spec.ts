import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
  openViaCommandPalette,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Bisect Dialog
 *
 * The bisect dialog is opened via the command palette ("Start bisect (find bug)").
 * It has three states: setup -> in-progress -> complete.
 *
 * The dialog element is `gn-bisect-dialog` with an `open` attribute.
 * It renders an overlay dialog with `.dialog` class inside its shadow root.
 */

/** Open the bisect dialog via the command palette */
async function openBisectDialog(page: import('@playwright/test').Page) {
  await openViaCommandPalette(page, 'bisect');
  await page.locator('gn-bisect-dialog .dialog').waitFor({ state: 'visible' });
}

test.describe('Bisect Dialog - Setup State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    // Mock bisect commands to return inactive status initially
    await injectCommandMock(page, {
      get_bisect_status: {
        active: false,
        currentCommit: null,
        badCommit: null,
        goodCommit: null,
        remaining: null,
        totalSteps: null,
        currentStep: null,
        log: [],
      },
      bisect_start: {
        status: {
          active: true,
          currentCommit: 'test123abc456',
          badCommit: 'HEAD',
          goodCommit: 'abc123',
          remaining: 5,
          currentStep: 1,
          totalSteps: 7,
          log: [],
        },
        culprit: null,
        message: 'Bisecting: 5 revisions left to test',
      },
      get_commit: {
        oid: 'test123abc456',
        shortId: 'test123',
        message: 'Test commit to evaluate',
        summary: 'Test commit to evaluate',
        body: null,
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: [],
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  });

  test('dialog opens and shows setup state with bad/good commit inputs', async ({ page }) => {
    await openBisectDialog(page);

    const dialog = page.locator('gn-bisect-dialog .dialog');
    await expect(dialog).toBeVisible();

    // Should show "Git Bisect" title
    const title = page.locator('gn-bisect-dialog .dialog-title');
    await expect(title).toContainText('Git Bisect');

    // Should have Bad Commit and Good Commit sections
    const badSection = page.locator('gn-bisect-dialog h3', { hasText: 'Bad Commit' });
    const goodSection = page.locator('gn-bisect-dialog h3', { hasText: 'Good Commit' });
    await expect(badSection).toBeVisible();
    await expect(goodSection).toBeVisible();

    // Should have two input fields
    const inputs = page.locator('gn-bisect-dialog .commit-input input');
    await expect(inputs).toHaveCount(2);
  });

  test('Start Bisect button is disabled without both inputs', async ({ page }) => {
    await openBisectDialog(page);

    const startBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' });
    await expect(startBtn).toBeDisabled();
  });

  test('filling both inputs enables Start Bisect button', async ({ page }) => {
    await openBisectDialog(page);

    // Fill in bad commit
    const badInput = page.locator('gn-bisect-dialog .commit-input input').first();
    await badInput.fill('HEAD');

    // Fill in good commit
    const goodInput = page.locator('gn-bisect-dialog .commit-input input').nth(1);
    await goodInput.fill('abc123');

    // Start button should be enabled
    const startBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' });
    await expect(startBtn).toBeEnabled();
  });

  test('clicking Start Bisect calls bisect_start and transitions to in-progress', async ({ page }) => {
    await startCommandCapture(page);
    await openBisectDialog(page);

    // Fill inputs
    const badInput = page.locator('gn-bisect-dialog .commit-input input').first();
    await badInput.fill('HEAD');
    const goodInput = page.locator('gn-bisect-dialog .commit-input input').nth(1);
    await goodInput.fill('abc123');

    // Click Start
    const startBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' });
    await startBtn.click();

    await waitForCommand(page, 'bisect_start');

    const commands = await findCommand(page, 'bisect_start');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Verify args contain bad and good commits
    const args = commands[0].args as { badCommit?: string; goodCommit?: string };
    expect(args.badCommit).toBe('HEAD');
    expect(args.goodCommit).toBe('abc123');

    // Should transition to in-progress state showing current commit
    const currentCommitLabel = page.locator('gn-bisect-dialog .current-commit-label');
    await expect(currentCommitLabel).toBeVisible();
    await expect(currentCommitLabel).toContainText('Current Commit');
  });

  test('Cancel button closes dialog', async ({ page }) => {
    await openBisectDialog(page);

    const cancelBtn = page.locator('gn-bisect-dialog .btn-secondary', { hasText: 'Cancel' });
    await cancelBtn.click();

    // Dialog should close (no longer visible)
    const dialog = page.locator('gn-bisect-dialog .dialog');
    await expect(dialog).not.toBeVisible();
  });
});

test.describe('Bisect Dialog - In-Progress State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    // Mock bisect status as already in-progress
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'test123abc456',
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 4,
        currentStep: 2,
        totalSteps: 7,
        log: [
          { action: 'bad', commitOid: 'bad_commit_oid', message: null },
          { action: 'good', commitOid: 'good_commit_oid', message: null },
        ],
      },
      get_commit: {
        oid: 'test123abc456',
        shortId: 'test123',
        message: 'Test commit to evaluate\n\nDetailed body.',
        summary: 'Test commit to evaluate',
        body: 'Detailed body.',
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: ['parent1'],
        timestamp: Math.floor(Date.now() / 1000),
      },
      bisect_good: {
        status: {
          active: true,
          currentCommit: 'next_commit_aaa',
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 3,
          currentStep: 3,
          totalSteps: 7,
          log: [],
        },
        culprit: null,
        message: 'Bisecting: 3 revisions left',
      },
      bisect_bad: {
        status: {
          active: true,
          currentCommit: 'next_commit_bbb',
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 2,
          currentStep: 3,
          totalSteps: 7,
          log: [],
        },
        culprit: null,
        message: 'Bisecting: 2 revisions left',
      },
      bisect_skip: {
        status: {
          active: true,
          currentCommit: 'next_commit_ccc',
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 3,
          currentStep: 3,
          totalSteps: 7,
          log: [],
        },
        culprit: null,
        message: 'Bisecting: 3 revisions left',
      },
      bisect_reset: {
        status: {
          active: false,
          currentCommit: null,
          badCommit: null,
          goodCommit: null,
          remaining: null,
          totalSteps: null,
          currentStep: null,
          log: [],
        },
        culprit: null,
        message: 'Bisect reset',
      },
    });
  });

  test('shows current commit info with OID and message', async ({ page }) => {
    await openBisectDialog(page);

    // Should display the current commit OID (truncated to first 12 chars)
    const commitOid = page.locator('gn-bisect-dialog .current-commit-oid');
    await expect(commitOid).toBeVisible();
    await expect(commitOid).toContainText('test123abc45');

    // Should display the commit message
    const commitMessage = page.locator('gn-bisect-dialog .current-commit-message');
    await expect(commitMessage).toBeVisible();
    await expect(commitMessage).toContainText('Test commit to evaluate');
  });

  test('shows progress stats (commits left, steps taken, total steps)', async ({ page }) => {
    await openBisectDialog(page);

    const statValues = page.locator('gn-bisect-dialog .progress-stat-value');
    // Should have at least 3 stat values
    await expect(statValues.first()).toBeVisible();
    const count = await statValues.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('shows Good, Bad, and Skip action buttons', async ({ page }) => {
    await openBisectDialog(page);

    const goodBtn = page.locator('gn-bisect-dialog .action-btn.good');
    const badBtn = page.locator('gn-bisect-dialog .action-btn.bad');
    const skipBtn = page.locator('gn-bisect-dialog .action-btn.skip');

    await expect(goodBtn).toBeVisible();
    await expect(badBtn).toBeVisible();
    await expect(skipBtn).toBeVisible();

    await expect(goodBtn).toContainText('Good');
    await expect(badBtn).toContainText('Bad');
    await expect(skipBtn).toContainText('Skip');
  });

  test('Abort Bisect button calls bisect_reset and closes the dialog', async ({ page }) => {
    await startCommandCapture(page);
    await openBisectDialog(page);

    // Verify we start in the in-progress state with action buttons visible
    await expect(page.locator('gn-bisect-dialog .action-btn.good')).toBeVisible();

    const abortBtn = page.locator('gn-bisect-dialog .btn-danger', { hasText: 'Abort Bisect' });
    await expect(abortBtn).toBeVisible();
    // Aborting now asks first — a bisect session is many deliberate good/bad
    // decisions and nothing in git records them.
    await autoConfirmDialogs(page);
    await abortBtn.click();

    await waitForCommand(page, 'bisect_reset');

    const commands = await findCommand(page, 'bisect_reset');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Verify the dialog closes after aborting bisect (handleReset dispatches 'bisect-complete')
    await expect(page.locator('gn-bisect-dialog .dialog')).not.toBeVisible({ timeout: 5000 });
  });

  test('shows bisect history log', async ({ page }) => {
    await openBisectDialog(page);

    const logTitle = page.locator('gn-bisect-dialog .bisect-log-title');
    await expect(logTitle).toBeVisible();
    await expect(logTitle).toContainText('Bisect History');

    const logEntries = page.locator('gn-bisect-dialog .bisect-log-entry');
    await expect(logEntries).toHaveCount(2);
  });
});

test.describe('Bisect Dialog - Complete State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    // Mock bisect as completing with a culprit found
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: null,
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 0,
        currentStep: 7,
        totalSteps: 7,
        log: [
          { action: 'bad', commitOid: 'bad_oid', message: null },
          { action: 'good', commitOid: 'good_oid', message: null },
        ],
      },
      // Simulate that bisect_good finds the culprit
      bisect_good: {
        status: {
          active: true,
          currentCommit: null,
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 0,
          currentStep: 7,
          totalSteps: 7,
          log: [],
        },
        culprit: {
          oid: 'culprit_abc123def456',
          summary: 'This commit introduced the bug',
          author: 'Bug Author',
          email: 'bug@test.com',
        },
        message: 'Culprit found',
      },
      bisect_reset: {
        status: {
          active: false,
          currentCommit: null,
          badCommit: null,
          goodCommit: null,
          remaining: null,
          totalSteps: null,
          currentStep: null,
          log: [],
        },
        culprit: null,
        message: 'Bisect reset',
      },
      get_commit: {
        oid: 'test123abc456',
        shortId: 'test123',
        message: 'Test commit',
        summary: 'Test commit',
        body: null,
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: [],
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  });

  test('marking good that finds culprit shows Bug-Introducing Commit Found', async ({ page }) => {
    // Override to in-progress first to trigger good -> culprit
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'test_commit_oid',
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 1,
        currentStep: 6,
        totalSteps: 7,
        log: [],
      },
      get_commit: {
        oid: 'test_commit_oid',
        shortId: 'test_co',
        message: 'Last commit to test',
        summary: 'Last commit to test',
        body: null,
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: [],
        timestamp: Math.floor(Date.now() / 1000),
      },
      bisect_good: {
        status: {
          active: true,
          currentCommit: null,
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 0,
          currentStep: 7,
          totalSteps: 7,
          log: [],
        },
        culprit: {
          oid: 'culprit_abc123def456',
          summary: 'This commit introduced the bug',
          author: 'Bug Author',
          email: 'bug@test.com',
        },
        message: 'Culprit found',
      },
      bisect_reset: {
        status: {
          active: false,
          currentCommit: null,
          badCommit: null,
          goodCommit: null,
          remaining: null,
          totalSteps: null,
          currentStep: null,
          log: [],
        },
        culprit: null,
        message: 'Reset',
      },
    });

    await openBisectDialog(page);

    // Click Good to trigger culprit detection
    const goodBtn = page.locator('gn-bisect-dialog .action-btn.good');
    await goodBtn.click();

    const culpritCard = page.locator('gn-bisect-dialog .culprit-card');
    await expect(culpritCard).toBeVisible();

    // Should show "Bug-Introducing Commit Found"
    const culpritTitle = page.locator('gn-bisect-dialog .culprit-title');
    await expect(culpritTitle).toContainText('Bug-Introducing Commit Found');

    // Should show culprit OID and summary
    const culpritOid = page.locator('gn-bisect-dialog .culprit-oid');
    await expect(culpritOid).toContainText('culprit_abc123def456');

    const culpritSummary = page.locator('gn-bisect-dialog .culprit-summary');
    await expect(culpritSummary).toContainText('This commit introduced the bug');

    // Should show Finish button instead of action buttons
    const finishBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Finish' });
    await expect(finishBtn).toBeVisible();
  });

  test('Finish button resets bisect and returns to setup', async ({ page }) => {
    // Same setup as above to get to complete state
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'test_oid',
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 1,
        currentStep: 6,
        totalSteps: 7,
        log: [],
      },
      get_commit: {
        oid: 'test_oid',
        shortId: 'test_oi',
        message: 'Test',
        summary: 'Test',
        body: null,
        author: { name: 'Test', email: 'test@test.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test', email: 'test@test.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: [],
        timestamp: Math.floor(Date.now() / 1000),
      },
      bisect_good: {
        status: {
          active: true,
          currentCommit: null,
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 0,
          currentStep: 7,
          totalSteps: 7,
          log: [],
        },
        culprit: { oid: 'culprit_oid', summary: 'Bug', author: 'Author', email: 'a@b.com' },
        message: 'Found',
      },
      bisect_reset: {
        status: {
          active: false,
          currentCommit: null,
          badCommit: null,
          goodCommit: null,
          remaining: null,
          totalSteps: null,
          currentStep: null,
          log: [],
        },
        culprit: null,
        message: 'Reset',
      },
    });

    await startCommandCapture(page);
    await openBisectDialog(page);

    // Get to complete state
    const goodBtn = page.locator('gn-bisect-dialog .action-btn.good');
    await goodBtn.click();

    const finishBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Finish' });
    await expect(finishBtn).toBeVisible();
    await finishBtn.click();

    await waitForCommand(page, 'bisect_reset');

    const commands = await findCommand(page, 'bisect_reset');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Verify the dialog closes after finishing bisect
    await expect(page.locator('gn-bisect-dialog .dialog')).not.toBeVisible({ timeout: 5000 });
  });

  // The session stays active in git until Finish runs `bisect reset`, so a
  // dialog closed at the result screen (X, Escape, overlay click) must reopen
  // ON the result. It used to come back on Good/Bad/Skip with the answer gone.
  test('a completed bisect reopens on the result screen', async ({ page }) => {
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'culprit_abc123def456',
        badCommit: 'culprit_abc123def456',
        goodCommit: 'good_ref',
        remaining: 0,
        currentStep: 7,
        totalSteps: 7,
        log: [],
        culprit: {
          oid: 'culprit_abc123def456',
          summary: 'This commit introduced the bug',
          author: 'Test User',
          email: 'test@example.com',
        },
      },
    });

    // No Good/Bad clicks: this is the reopen path, straight from status.
    await openBisectDialog(page);

    await expect(page.locator('gn-bisect-dialog .culprit-card')).toBeVisible();
    await expect(page.locator('gn-bisect-dialog .culprit-oid')).toContainText(
      'culprit_abc123def456'
    );
    await expect(
      page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Finish' })
    ).toBeVisible();
    await expect(page.locator('gn-bisect-dialog .action-btn')).toHaveCount(0);
  });

  // A range holding a single candidate converges inside `git bisect start`
  // itself, and the session stays active until reset. The start used to read
  // only `active`, so it asked for a Good/Bad verdict git no longer needed.
  test('a start that converges immediately shows the result', async ({ page }) => {
    await injectCommandMock(page, {
      get_bisect_status: {
        active: false,
        currentCommit: null,
        badCommit: null,
        goodCommit: null,
        remaining: null,
        totalSteps: null,
        currentStep: null,
        log: [],
        culprit: null,
      },
      bisect_start: {
        status: {
          active: true,
          currentCommit: 'culprit_abc123def456',
          badCommit: 'culprit_abc123def456',
          goodCommit: 'good_ref',
          remaining: 0,
          currentStep: 1,
          totalSteps: 0,
          log: [],
          culprit: {
            oid: 'culprit_abc123def456',
            summary: 'This commit introduced the bug',
            author: 'Test User',
            email: 'test@example.com',
          },
        },
        // git converged in the start itself, so the step output carries no
        // culprit of its own — only the refreshed status does.
        culprit: null,
        message: 'Bisect session started',
      },
    });

    await openBisectDialog(page);

    await page.locator('gn-bisect-dialog .commit-input input').first().fill('HEAD');
    await page.locator('gn-bisect-dialog .commit-input input').nth(1).fill('HEAD~1');
    await page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' }).click();

    await expect(page.locator('gn-bisect-dialog .culprit-card')).toBeVisible();
    await expect(page.locator('gn-bisect-dialog .culprit-oid')).toContainText(
      'culprit_abc123def456'
    );
    await expect(page.locator('gn-bisect-dialog .action-btn')).toHaveCount(0);
  });
});

test.describe('Bisect Dialog - Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_bisect_status: {
        active: false,
        currentCommit: null,
        badCommit: null,
        goodCommit: null,
        remaining: null,
        totalSteps: null,
        currentStep: null,
        log: [],
      },
    });
  });

  test('start bisect failure shows error message', async ({ page }) => {
    await injectCommandError(page, 'bisect_start', 'Invalid commit reference');

    await openBisectDialog(page);

    // Fill inputs
    const badInput = page.locator('gn-bisect-dialog .commit-input input').first();
    await badInput.fill('HEAD');
    const goodInput = page.locator('gn-bisect-dialog .commit-input input').nth(1);
    await goodInput.fill('nonexistent');

    // Click Start
    const startBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' });
    await startBtn.click();

    const errorMessage = page.locator('gn-bisect-dialog .message.error');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Invalid commit reference');
  });

  test('empty inputs show validation error', async ({ page }) => {
    await openBisectDialog(page);

    // The Start Bisect button should be disabled when inputs are empty
    const startBtn = page.locator('gn-bisect-dialog .btn-primary', { hasText: 'Start Bisect' });
    await expect(startBtn).toBeDisabled();
  });
});

test.describe('Bisect Dialog - Extended Tests', () => {
  test('marking a commit as good updates step count and current commit in UI', async ({ page }) => {
    await setupOpenRepository(page);

    // Start with in-progress bisect at step 2 of 7
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'commit_step2_oid',
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 4,
        currentStep: 2,
        totalSteps: 7,
        log: [
          { action: 'bad', commitOid: 'bad_commit_oid', message: null },
          { action: 'good', commitOid: 'good_commit_oid', message: null },
        ],
      },
      get_commit: {
        oid: 'commit_step2_oid',
        shortId: 'commit_',
        message: 'Step 2 commit to evaluate',
        summary: 'Step 2 commit to evaluate',
        body: null,
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: ['parent1'],
        timestamp: Math.floor(Date.now() / 1000),
      },
      bisect_good: {
        status: {
          active: true,
          currentCommit: 'commit_step3_oid',
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 3,
          currentStep: 3,
          totalSteps: 7,
          log: [
            { action: 'bad', commitOid: 'bad_commit_oid', message: null },
            { action: 'good', commitOid: 'good_commit_oid', message: null },
            { action: 'good', commitOid: 'commit_step2_oid', message: null },
          ],
        },
        culprit: null,
        message: 'Bisecting: 3 revisions left',
      },
      bisect_bad: {
        status: {
          active: true,
          currentCommit: 'commit_step3_bad_oid',
          badCommit: 'bad_ref',
          goodCommit: 'good_ref',
          remaining: 2,
          currentStep: 3,
          totalSteps: 7,
          log: [
            { action: 'bad', commitOid: 'bad_commit_oid', message: null },
            { action: 'good', commitOid: 'good_commit_oid', message: null },
            { action: 'bad', commitOid: 'commit_step2_oid', message: null },
          ],
        },
        culprit: null,
        message: 'Bisecting: 2 revisions left',
      },
      bisect_reset: null,
    });

    await openBisectDialog(page);

    // Verify initial state shows current commit OID
    const commitOid = page.locator('gn-bisect-dialog .current-commit-oid');
    await expect(commitOid).toBeVisible();
    await expect(commitOid).toContainText('commit_step2');

    // Verify initial progress stats are visible
    const statValues = page.locator('gn-bisect-dialog .progress-stat-value');
    await expect(statValues.first()).toBeVisible();

    // Click Good to advance bisect
    const goodBtn = page.locator('gn-bisect-dialog .action-btn.good');
    await goodBtn.click();

    // After marking good, the dialog should update to show new current commit
    // The commit OID should change to the next commit
    await expect(commitOid).toContainText('commit_step3');

    // The dialog should remain in the in-progress state with action buttons
    await expect(page.locator('gn-bisect-dialog .action-btn.good')).toBeVisible();
    await expect(page.locator('gn-bisect-dialog .action-btn.bad')).toBeVisible();
  });

  test('bisect history log shows entries with correct good/bad action labels', async ({ page }) => {
    await setupOpenRepository(page);

    // Set up bisect in-progress with a log that has both good and bad entries
    await injectCommandMock(page, {
      get_bisect_status: {
        active: true,
        currentCommit: 'current_eval_oid',
        badCommit: 'bad_ref',
        goodCommit: 'good_ref',
        remaining: 3,
        currentStep: 3,
        totalSteps: 7,
        log: [
          { action: 'bad', commitOid: 'bad_commit_aaa', message: null },
          { action: 'good', commitOid: 'good_commit_bbb', message: null },
          { action: 'bad', commitOid: 'bad_commit_ccc', message: null },
        ],
      },
      get_commit: {
        oid: 'current_eval_oid',
        shortId: 'current',
        message: 'Commit under evaluation',
        summary: 'Commit under evaluation',
        body: null,
        author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
        parentIds: [],
        timestamp: Math.floor(Date.now() / 1000),
      },
      bisect_reset: null,
    });

    await openBisectDialog(page);

    // The bisect history log section should be visible
    const logTitle = page.locator('gn-bisect-dialog .bisect-log-title');
    await expect(logTitle).toBeVisible();
    await expect(logTitle).toContainText('Bisect History');

    // Verify the correct number of log entries (3 steps taken)
    const logEntries = page.locator('gn-bisect-dialog .bisect-log-entry');
    await expect(logEntries).toHaveCount(3);

    // Verify the first entry shows "bad" action label
    const firstEntry = logEntries.first();
    await expect(firstEntry).toContainText(/bad/i);

    // Verify the second entry shows "good" action label
    const secondEntry = logEntries.nth(1);
    await expect(secondEntry).toContainText(/good/i);

    // Verify the third entry shows "bad" action label
    const thirdEntry = logEntries.nth(2);
    await expect(thirdEntry).toContainText(/bad/i);
  });
});
