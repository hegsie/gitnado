/**
 * E2E Tests for Remote Operations (Fetch/Push/Pull) and Ahead/Behind Badges
 *
 * Tests cover:
 * - Fetch/Push/Pull button visibility
 * - Ahead/behind badge display
 * - Button states during operations
 * - Badge updates after operations
 */

import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository, defaultMockData, withConflicts } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { startCommandCapture, startCommandCaptureWithMocks, findCommand, injectCommandError, injectCommandHang, injectCommandMock, emitBackendEvent, waitForCommand, openViaCommandPalette } from '../fixtures/test-helpers';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fetch/Pull/Push now exist on TWO surfaces — the context dashboard and the
 * toolbar — so a bare `getByRole('button', { name: /Push/i })` matches both.
 * These tests are about the dashboard's copy; the toolbar's live in
 * toolbar.spec.ts.
 */
function dashboardButton(page: import('@playwright/test').Page, name: RegExp) {
  return page.locator('lv-context-dashboard').getByRole('button', { name });
}

/**
 * Open a SECOND repository and make it the active tab, the way the welcome
 * screen and the session restore do — through the repository store.
 */
async function addRepo(page: Page, path: string, name: string): Promise<void> {
  await page.evaluate(
    ({ path, name }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: { getState: () => { addRepository: (repo: unknown) => void } };
      };
      stores.repositoryStore.getState().addRepository({
        path,
        name,
        isValid: true,
        isBare: false,
        headRef: 'main',
        state: 'clean',
        isShallow: false,
        isPartialClone: false,
        cloneFilter: null,
      });
    },
    { path, name }
  );
}

// ============================================================================
// Helper function to create branches with ahead/behind status
// ============================================================================

function withAheadBehind(ahead: number, behind: number) {
  return {
    branches: [
      {
        name: 'main',
        shorthand: 'main',
        isHead: true,
        isRemote: false,
        upstream: 'origin/main',
        targetOid: 'abc123def456',
        aheadBehind: { ahead, behind },
        lastCommitTimestamp: Date.now() / 1000,
        isStale: false,
      },
      {
        name: 'origin/main',
        shorthand: 'origin/main',
        isHead: false,
        isRemote: true,
        upstream: null,
        targetOid: 'abc123def456',
        isStale: false,
      },
    ],
  };
}

// ============================================================================
// Remote Buttons Tests
// ============================================================================

test.describe('Remote Operation Buttons', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('should display Fetch button in context dashboard', async ({ page }) => {
    const fetchButton = dashboardButton(page, /Fetch/i);
    await expect(fetchButton).toBeVisible();
  });

  test('should display Pull button in context dashboard', async ({ page }) => {
    const pullButton = dashboardButton(page, /Pull/i);
    await expect(pullButton).toBeVisible();
  });

  test('should display Push button in context dashboard', async ({ page }) => {
    const pushButton = dashboardButton(page, /Push/i);
    await expect(pushButton).toBeVisible();
  });

  test('Fetch button should be clickable', async ({ page }) => {
    const fetchButton = dashboardButton(page, /Fetch/i);
    await expect(fetchButton).toBeEnabled();
  });

  test('Pull button should be clickable', async ({ page }) => {
    const pullButton = dashboardButton(page, /Pull/i);
    await expect(pullButton).toBeEnabled();
  });

  test('Push button should be clickable', async ({ page }) => {
    const pushButton = dashboardButton(page, /Push/i);
    await expect(pushButton).toBeEnabled();
  });
});

// ============================================================================
// A repository with no remote at all
//
// There are FIVE ways to ask for a fetch, a pull or a push: the toolbar's
// three buttons, the dashboard's three identical copies directly below them,
// the Ctrl+Shift+F / P / U shortcuts, the command palette's three entries and
// the native Repository menu. The two button surfaces greyed their copies out
// and explained why; the three that have no button to grey ran the operation
// on a freshly `git init`ed folder — a cancellable progress row, then a red
// toast carrying git's own "remote 'origin' does not exist", a dead end one
// row below a button that had already said the operation was unavailable.
//
// The refusal now lives on the runner all five go through, so every one of
// them is covered here.
// ============================================================================

