import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * The palette is loaded per repository: it caches the active repo's branches
 * and tracked files at open time and every entry it dispatches is scoped to
 * that repository. These specs cover the repository boundary from the real
 * surfaces — Ctrl/Cmd+P and the tab bar — rather than the internal flags.
 */

const palette = 'lv-command-palette[open]';

async function addRepo(page: Page, path: string, name: string): Promise<void> {
  await page.evaluate(
    ({ path, name }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => { addRepository: (repo: unknown) => void };
        };
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

test.describe('Command palette repository boundary', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('an open palette closes when the active repository changes', async ({ page }) => {
    await addRepo(page, '/work/other-repo', 'other-repo');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/other-repo'
    );

    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();

    // Ctrl+digit, not a click: the palette is a full-screen overlay, so a
    // click on the tab would dismiss it through the backdrop and prove
    // nothing about the repository switch.
    await page.keyboard.press('Control+1');

    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');
    await expect(page.locator(palette)).toHaveCount(0);
  });

  test('a failed branch load is reported and the palette still opens', async ({ page }) => {
    await injectCommandError(page, 'get_branches', 'branches unavailable');

    await page.keyboard.press('Meta+p');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'Failed to load branches: branches unavailable'
    );
    await expect(page.locator(palette)).toBeVisible();
  });

  test('a failed tracked-file load is reported and the palette still opens', async ({ page }) => {
    await injectCommandError(page, 'list_tracked_files', 'index unreadable');

    await page.keyboard.press('Meta+p');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'Failed to load tracked files: index unreadable'
    );
    await expect(page.locator(palette)).toBeVisible();
  });

  test('an ordinary open reports nothing', async ({ page }) => {
    await page.keyboard.press('Meta+p');

    await expect(page.locator(palette)).toBeVisible();
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });
});

/**
 * "Open in Terminal" / "Reveal in File Manager" / "Open in Editor" act on the
 * ACTIVE repository. Success is the OS opening something, so the only visible
 * outcome is the palette closing; a backend failure must reach the user.
 */
test.describe('Command palette: open the active repository elsewhere', () => {
  async function runCommand(page: Page, label: string): Promise<void> {
    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();
    await page.locator(`${palette} .search-input`).fill(label);
    const entry = page.locator(`${palette} .command`, { hasText: label }).first();
    await expect(entry).toBeVisible();
    await entry.click();
  }

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // The editor command resolves with an OpenResult payload; the unmocked
    // default (null) would legitimately be treated as a failure.
    await startCommandCaptureWithMocks(page, {
      open_terminal: null,
      open_file_manager: null,
      open_in_configured_editor: { success: true, message: 'Opened in code' },
    });
  });

  test('Open in Terminal runs open_terminal for the active repository', async ({ page }) => {
    await runCommand(page, 'Open in Terminal');

    await waitForCommand(page, 'open_terminal');
    const calls = await findCommand(page, 'open_terminal');
    expect(calls[0].args).toMatchObject({ path: '/tmp/test-repo' });

    await expect(page.locator(palette)).toHaveCount(0);
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Reveal in File Manager runs open_file_manager for the active repository', async ({
    page,
  }) => {
    await runCommand(page, 'Reveal in File Manager');

    await waitForCommand(page, 'open_file_manager');
    const calls = await findCommand(page, 'open_file_manager');
    expect(calls[0].args).toMatchObject({ path: '/tmp/test-repo' });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('Open in Editor opens the repository root in the configured editor', async ({ page }) => {
    await runCommand(page, 'Open in Editor');

    await waitForCommand(page, 'open_in_configured_editor');
    const calls = await findCommand(page, 'open_in_configured_editor');
    expect(calls[0].args).toMatchObject({
      path: '/tmp/test-repo',
      filePath: '/tmp/test-repo',
    });
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });

  test('a backend failure surfaces its own message as an error toast', async ({ page }) => {
    await injectCommandError(
      page,
      'open_terminal',
      'Operation failed: No terminal emulator found',
      'OPERATION_FAILED'
    );

    await runCommand(page, 'Open in Terminal');

    await expect(page.locator('lv-toast-container .toast.error')).toContainText(
      'No terminal emulator found'
    );
  });
});

/**
 * app-shell no longer pulls the graph's loaded commits and tag tips from
 * inside render() — it mirrors them into state and refreshes that mirror when
 * the graph announces a change, and it memoises the static command list. These
 * specs are the regression check that the mirror never goes stale: everything
 * the palette lists (actions, branches, files, commits, tags) must still be
 * there, including data the graph only loaded after the first render.
 */
