import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks, initializeRepositoryStore } from '../fixtures/tauri-mock';
import { DialogsPage } from '../pages/dialogs.page';
import {
  findCommand,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E for the sidebar's Pull Requests section and the branch context menu's
 * "Create pull request..." entry.
 *
 * Provider mocks have to be in place BEFORE the repository is opened: hosting
 * provider detection runs once per repository and is cached, exactly as it is
 * in the app, so these tests stage the mocks between page load and the store
 * initialisation instead of using setupOpenRepository's one-shot helper.
 */

const PR_FIXTURE = {
  number: 42,
  title: 'Add the pull request sidebar',
  state: 'open',
  user: { login: 'octocat', id: 1, avatarUrl: '', name: 'Octo Cat', email: null },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mergedAt: null,
  headRef: 'feature/test',
  headSha: 'def456abc789',
  baseRef: 'main',
  draft: false,
  mergeable: true,
  htmlUrl: 'https://github.com/octo/leviathan/pull/42',
  additions: 10,
  deletions: 2,
  changedFiles: 1,
};

/** Open the app with GitHub detected and the given extra command mocks. */
async function openWithGitHub(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await setupTauriMocks(page);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await startCommandCaptureWithMocks(page, {
    detect_github_repo: { owner: 'octo', repo: 'leviathan', remoteName: 'origin' },
    ...overrides,
  });
  await initializeRepositoryStore(page);
}

function prSectionHeader(page: Page) {
  return page.locator('lv-left-panel .section-header').filter({ hasText: 'Pull Requests' });
}

function prList(page: Page) {
  return page.locator('lv-pull-request-list');
}

test.describe('Pull Requests sidebar section', () => {
  test('shows the section header for an open repository', async ({ page }) => {
    await openWithGitHub(page);
    await expect(prSectionHeader(page)).toBeVisible();
  });

  test('does not call the provider API until the section is expanded', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    // The section starts collapsed, so nothing has been fetched.
    await expect(prSectionHeader(page)).toBeVisible();
    expect(await findCommand(page, 'list_pull_requests')).toHaveLength(0);

    await prSectionHeader(page).click();
    await waitForCommand(page, 'list_pull_requests');

    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('lists open pull requests with number, title and author', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    await prSectionHeader(page).click();

    const item = prList(page).locator('.pr-item').first();
    await expect(item).toBeVisible();
    await expect(item).toContainText('Add the pull request sidebar');
    await expect(item).toContainText('#42');
    await expect(item).toContainText('Octo Cat');
    // The row is a real link, so assistive tech gets an activatable control
    // with a name that says where activating it goes.
    await expect(
      prList(page).getByRole('link', {
        name: 'Add the pull request sidebar, #42, opens in browser',
      }),
    ).toBeVisible();
    // And the header badge reports the count.
    await expect(prSectionHeader(page).locator('.count')).toHaveText('1');
  });

  test('shows an empty state rather than a blank section', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [],
    });

    await prSectionHeader(page).click();
    await expect(prList(page).locator('.empty')).toHaveText(/No open pull requests/);
  });

  test('offers to connect when the provider is detected but not authenticated', async ({
    page,
  }) => {
    // No keyring token: the default mock returns null for get_keyring_token.
    await openWithGitHub(page);

    await prSectionHeader(page).click();

    await expect(prList(page)).toContainText('Not connected to GitHub');
    const connect = prList(page).locator('button', { hasText: 'Connect to GitHub' });
    await expect(connect).toBeVisible();
    // An unauthenticated section must not pretend the repository has no PRs.
    await expect(prList(page).locator('.pr-item')).toHaveCount(0);
    expect(await findCommand(page, 'list_pull_requests')).toHaveLength(0);

    await connect.click();
    await expect(new DialogsPage(page).github.dialog).toBeVisible();
  });

  test('picks up a sign-in finished in the dialog, from the notice and on re-expand', async ({
    page,
  }) => {
    // The connect dialog never reports back to this section, so "Not
    // connected" must not be a dead end once the user has actually connected.
    await openWithGitHub(page);

    await prSectionHeader(page).click();
    await expect(prList(page)).toContainText('Not connected to GitHub');

    // The sign-in lands: the credential now exists for the same account.
    await injectCommandMock(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    await prList(page).locator('button', { hasText: 'Try again' }).click();
    await waitForCommand(page, 'list_pull_requests');
    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('re-checks the credential when a "not connected" section is re-expanded', async ({
    page,
  }) => {
    await openWithGitHub(page);

    await prSectionHeader(page).click();
    await expect(prList(page)).toContainText('Not connected to GitHub');

    await injectCommandMock(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    // Collapse and re-open: "Not connected" is not a cached result, so this
    // re-checks rather than replaying the stale answer.
    await prSectionHeader(page).click();
    await prSectionHeader(page).click();

    await waitForCommand(page, 'list_pull_requests');
    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('explains a failed load and recovers on retry', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    // Fail the first call, succeed afterwards.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      let failed = false;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'list_pull_requests' && !failed) {
          failed = true;
          throw new Error('API rate limit exceeded');
        }
        return original(command, args);
      };
    });

    await prSectionHeader(page).click();
    await expect(prList(page).locator('.error-notice')).toContainText('API rate limit exceeded');

    await prList(page).locator('button', { hasText: 'Retry' }).click();
    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('says why the list is unavailable in offline mode', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        settingsStore: { getState: () => { setOfflineMode: (v: boolean) => void } };
      };
      stores.settingsStore.getState().setOfflineMode(true);
    });

    await prSectionHeader(page).click();
    await expect(prList(page)).toContainText('offline mode');
    expect(await findCommand(page, 'list_pull_requests')).toHaveLength(0);
  });

  test('re-checks offline mode when the section is re-expanded', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    const setOffline = (value: boolean): Promise<void> =>
      page.evaluate((offline) => {
        const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
          settingsStore: { getState: () => { setOfflineMode: (v: boolean) => void } };
        };
        stores.settingsStore.getState().setOfflineMode(offline);
      }, value);

    await setOffline(true);
    await prSectionHeader(page).click();
    await expect(prList(page)).toContainText('offline mode is enabled');

    // Turning offline mode off and re-opening the section must re-check: the
    // offline state costs no provider call to recompute, so replaying it from
    // the cache would make the section lie about the user's own settings.
    await setOffline(false);
    await prSectionHeader(page).click();
    await prSectionHeader(page).click();

    await waitForCommand(page, 'list_pull_requests');
    await expect(prList(page)).not.toContainText('offline mode is enabled');
    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('names the allowlist as the reason and recovers once it is widened', async ({ page }) => {
    await openWithGitHub(page, {
      get_keyring_token: 'gh-token',
      list_pull_requests: [PR_FIXTURE],
    });

    // An allowlist that does not contain api.github.com makes the shared
    // network gate refuse the listing call before it reaches the backend.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        settingsStore: { getState: () => { setRemoteAllowlist: (v: string[]) => void } };
      };
      stores.settingsStore.getState().setRemoteAllowlist(['example.invalid']);
    });

    await prSectionHeader(page).click();

    await expect(prList(page)).toContainText('not in your remote allowlist');
    await expect(prList(page)).toContainText('Settings > Security');
    // A blocked section must not look like a repository with no pull requests.
    await expect(prList(page).locator('.pr-item')).toHaveCount(0);
    await expect(prList(page).locator('.empty')).toHaveCount(0);
    expect(await findCommand(page, 'list_pull_requests')).toHaveLength(0);

    // Widening the allowlist and using the notice's own action loads the list.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        settingsStore: { getState: () => { setRemoteAllowlist: (v: string[]) => void } };
      };
      stores.settingsStore.getState().setRemoteAllowlist([]);
    });
    await prList(page).locator('button', { hasText: 'Try again' }).click();

    await waitForCommand(page, 'list_pull_requests');
    await expect(prList(page).locator('.pr-item')).toHaveCount(1);
  });

  test('explains when the repository has no supported hosting provider', async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // Every detect_* command returns null in the default mocks.
    await startCommandCaptureWithMocks(page, {});
    await initializeRepositoryStore(page);

    await prSectionHeader(page).click();
    await expect(prList(page)).toContainText(
      'No GitHub, GitLab, Bitbucket or Azure DevOps remote',
    );
  });
});