test.describe('Fetch, Pull and Push with no remote configured', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, { remotes: [] });
    await startCommandCaptureWithMocks(page, {
      get_remotes: [],
      fetch: null,
      pull: null,
      push: null,
    });
    // An empty list is only an ANSWER once `get_remotes` has come back: the
    // store seeds every tab with one before anything asks, and "not read yet"
    // must not be read as "no remote". The button going grey is that answer
    // landing, so settling on it here is what stops the presses below from
    // racing the round trip.
    await expect(page.locator('lv-toolbar').getByRole('button', { name: /Fetch/i })).toBeDisabled();
  });

  test('all three are disabled and say why', async ({ page }) => {
    for (const name of [/Fetch/i, /Pull/i, /Push/i]) {
      const btn = dashboardButton(page, name);
      await expect(btn).toBeDisabled();
      await expect(btn).toHaveAttribute('title', /no remote configured/);
    }
  });

  test('agrees with the toolbar copy of the same button', async ({ page }) => {
    // The one place these tests reach across to the toolbar: the finding was
    // precisely that the two surfaces disagreed about the same repository.
    for (const name of [/Fetch/i, /Pull/i, /Push/i]) {
      await expect(page.locator('lv-toolbar').getByRole('button', { name })).toBeDisabled();
      await expect(dashboardButton(page, name)).toBeDisabled();
    }
  });

  /**
   * A click that lands anyway.
   *
   * `click({ force: true })` on a disabled <button> is not a click at all —
   * Chromium never dispatches one, so a test written that way passes with the
   * guard deleted. `dispatchEvent` is the click itself, which is what the race
   * window between a render and the button going grey delivers: the remote
   * removed from another surface a moment before the mouse came down.
   */
  test('a click that lands anyway starts nothing and says why', async ({ page }) => {
    await dashboardButton(page, /Fetch/i).dispatchEvent('click');

    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
    await expect(page.locator('.progress-message')).toHaveCount(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  /**
   * The keyboard, which has no button to grey out.
   *
   * Ctrl+Shift+F / P / U reach app-shell's handleFetch/handlePull/handlePush,
   * the same three the palette and the native menu converge on. Each press
   * used to reach git.
   */
  test('the Ctrl+Shift+F / P / U shortcuts refuse instead of running', async ({ page }) => {
    await page.keyboard.press('Control+Shift+F');
    // The toast is the settle point: once it is on screen the press has been
    // processed end to end, so "no command was sent" is a real absence.
    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'fetch'), 'no fetch reached git').toHaveLength(0);

    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.press('Control+Shift+U');
    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'pull'), 'no pull reached git').toHaveLength(0);
    expect(await findCommand(page, 'push'), 'no push reached git').toHaveLength(0);

    await expect(page.locator('.progress-message'), 'and no row was opened').toHaveCount(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });

  test('a held-down shortcut is answered once, not once per repeat', async ({ page }) => {
    // keyboardService has no `e.repeat` guard, so holding Ctrl+Shift+F asks
    // many times a second — and every ask is refused, so one toast per ask
    // would bury the screen in identical warnings.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Shift+F');

    await expect(page.locator('.toast.warning')).toHaveCount(1);
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
  });

  test('the command palette entries refuse instead of running', async ({ page }) => {
    await openViaCommandPalette(page, 'Fetch from remote');

    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'fetch')).toHaveLength(0);
    await expect(page.locator('.progress-message')).toHaveCount(0);
  });

  test('the refusal carries the way to do what it asks', async ({ page }) => {
    // "add one first" named a remedy whose only route was knowing that the
    // command palette carries "Manage remotes".
    await page.keyboard.press('Control+Shift+F');

    const toast = page.locator('.toast.warning');
    await expect(toast).toContainText('No remote configured');
    await toast.locator('.toast-action-btn').click();

    await expect(page.locator('lv-remote-dialog')).toBeVisible();
  });

  /**
   * The remedy applied from OUTSIDE the app.
   *
   * `git remote add origin …` in a terminal writes `.git/config`; the backend
   * watcher classifies that as `config-changed` and emits it. Nothing listened
   * for it, and the store's `remotes` — what greys these buttons out and what
   * the runner refuses on — is written only by a refresh and by tab
   * activation, neither of which fires for the repository already on screen.
   * So the refusal outlived its own remedy: every surface went on saying there
   * was no remote while the dialog its toast offers listed one.
   */
  test('a remote added outside the app lifts the refusal, on the repo being looked at', async ({
    page,
  }) => {
    await injectCommandMock(page, {
      get_remotes: [{ name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null }],
    });

    await emitBackendEvent(page, 'file-change', {
      repoPath: '/tmp/test-repo',
      eventType: 'config-changed',
      paths: [],
    });

    await expect(page.locator('lv-toolbar').getByRole('button', { name: /Fetch/i })).toBeEnabled();
    await expect(dashboardButton(page, /Fetch/i)).toBeEnabled();
    // And the three surfaces that have no button to grey out let it through.
    await page.keyboard.press('Control+Shift+F');
    await waitForCommand(page, 'fetch');
    await expect(page.locator('.toast.warning')).toHaveCount(0);
  });

  test('the native Repository menu items refuse instead of running', async ({ page }) => {
    // Playwright cannot click a native menu; choosing an item is exactly this
    // event, carrying the item id (see app-menu.spec.ts).
    await emitBackendEvent(page, 'app-menu-action', 'push');

    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'push')).toHaveLength(0);
    await expect(page.locator('.progress-message')).toHaveCount(0);
  });

  /**
   * TWO repositories with no remote, refused one after the other.
   *
   * The refusal is said once per burst so that a held-down Ctrl+Shift+F does
   * not bury the screen — but it also carries a button pinned to ONE
   * repository. Held back on the words alone, the second repository's refusal
   * was discarded as a repeat of the first's, and the button still on screen
   * belonged to the repository the user had switched away from: pressing it
   * offered to add a remote to the wrong one.
   */
  test('a refusal on a second repository is not answered with the first one’s remedy', async ({
    page,
  }) => {
    const warnings = page.locator('.toast.warning');

    // The race window between a render and the click — the click the disabled
    // button never dispatches, which is why this is `dispatchEvent`.
    await dashboardButton(page, /Fetch/i).dispatchEvent('click');
    await expect(warnings).toHaveCount(1);
    await expect(warnings.first(), 'the refusal names its repository').toContainText('test-repo');

    // A second repository, with no remote either, becomes the active tab
    // while the first refusal is still on screen.
    await addRepo(page, '/tmp/other-repo', 'other-repo');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/tmp/other-repo'
    );
    await expect(dashboardButton(page, /Fetch/i)).toBeDisabled();

    await dashboardButton(page, /Fetch/i).dispatchEvent('click');

    await expect(warnings, 'the second repository is answered too').toHaveCount(2);
    await expect(warnings.nth(1)).toContainText('other-repo');
    expect(await findCommand(page, 'fetch'), 'and neither reached git').toHaveLength(0);

    // The remedy beside it belongs to the repository it names.
    await warnings.nth(1).locator('.toast-action-btn').click();
    await expect(page.locator('lv-remote-dialog')).toBeVisible();
  });
});