test.describe('Command palette data freshness', () => {
  const REFS_WITH_TAG = {
    abc123def456: [
      { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
      { name: 'refs/tags/v1.0.0', shorthand: 'v1.0.0', refType: 'tag', isHead: false },
    ],
  };

  const EXTRA_COMMIT = {
    oid: 'fed321cba987',
    shortId: 'fed321c',
    message: 'Palette regression commit',
    summary: 'Palette regression commit',
    body: null,
    author: { name: 'Test User', email: 'test@example.com', timestamp: 1700000000 },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: 1700000000 },
    parentIds: ['abc123def456'],
    timestamp: 1700000000,
  };

  // The graph canvas exposes its loaded set as public methods, so the specs
  // drive it through a locator (which pierces the shadow DOM for us) rather
  // than reaching into shadowRoot by hand.
  const graph = (page: Page) => page.locator('lv-graph-canvas');

  /** Wait until the graph canvas holds exactly `count` loaded commits. */
  async function waitForGraphLoaded(page: Page, count: number): Promise<void> {
    await expect
      .poll(() =>
        graph(page).evaluate((el) => (el as unknown as {
          getLoadedCommits: () => unknown[];
        }).getLoadedCommits().length)
      )
      .toBe(count);
  }

  /** Wait until the graph canvas holds exactly `count` tag tips. */
  async function waitForGraphTags(page: Page, count: number): Promise<void> {
    await expect
      .poll(() =>
        graph(page).evaluate((el) => (el as unknown as {
          getTagTips: () => unknown[];
        }).getTagTips().length)
      )
      .toBe(count);
  }

  /** Reload the graph the way a fetch, pull or new commit does. */
  async function reloadGraph(page: Page): Promise<void> {
    await graph(page).evaluate((el) => (el as unknown as { refresh: () => void }).refresh());
  }

  function item(page: Page, text: string) {
    return page.locator(`${palette} .command`, { hasText: text });
  }

  async function search(page: Page, query: string): Promise<void> {
    await page.locator(`${palette} .search-input`).fill(query);
  }

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await waitForGraphLoaded(page, 2);
  });

  test('lists actions, branches, files, commits and tags from the loaded graph', async ({
    page,
  }) => {
    await injectCommandMock(page, {
      list_tracked_files: ['src/main.ts', 'README.md'],
      get_refs_by_commit: REFS_WITH_TAG,
    });
    // Pick up the refs the mock now returns (the first load ran without them).
    await reloadGraph(page);
    await waitForGraphTags(page, 1);

    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();

    // Actions and branches show with no query at all.
    await expect(item(page, 'Fetch from remote')).toHaveCount(1);
    await expect(item(page, 'Switch to feature/test')).toHaveCount(1);

    // Files, commits and tag reveals are searchable (they are excluded from
    // the empty-query view so they don't drown the actions).
    await search(page, 'main.ts');
    await expect(item(page, 'src/main.ts')).toHaveCount(1);

    await search(page, 'Initial commit');
    await expect(item(page, 'abc123d Initial commit')).toHaveCount(1);

    await search(page, 'Reveal tag');
    await expect(item(page, 'Reveal tag v1.0.0 in graph')).toHaveCount(1);
  });

  test('an open palette picks up commits the graph loads afterwards', async ({ page }) => {
    await page.keyboard.press('Meta+p');
    await expect(page.locator(palette)).toBeVisible();

    // The palette is already open, so nothing re-reads the graph on its
    // behalf — only the graph's own change announcement can refresh it.
    await search(page, 'Palette regression');
    await expect(page.locator(`${palette} .empty`)).toBeVisible();

    await injectCommandMock(page, {
      get_commit_history: [
        EXTRA_COMMIT,
        {
          oid: 'abc123def456',
          shortId: 'abc123d',
          message: 'Initial commit',
          summary: 'Initial commit',
          body: null,
          author: { name: 'Test User', email: 'test@example.com', timestamp: 1699999000 },
          committer: { name: 'Test User', email: 'test@example.com', timestamp: 1699999000 },
          parentIds: [],
          timestamp: 1699999000,
        },
      ],
    });
    await reloadGraph(page);
    await waitForGraphLoaded(page, 2);

    await expect(item(page, 'fed321c Palette regression commit')).toHaveCount(1);
  });
});