test.describe('Branch context menu - Create pull request', () => {
  test('opens the GitHub create form prefilled with the branch', async ({ page }) => {
    await openWithGitHub(page, { get_keyring_token: 'gh-token' });

    // "main" is the default mock's checked-out branch and has an upstream.
    const branchRow = page.locator('lv-branch-list .branch-item').first();
    await expect(branchRow).toBeVisible();
    await branchRow.click({ button: 'right' });

    const entry = page
      .locator('lv-branch-list .context-menu-item')
      .filter({ hasText: 'Create pull request' });
    await expect(entry).toBeVisible();
    await expect(entry).toBeEnabled();
    await entry.click();

    const dialogs = new DialogsPage(page);
    await expect(dialogs.github.dialog).toBeVisible();
    // The create form is showing, with the branch as the head.
    const head = page.locator('lv-github-dialog input[placeholder="feature-branch"]');
    await expect(head).toBeVisible();
    await expect(head).toHaveValue('main');
  });

  test('is disabled with an explanation for a branch without an upstream', async ({ page }) => {
    await openWithGitHub(page);

    // The second branch in the default mocks is "feature/test", which has no
    // upstream. It renders inside its "feature" prefix group, so the row shows
    // the stripped name.
    const branchRow = page
      .locator('lv-branch-list .branch-item')
      .filter({ has: page.locator('.branch-name', { hasText: /^test$/ }) })
      .first();
    await expect(branchRow).toBeVisible();
    await branchRow.click({ button: 'right' });

    const entry = page
      .locator('lv-branch-list .context-menu-item')
      .filter({ hasText: 'Create pull request' });
    await expect(entry).toBeVisible();
    await expect(entry).toBeDisabled();
    await expect(entry).toHaveAttribute('title', /upstream/);
  });

  test('is disabled when no hosting provider is detected', async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await startCommandCaptureWithMocks(page, {});
    await initializeRepositoryStore(page);

    const branchRow = page.locator('lv-branch-list .branch-item').first();
    await expect(branchRow).toBeVisible();
    await branchRow.click({ button: 'right' });

    const entry = page
      .locator('lv-branch-list .context-menu-item')
      .filter({ hasText: 'Create pull request' });
    await expect(entry).toBeDisabled();
    await expect(entry).toHaveAttribute('title', /No GitHub, GitLab, Bitbucket or Azure DevOps/);
  });
});