/**
 * Guards the block above: a rule that refused always would pass every one of
 * those tests. The same three surfaces, on a repository that HAS a remote.
 */
test.describe('the same surfaces still work once a remote exists', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { fetch: null, push: null });
  });

  test('Ctrl+Shift+F fetches', async ({ page }) => {
    await page.keyboard.press('Control+Shift+F');

    await waitForCommand(page, 'fetch');
    await expect(page.locator('.toast.warning')).toHaveCount(0);
  });

  test('the palette entry fetches', async ({ page }) => {
    await openViaCommandPalette(page, 'Fetch from remote');

    await waitForCommand(page, 'fetch');
    await expect(page.locator('.toast.warning')).toHaveCount(0);
  });

  test('the native menu item pushes', async ({ page }) => {
    await emitBackendEvent(page, 'app-menu-action', 'push');

    await waitForCommand(page, 'push');
    await expect(page.locator('.toast.warning')).toHaveCount(0);
  });
});

// ============================================================================
// Ahead/Behind Badge Tests
// ============================================================================

test.describe('Ahead/Behind Badges', () => {
  let app: AppPage;

  test('should show Push badge when commits are ahead', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(5, 0));

    // Push badge should show ahead count
    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('5');
  });

  test('should show Pull badge when commits are behind', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 3));

    // Pull badge should show behind count
    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('3');
  });

  test('should show both badges when ahead and behind', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(2, 4));

    // Both badges should be visible
    const pushBadge = page.locator('.badge.push');
    const pullBadge = page.locator('.badge.pull');

    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('2');

    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('4');
  });

  test('should not show badges when up to date (0/0)', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 0));

    // Neither badge should be visible
    const pushBadge = page.locator('.badge.push');
    const pullBadge = page.locator('.badge.pull');

    await expect(pushBadge).not.toBeVisible();
    await expect(pullBadge).not.toBeVisible();
  });

  test('Push badge should have success color styling', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    // Check badge exists and has the push class (styling is applied via CSS)
    await expect(pushBadge).toHaveClass(/push/);
  });

  test('Pull badge should have primary color styling', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 2));

    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    // Check badge exists and has the pull class (styling is applied via CSS)
    await expect(pullBadge).toHaveClass(/pull/);
  });
});

// ============================================================================
// Status-bar ahead/behind badge
//
// The status bar used to render its own copy of the counts, written only by a
// tab switch, the fetch-on-focus handler and auto-fetch. push/pull/fetch never
// touched it, so it kept advertising commits that had already been pushed
// while the dashboard badge a few pixels away had already cleared. It now
// renders the same store field every other badge does.
// ============================================================================

test.describe('Status-bar ahead/behind badge', () => {
  const aheadBadge = (page: import('@playwright/test').Page) =>
    page.locator('footer.status-bar .status-ahead');
  const behindBadge = (page: import('@playwright/test').Page) =>
    page.locator('footer.status-bar .status-behind');

  test('shows the unpushed count for the open repository', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(3, 0));

    await expect(aheadBadge(page)).toHaveText('↑3');
    await expect(behindBadge(page)).toHaveCount(0);
  });

  test('clears after a successful push, agreeing with the dashboard badge', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(3, 0));
    await expect(aheadBadge(page)).toHaveText('↑3');

    await startCommandCapture(page);
    await dashboardButton(page, /Push/i).click();
    await waitForCommand(page, 'push');

    await expect(aheadBadge(page)).toHaveCount(0);
    await expect(page.locator('.badge.push')).toHaveCount(0);
    // The status bar is still there — only the badge went away
    await expect(page.locator('footer.status-bar')).toContainText('/tmp/test-repo');
  });

  test('clears after a successful pull', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(0, 2));
    await expect(behindBadge(page)).toHaveText('↓2');

    await startCommandCapture(page);
    await dashboardButton(page, /Pull/i).click();
    await waitForCommand(page, 'pull');

    await expect(behindBadge(page)).toHaveCount(0);
  });

  test('survives a rejected push, so the commits stay visible', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(3, 0));
    await expect(aheadBadge(page)).toHaveText('↑3');

    await injectCommandError(page, 'push', 'Push rejected: non-fast-forward');
    await dashboardButton(page, /Push/i).click();

    await expect(page.locator('.toast')).toBeVisible({ timeout: 5000 });
    await expect(aheadBadge(page)).toHaveText('↑3');
  });

  test('shows no badge when up to date', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(0, 0));

    await expect(page.locator('footer.status-bar')).toContainText('/tmp/test-repo');
    await expect(aheadBadge(page)).toHaveCount(0);
    await expect(behindBadge(page)).toHaveCount(0);
  });
});

// ============================================================================
// Branch List Ahead/Behind Indicator Tests
// ============================================================================

test.describe('Branch List Ahead/Behind Indicators', () => {
  let app: AppPage;

  test('should show ahead indicator on branch with upstream', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    // The branch list should show ahead indicator
    const aheadIndicator = page.locator('.ahead-behind .ahead');
    await expect(aheadIndicator.first()).toBeVisible();
    await expect(aheadIndicator.first()).toContainText('3');
  });

  test('should show behind indicator on branch with upstream', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 2));

    // The branch list should show behind indicator
    const behindIndicator = page.locator('.ahead-behind .behind');
    await expect(behindIndicator.first()).toBeVisible();
    await expect(behindIndicator.first()).toContainText('2');
  });

  test('should show both ahead and behind indicators', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(5, 3));

    const aheadIndicator = page.locator('.ahead-behind .ahead');
    const behindIndicator = page.locator('.ahead-behind .behind');

    await expect(aheadIndicator.first()).toBeVisible();
    await expect(behindIndicator.first()).toBeVisible();
  });

  test('should not show indicators when synced', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 0));

    // No ahead/behind indicators should be visible
    const aheadBehind = page.locator('.ahead-behind');
    await expect(aheadBehind).not.toBeVisible();
  });
});

// ============================================================================
// Button Tooltip Tests
// ============================================================================

test.describe('Remote Button Tooltips', () => {
  let app: AppPage;

  test('Push button should have push tooltip', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(5, 0));

    const pushButton = dashboardButton(page, /Push/i);
    const title = await pushButton.getAttribute('title');
    expect(title).toContain('Push');
  });

  test('Pull button should have pull tooltip', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 3));

    const pullButton = dashboardButton(page, /Pull/i);
    const title = await pullButton.getAttribute('title');
    expect(title).toContain('Pull');
  });

  test('Fetch button should have fetch tooltip', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);

    const fetchButton = dashboardButton(page, /Fetch/i);
    const title = await fetchButton.getAttribute('title');
    expect(title).toContain('Fetch');
  });
});

// ============================================================================
// Large Badge Values Tests
// ============================================================================

test.describe('Large Badge Values', () => {
  let app: AppPage;

  test('should display large ahead count correctly', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(42, 0));

    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('42');
  });

  test('should display large behind count correctly', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 100));

    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('100');
  });
});

// ============================================================================
// Context Dashboard Visibility Tests
// ============================================================================

test.describe('Context Dashboard', () => {
  let app: AppPage;

  test('should show context dashboard when repository is open', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);

    const contextDashboard = page.locator('lv-context-dashboard');
    await expect(contextDashboard).toBeVisible();
  });

  test('should show remote buttons section', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);

    // Remote buttons should be in a group
    const fetchBtn = dashboardButton(page, /Fetch/i);
    const pullBtn = dashboardButton(page, /Pull/i);
    const pushBtn = dashboardButton(page, /Push/i);

    await expect(fetchBtn).toBeVisible();
    await expect(pullBtn).toBeVisible();
    await expect(pushBtn).toBeVisible();
  });
});

// ============================================================================
// Fetch Operation Tests
// ============================================================================

test.describe('Fetch Operation', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('clicking Fetch button should invoke fetch and re-check remote status', async ({ page }) => {
    await startCommandCapture(page);

    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();

    await waitForCommand(page, 'fetch');

    const fetchCommands = await findCommand(page, 'fetch');
    expect(fetchCommands.length).toBeGreaterThan(0);
    // Whatever the repo resolved is what the backend must be told to fetch —
    // an unresolved remote leaves the backend to guess a second time, against
    // config the network gate never saw.
    expect((fetchCommands[0].args as { remote?: string }).remote).toBe('origin');

    // After fetch completes, the app should refresh remote status to update badges
    await waitForCommand(page, 'get_remote_status');

    // Verify the Fetch button is re-enabled (not stuck in loading state)
    await expect(fetchButton).toBeEnabled();
  });

  test('fetch failure should show error toast and keep button enabled', async ({ page }) => {
    await injectCommandError(page, 'fetch', 'Network error: unable to reach remote');

    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();

    // Error toast should appear with the specific error message
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText(/error|fail|unable/i);

    // Fetch button should be re-enabled so user can retry
    await expect(fetchButton).toBeEnabled();
  });
});

// ============================================================================
// Remote selection — fetch/pull/push must target the remote the repo resolves,
// not a hard-coded "origin". In the ordinary fork layout (origin = your fork,
// the branch tracking a canonical remote elsewhere) those are different hosts.
// ============================================================================

test.describe('Remote selection for fetch/pull/push', () => {
  /** origin is the fork; the checked-out branch tracks `upstream`. */
  const forkRemotes = {
    remotes: [
      { name: 'origin', url: 'https://github.com/me/repo.git', pushUrl: null },
      { name: 'upstream', url: 'https://gitlab.example.test/acme/repo.git', pushUrl: null },
    ],
  } as Partial<typeof defaultMockData>;

  test('fetch targets the branch upstream, not origin', async ({ page }) => {
    await setupOpenRepository(page, forkRemotes);
    await startCommandCaptureWithMocks(page, { get_fetch_remote: 'upstream', fetch: null });

    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();
    await waitForCommand(page, 'fetch');

    const [call] = await findCommand(page, 'fetch');
    expect((call.args as { remote?: string }).remote).toBe('upstream');

    // And the operation completes visibly: status is re-read and the button
    // comes back, rather than the app hanging on a remote it never resolved.
    await waitForCommand(page, 'get_remote_status');
    await expect(fetchButton).toBeEnabled();
  });

  test('pull targets the branch upstream, not origin', async ({ page }) => {
    await setupOpenRepository(page, forkRemotes);
    await startCommandCaptureWithMocks(page, { get_pull_remote: 'upstream', pull: null });

    const pullButton = dashboardButton(page, /Pull/i);
    await pullButton.click();
    await waitForCommand(page, 'pull');

    const [call] = await findCommand(page, 'pull');
    expect((call.args as { remote?: string }).remote).toBe('upstream');
    await expect(pullButton).toBeEnabled();
  });

  test('push targets the resolved push remote, not origin', async ({ page }) => {
    await setupOpenRepository(page, forkRemotes);
    await startCommandCaptureWithMocks(page, { get_push_remote: 'upstream', push: null });

    const pushButton = dashboardButton(page, /^Push/i);
    await pushButton.click();
    await waitForCommand(page, 'push');

    const [call] = await findCommand(page, 'push');
    expect((call.args as { remote?: string }).remote).toBe('upstream');
    await expect(pushButton).toBeEnabled();
  });

  test('a fetch whose remote cannot be resolved still runs and reports', async ({ page }) => {
    // A detached HEAD, or a repo with no remote at all: resolution fails. The
    // fetch must still reach the backend so the REAL error is what the user
    // sees — not a silent no-op here.
    await setupOpenRepository(page, forkRemotes);
    await startCommandCapture(page);
    await injectCommandError(page, 'get_fetch_remote', 'Remote not found: origin');

    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();
    await waitForCommand(page, 'fetch');

    const [call] = await findCommand(page, 'fetch');
    expect((call.args as { remote?: string }).remote).toBeUndefined();
    await expect(fetchButton).toBeEnabled();
  });
});

// ============================================================================
// Push Operation Tests
// ============================================================================

test.describe('Push Operation', () => {
  let app: AppPage;

  test('clicking Push button should push and clear ahead badge', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    // Verify push badge initially shows 3 ahead
    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');

    await startCommandCapture(page);

    const pushButton = dashboardButton(page, /Push/i);
    await pushButton.click();

    await waitForCommand(page, 'push');

    const pushCommands = await findCommand(page, 'push');
    expect(pushCommands.length).toBeGreaterThan(0);

    // Verify DOM: push badge should disappear after successful push (ahead = 0)
    await expect(pushBadge).not.toBeVisible();

    // Verify Push button is re-enabled after operation completes
    await expect(pushButton).toBeEnabled();
  });

  test('push failure should show error toast with message and preserve badge', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    // Verify initial badge
    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');

    await injectCommandError(page, 'push', 'Push rejected: non-fast-forward');

    const pushButton = dashboardButton(page, /Push/i);
    await pushButton.click();

    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    // A non-fast-forward rejection is routed through the suggestion service,
    // which REPLACES the raw libgit2 string with the recovery the app can
    // actually perform. Assert that contract rather than the server's words.
    await expect(toast).toHaveClass(/error/);
    await expect(toast).toContainText(/pull before pushing/i);
    await expect(toast.getByRole('button', { name: 'Pull Now' })).toBeVisible();

    // Badge should remain unchanged after failed push
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');
  });

  test('push refused while the repository is busy says so and keeps the badge', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');

    // Exactly what the backend returns when an earlier push TIMED OUT and its
    // blocking task is still running: the frontend's own push lock was
    // released on that early return, so the retry reaches IPC and only the
    // backend registry can refuse it.
    await injectCommandError(
      page,
      'push',
      'A push is already running for this repository. Wait for it to finish and try again — an operation that timed out can still be finishing in the background.'
    );

    const pushButton = dashboardButton(page, /Push/i);
    await pushButton.click();

    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toHaveClass(/error/);
    await expect(toast).toContainText(/already running for this repository/i);
    // NOT rewritten by the timeout rule into "increase the timeout in
    // Settings", which sends the user to a setting that cannot help here.
    await expect(toast).not.toContainText(/increase the timeout/i);
    await expect(toast.getByRole('button', { name: 'Open Settings' })).toHaveCount(0);

    // Nothing was pushed, so the ahead badge must survive, and the button must
    // stay usable for the retry the message asks for.
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');
    await expect(pushButton).toBeEnabled();
  });
});

// ============================================================================
// Pull Operation Tests
// ============================================================================

// ============================================================================
// The push gate judges the PUSH url
// ============================================================================
test.describe('Push gate follows the push URL', () => {
  type SettingsStoreWindow = {
    __GITNADO_STORES__?: {
      settingsStore?: {
        getState: () => { setRemoteAllowlist: (domains: string[]) => void };
      };
    };
  };

  /** Set the allowlist through the store, the way the Settings dialog does. */
  async function setAllowlist(page: Page, domains: string[]): Promise<void> {
    await page.waitForFunction(
      () =>
        typeof (window as unknown as SettingsStoreWindow).__GITNADO_STORES__?.settingsStore !==
        'undefined'
    );
    await page.evaluate((list) => {
      (window as unknown as SettingsStoreWindow)
        .__GITNADO_STORES__!.settingsStore!.getState()
        .setRemoteAllowlist(list);
    }, domains);
  }

  /** origin fetches from github.com and pushes to gitlab.example. */
  const splitRemotes = [
    {
      name: 'origin',
      url: 'https://github.com/org/x.git',
      pushUrl: 'https://gitlab.example/org/x.git',
    },
  ];

  test('a push whose push URL is off the allowlist is refused, naming that host', async ({
    page,
  }) => {
    await setupOpenRepository(page, withAheadBehind(2, 0));
    await startCommandCaptureWithMocks(page, { get_remotes: splitRemotes, get_push_remote: 'origin' });
    await setAllowlist(page, ['github.com']);

    await dashboardButton(page, /Push/i).click();

    // The gate refuses before anything reaches the backend, and says why —
    // naming the host the push would really have gone to.
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('not in your allowlist');
    await expect(toast).toContainText('gitlab.example');
    expect(await findCommand(page, 'push')).toHaveLength(0);
    // And the unpushed commits are still there to be pushed elsewhere.
    await expect(page.locator('.badge.push')).toHaveText('2');
  });

  test('a push whose push URL is on the allowlist goes through', async ({ page }) => {
    await setupOpenRepository(page, withAheadBehind(2, 0));
    await startCommandCaptureWithMocks(page, { get_remotes: splitRemotes, get_push_remote: 'origin' });
    await setAllowlist(page, ['gitlab.example']);

    await dashboardButton(page, /Push/i).click();

    await waitForCommand(page, 'push');
    expect(await findCommand(page, 'push')).toHaveLength(1);
    // The badge clears: the push really happened, and nothing refused it.
    await expect(page.locator('.badge.push')).not.toBeVisible();
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});

test.describe('Pull Operation', () => {
  let app: AppPage;

  test('clicking Pull button should pull and clear behind badge', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 5));

    // Verify pull badge initially shows 5 behind
    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('5');

    await startCommandCapture(page);

    const pullButton = dashboardButton(page, /Pull/i);
    await pullButton.click();

    await waitForCommand(page, 'pull');

    const pullCommands = await findCommand(page, 'pull');
    expect(pullCommands.length).toBeGreaterThan(0);

    // Verify DOM: pull badge should disappear after successful pull (behind = 0)
    await expect(pullBadge).not.toBeVisible();

    // Verify Pull button is re-enabled after operation completes
    await expect(pullButton).toBeEnabled();
  });

  test('pull failure should show error toast with message and preserve badge', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 5));

    // Verify initial badge
    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('5');

    await injectCommandError(page, 'pull', 'Pull failed: merge conflict');

    const pullButton = dashboardButton(page, /Pull/i);
    await pullButton.click();

    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText(/error|fail|conflict/i);

    // Badge should remain unchanged after failed pull
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('5');
  });

  test('pull with conflicts should show merge state', async ({ page }) => {
    app = new AppPage(page);
    // Start with behind commits
    await setupOpenRepository(page, {
      ...withAheadBehind(0, 3),
      ...withConflicts(),
    });

    // Repository state should show 'merge' (conflict state)
    const conflictFile = page.locator('lv-file-status').getByRole('listitem', { name: /CONFLICT/ });
    await expect(conflictFile).toBeVisible();
  });
});

// ============================================================================
// Fetch followed by Badge Update Tests
// ============================================================================

test.describe('Remote Operation Sequences', () => {
  let app: AppPage;

  test('fetch should preserve existing badges after refresh', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(2, 3));

    // Verify badges are initially visible with correct counts
    const pushBadge = page.locator('.badge.push');
    const pullBadge = page.locator('.badge.pull');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('2');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('3');

    await startCommandCapture(page);

    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();

    await waitForCommand(page, 'get_remote_status');

    // After fetch, badges should still show the same counts (fetch doesn't change ahead/behind in mock)
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('2');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('3');
  });

  test('fetch should update branch list ahead/behind indicators', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(4, 1));

    // Verify branch list shows ahead/behind indicators
    const aheadIndicator = page.locator('.ahead-behind .ahead');
    const behindIndicator = page.locator('.ahead-behind .behind');
    await expect(aheadIndicator.first()).toBeVisible();
    await expect(aheadIndicator.first()).toContainText('4');
    await expect(behindIndicator.first()).toBeVisible();
    await expect(behindIndicator.first()).toContainText('1');

    await startCommandCapture(page);

    // Click fetch
    const fetchButton = dashboardButton(page, /Fetch/i);
    await fetchButton.click();

    await waitForCommand(page, 'fetch');

    // After fetch, the branch list should still show the indicators (mock data unchanged)
    await expect(aheadIndicator.first()).toBeVisible();
    await expect(behindIndicator.first()).toBeVisible();
  });
});

// ============================================================================
// UI Outcome Verification Tests
// ============================================================================

test.describe('Remote Operations - UI Outcome Verification', () => {
  let app: AppPage;

  test('push success: verify ahead badge disappears after push', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(5, 0));

    // Verify the push badge initially shows 5
    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('5');

    await startCommandCapture(page);

    // Click push -- the mock sets ahead to 0 on push
    const pushButton = dashboardButton(page, /Push/i);
    await pushButton.click();

    await waitForCommand(page, 'push');

    // After successful push, the ahead badge should disappear (ahead = 0)
    await expect(pushBadge).not.toBeVisible();
  });

  test('pull success: verify behind badge disappears after pull', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 4));

    // Verify the pull badge initially shows 4
    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('4');

    await startCommandCapture(page);

    // Click pull -- the mock sets behind to 0 on pull
    const pullButton = dashboardButton(page, /Pull/i);
    await pullButton.click();

    await waitForCommand(page, 'pull');

    // After successful pull, the behind badge should disappear (behind = 0)
    await expect(pullBadge).not.toBeVisible();
  });

  test('push failure: verify ahead badge remains unchanged', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(3, 0));

    // Verify the push badge initially shows 3
    const pushBadge = page.locator('.badge.push');
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');

    // Inject a push error
    await injectCommandError(page, 'push', 'Push rejected: non-fast-forward');

    const pushButton = dashboardButton(page, /Push/i);
    await pushButton.click();

    // Error toast should appear
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // The push badge should still show 3 (unchanged because push failed)
    await expect(pushBadge).toBeVisible();
    await expect(pushBadge).toHaveText('3');
  });

  test('pull failure: verify behind badge remains unchanged', async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, withAheadBehind(0, 7));

    // Verify the pull badge initially shows 7
    const pullBadge = page.locator('.badge.pull');
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('7');

    // Inject a pull error
    await injectCommandError(page, 'pull', 'Pull failed: merge conflict');

    const pullButton = dashboardButton(page, /Pull/i);
    await pullButton.click();

    // Error toast should appear
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // The pull badge should still show 7 (unchanged because pull failed)
    await expect(pullBadge).toBeVisible();
    await expect(pullBadge).toHaveText('7');
  });
});

// ============================================================================
// One runner behind every surface
//
// The dashboard's three buttons and the keyboard shortcuts / command palette
// used to be two separate implementations. The dashboard's never called the
// progress service, so a slow push showed nothing but a greyed-out button, and
// it guarded on a component-local flag the other surface could not see — so
// two gestures reached IPC and the backend refused the second with
// "A fetch is already running for this repository".
// ============================================================================

/**
 * The dashboard's own Fetch / Pull / Push control.
 *
 * Scoped to `.remote-btn` rather than matched by accessible name: once an
 * operation is running its progress row adds a "Cancel fetch" button, which a
 * bare `name: /Fetch/i` matches too — and a strict-mode violation is not the
 * failure these tests are looking for.
 *
 * Scoped to the dashboard as well: the toolbar now carries its own
 * `.remote-btn` trio with the same titles, so an unscoped `.remote-btn`
 * matches two elements. The toolbar copies are covered in toolbar.spec.ts.
 */
function remoteButton(page: Page, label: 'Fetch' | 'Pull' | 'Push') {
  return page.locator('lv-context-dashboard').locator(`.remote-btn[title^="${label}"]`);
}

test.describe('Shared remote-operation runner', () => {
  test('a dashboard fetch shows a progress row while it runs', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCapture(page);
    await injectCommandHang(page, 'fetch');

    const fetchButton = remoteButton(page, 'Fetch');
    await fetchButton.click();
    await waitForCommand(page, 'fetch');

    // The same labelled row the shortcut has always produced.
    await expect(page.locator('.progress-message')).toHaveText('Fetching from remote...');
    // And every remote control is refused for the duration, rather than left
    // lit and doing nothing but raising a refusal toast.
    await expect(fetchButton).toBeDisabled();
    await expect(remoteButton(page, 'Pull')).toBeDisabled();
    await expect(remoteButton(page, 'Push')).toBeDisabled();
  });

  test('the progress row is torn down when the fetch lands', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { fetch: null });

    const fetchButton = remoteButton(page, 'Fetch');
    await fetchButton.click();
    await waitForCommand(page, 'fetch');

    await expect(page.locator('.progress-message')).toHaveCount(0);
    await expect(fetchButton).toBeEnabled();
  });

  test('a second attempt from another surface is not a duplicate command', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCapture(page);
    await injectCommandHang(page, 'fetch');

    const fetchButton = remoteButton(page, 'Fetch');
    await fetchButton.click();
    await waitForCommand(page, 'fetch');
    await expect(fetchButton).toBeDisabled();

    // Ctrl+Shift+F is the OTHER surface for the very same operation — the one
    // the dashboard's component-local flag could not see.
    await page.keyboard.press('Control+Shift+F');
    // Ctrl+Shift+P is pull, which shares the one per-repository slot the
    // backend also keys on. Its refusal toast is the settle point: once it is
    // on screen, both keypresses have been fully processed.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.toast')).toContainText(
      /Another operation is already running/i
    );

    expect((await findCommand(page, 'fetch')).length, 'one fetch, not two').toBe(1);
    expect((await findCommand(page, 'pull')).length, 'and no pull behind it').toBe(0);
  });
});

// ============================================================================
// Cancelling a remote operation
//
// Fetch/pull/push used to advertise cancellation that did not exist: the
// progress row was never marked cancellable, so the indicator's Cancel button
// was unreachable dead code, and no operation id reached the backend, so
// `cancel_operation` had nothing to cancel. No backend code emitted
// `operation-progress` either, so the row showed an indeterminate stripe with
// no counts for as long as the transfer ran.
// ============================================================================

test.describe('Cancelling a remote operation', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  /** The operation id the app handed the given command. */
  async function operationIdOf(page: Page, command: string): Promise<string | undefined> {
    const [call] = await findCommand(page, command);
    return (call.args as { operationId?: string }).operationId;
  }

  test('a running fetch shows a cancellable progress row', async ({ page }) => {
    await startCommandCapture(page);
    await injectCommandHang(page, 'fetch');

    await dashboardButton(page, /Fetch/i).click();
    await waitForCommand(page, 'fetch');

    const row = page.locator('lv-progress-indicator .progress-item');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/fetch/i);
    await expect(page.locator('lv-progress-indicator .cancel-btn')).toBeVisible();

    // And the backend was told which row it belongs to, so a cancel can find it.
    expect(await operationIdOf(page, 'fetch')).toBeTruthy();
  });

  test('clicking Cancel invokes cancel_operation for that row and dismisses it', async ({
    page,
  }) => {
    await startCommandCapture(page);
    await injectCommandHang(page, 'fetch');

    await dashboardButton(page, /Fetch/i).click();
    await waitForCommand(page, 'fetch');

    const operationId = await operationIdOf(page, 'fetch');
    await page.locator('lv-progress-indicator .cancel-btn').click();

    await waitForCommand(page, 'cancel_operation');
    const [cancel] = await findCommand(page, 'cancel_operation');
    expect((cancel.args as { operationId?: string }).operationId).toBe(operationId);

    // The row goes away immediately — the user's click has visibly taken effect.
    await expect(page.locator('lv-progress-indicator .progress-item')).toHaveCount(0);
  });

  test('a running push is cancellable too', async ({ page }) => {
    await startCommandCapture(page);
    await injectCommandHang(page, 'push');

    await dashboardButton(page, /Push/i).click();
    await waitForCommand(page, 'push');

    await expect(page.locator('lv-progress-indicator .cancel-btn')).toBeVisible();

    const operationId = await operationIdOf(page, 'push');
    await page.locator('lv-progress-indicator .cancel-btn').click();
    await waitForCommand(page, 'cancel_operation');

    const [cancel] = await findCommand(page, 'cancel_operation');
    expect((cancel.args as { operationId?: string }).operationId).toBe(operationId);
  });

  test('the progress row shows the transfer counts the backend reports', async ({ page }) => {
    await startCommandCapture(page);
    await injectCommandHang(page, 'fetch');

    await dashboardButton(page, /Fetch/i).click();
    await waitForCommand(page, 'fetch');

    const operationId = await operationIdOf(page, 'fetch');
    await emitBackendEvent(page, 'operation-progress', {
      operationId,
      message: 'Fetching from origin',
      progress: 40,
      receivedObjects: 400,
      totalObjects: 1000,
      receivedBytes: 1024 * 1024,
    });

    const row = page.locator('lv-progress-indicator .progress-item');
    await expect(row).toContainText('Fetching from origin');
    await expect(row).toContainText('40%');
    await expect(row).toContainText('400 / 1,000 objects');
    await expect(row).toContainText('1.00 MiB');
  });
});


/**
 * The remote the refusal asks for, actually added.
 *
 * `remotes` in the repository store is what greys the three buttons out and
 * what the runner refuses on, and it used to be written only when a tab was
 * activated or a session restored. So a user could do exactly what the refusal
 * told them to — add a remote in the Remotes dialog — and every surface in the
 * app went on insisting the repository had none until they closed and reopened
 * the tab. Removing the last remote had the mirror problem: the buttons stayed
 * bright and the operation ended in git's own "remote 'origin' does not
 * exist", the dead end the refusal exists to remove.
 */
test.describe('remotes added and removed through the Remotes dialog', () => {
  const ORIGIN = { name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null };

  /**
   * A `get_remotes` that answers with what has actually been added or removed,
   * so the dialog's own add/remove is what gives this repository a remote —
   * seeding the store field directly is exactly what hid this bug.
   */
  async function statefulRemotes(
    page: Page,
    initial: Array<Record<string, unknown>>,
  ): Promise<void> {
    await page.evaluate((seed) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const inner = internals.invoke;
      let remotes = [...seed];
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'get_remotes' || command === 'add_remote' || command === 'remove_remote') {
          const captured = (window as unknown as {
            __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
          }).__INVOKED_COMMANDS__;
          if (captured) captured.push({ command, args });
          const a = (args ?? {}) as { name?: string; url?: string };
          if (command === 'add_remote') {
            remotes = [...remotes, { name: a.name, url: a.url, pushUrl: null }];
            return null;
          }
          if (command === 'remove_remote') {
            remotes = remotes.filter((r) => (r as { name?: string }).name !== a.name);
            return null;
          }
          return remotes;
        }
        return inner(command, args);
      };
    }, initial);
  }

  function toolbarFetch(page: Page) {
    return page.locator('lv-toolbar').getByRole('button', { name: /Fetch/i });
  }

  async function openRemotesDialog(page: Page): Promise<void> {
    await openViaCommandPalette(page, 'Manage remotes');
    await page.locator('lv-remote-dialog').waitFor({ state: 'visible' });
  }

  async function closeRemotesDialog(page: Page): Promise<void> {
    await page.locator('lv-remote-dialog .close-btn').click();
    await expect(page.locator('lv-remote-dialog')).toBeHidden();
  }

  test('adding the first remote makes Fetch work, with no reopening', async ({ page }) => {
    await setupOpenRepository(page, { remotes: [] });
    await startCommandCaptureWithMocks(page, { fetch: null, pull: null, push: null });
    await statefulRemotes(page, []);

    await expect(toolbarFetch(page), 'nowhere to fetch from, to begin with').toBeDisabled();

    await openRemotesDialog(page);
    const dialog = page.locator('lv-remote-dialog');
    await dialog.getByRole('button', { name: /add remote/i }).click();
    await dialog.locator('input').first().fill('origin');
    await dialog.locator('input').nth(1).fill('https://example.test/o/r.git');
    await dialog.getByRole('button', { name: /^save$/i }).click();
    await waitForCommand(page, 'add_remote');
    await closeRemotesDialog(page);

    await expect(toolbarFetch(page), 'the surfaces agree the remote exists').toBeEnabled();
    await expect(toolbarFetch(page)).toHaveAttribute('title', /Fetch from remote/);
    await expect(
      page.locator('lv-context-dashboard').getByRole('button', { name: /Fetch/i }),
    ).toBeEnabled();

    // And the shortcut, which has no button to grey out, really fetches now.
    await page.keyboard.press('Control+Shift+F');
    await waitForCommand(page, 'fetch');
    await expect(page.locator('.toast.warning')).toHaveCount(0);
  });

  test('removing the last remote puts the refusal back', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      fetch: null,
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
    await statefulRemotes(page, [ORIGIN]);

    await expect(toolbarFetch(page)).toBeEnabled();

    await openRemotesDialog(page);
    const dialog = page.locator('lv-remote-dialog');
    await dialog
      .locator('button[title*="Delete"], button[title*="Remove"], button[aria-label*="delete"]')
      .first()
      .click();
    await waitForCommand(page, 'remove_remote');
    await closeRemotesDialog(page);

    await expect(toolbarFetch(page), 'and the buttons stop offering it').toBeDisabled();
    await expect(toolbarFetch(page)).toHaveAttribute('title', /no remote configured/);

    // The shortcut is refused in the app's own words rather than by git.
    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('.toast.warning')).toContainText('No remote configured');
    expect(await findCommand(page, 'fetch'), 'nothing reached git').toHaveLength(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});
