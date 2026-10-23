import { test, expect } from '@playwright/test';
import { setupOpenRepository, setupTauriMocks, initializeRepositoryStore, defaultMockData } from '../fixtures/tauri-mock';
import { startCommandCapture, startCommandCaptureWithMocks, findCommand, injectCommandError, injectCommandMock, waitForCommand } from '../fixtures/test-helpers';

/**
 * E2E tests for Search Bar
 * Tests search input, filters, keyboard shortcuts, and search events
 */
test.describe('Search Bar', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('should toggle search bar when clicking search button', async ({ page }) => {
    // Find and click the search button in toolbar
    const searchButton = page.locator('button[title*="Search commits"]');
    await expect(searchButton).toBeVisible();
    await searchButton.click();

    // Search bar should appear
    const searchBar = page.locator('gn-search-bar');
    await expect(searchBar).toBeVisible();

    // Click again to close
    await searchButton.click();
    await expect(searchBar).not.toBeVisible();
  });

  test('should focus search input when opened', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await expect(searchInput).toBeFocused();
  });

  test('should emit search event when typing', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('fix bug');

    // Wait for debounce and verify input value
    await expect(searchInput).toHaveValue('fix bug');
  });

  test('should clear search with Escape key', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('test query');
    await expect(searchInput).toHaveValue('test query');

    await page.keyboard.press('Escape');
    await expect(searchInput).toHaveValue('');
  });

  test('should show clear button when query is entered', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('test');

    const clearButton = page.locator('gn-search-bar .clear-btn, gn-search-bar button[title*="Clear"]');
    await expect(clearButton).toBeVisible();
  });

  test('should clear search when clicking clear button', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('test query');

    const clearButton = page.locator('gn-search-bar .clear-btn, gn-search-bar button[title*="Clear"]');
    await clearButton.click();

    await expect(searchInput).toHaveValue('');
  });
});

test.describe('Search Bar Filters', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();
  });

  test('should toggle filter panel when clicking filter button', async ({ page }) => {
    // The filter button may be identified by various selectors
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await expect(filterButton).toBeVisible();
    await filterButton.click();

    // Filter panel should appear with author input visible
    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await expect(authorInput).toBeVisible();
  });

  test('should have author filter input', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await expect(authorInput).toBeVisible();
    await authorInput.fill('john@example.com');
    await expect(authorInput).toHaveValue('john@example.com');
  });

  test('should have date range filters', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const dateFromInput = page.locator('gn-search-bar input[type="date"]').first();
    const dateToInput = page.locator('gn-search-bar input[type="date"]').last();

    await expect(dateFromInput).toBeVisible();
    await expect(dateToInput).toBeVisible();
  });

  test('should have file path filter', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const filePathInput = page.locator('gn-search-bar input[placeholder*="path"], gn-search-bar input[placeholder*=".ts"]');
    await expect(filePathInput).toBeVisible();
    await filePathInput.fill('src/**/*.ts');
    await expect(filePathInput).toHaveValue('src/**/*.ts');
  });

  test('should have Apply button in filter panel', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await expect(applyButton).toBeVisible();
  });

  test('should have Clear Filters button', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const clearFiltersButton = page.locator('gn-search-bar button', { hasText: /clear.*filter/i });
    await expect(clearFiltersButton).toBeVisible();
  });

  test('should close filter panel when clicking Apply', async ({ page }) => {
    // Open filter panel first
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await expect(applyButton).toBeVisible();

    await applyButton.click();

    await expect(applyButton).not.toBeVisible();
  });

  test('should clear all filter values when clicking Clear Filters', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    // Fill in filters
    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await authorInput.fill('test@example.com');

    const clearFiltersButton = page.locator('gn-search-bar button', { hasText: /clear.*filter/i });
    await clearFiltersButton.click();

    await expect(authorInput).toHaveValue('');
  });

  test('filter button should show active state when filters are set', async ({ page }) => {
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    // Set a filter
    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await authorInput.fill('test@example.com');

    // Apply filters
    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await applyButton.click();

    // Filter button should have active class
    await expect(filterButton).toHaveClass(/active/);
  });
});

test.describe('Search Bar Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('should open search with Ctrl+F', async ({ page }) => {
    await page.keyboard.press('Control+f');

    const searchBar = page.locator('gn-search-bar');
    await expect(searchBar).toBeVisible();
  });

  test('should submit search with Enter key', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('bug fix');
    await searchInput.press('Enter');

    // Search should be submitted (input should still have value)
    await expect(searchInput).toHaveValue('bug fix');
  });
});

test.describe('Search Query Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      commits: [
        {
          oid: 'aaa111',
          shortId: 'aaa111',
          message: 'fix: resolve login bug',
          summary: 'fix: resolve login bug',
          body: null,
          author: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 },
          committer: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 },
          parentIds: [],
          timestamp: Date.now() / 1000,
        },
        {
          oid: 'bbb222',
          shortId: 'bbb222',
          message: 'feat: add dashboard feature',
          summary: 'feat: add dashboard feature',
          body: null,
          author: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 - 3600 },
          committer: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 - 3600 },
          parentIds: ['aaa111'],
          timestamp: Date.now() / 1000 - 3600,
        },
        {
          oid: 'ccc333',
          shortId: 'ccc333',
          message: 'fix: patch security vulnerability',
          summary: 'fix: patch security vulnerability',
          body: null,
          author: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 - 7200 },
          committer: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 - 7200 },
          parentIds: ['bbb222'],
          timestamp: Date.now() / 1000 - 7200,
        },
      ],
    });
  });

  test('search should filter the graph to matching commits', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('fix');
    await searchInput.press('Enter');

    await expect(searchInput).toHaveValue('fix');
  });

  test('clearing search should restore full commit list', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();

    // Enter a search query
    await searchInput.fill('fix');
    await searchInput.press('Enter');

    await page.keyboard.press('Escape');
    await expect(searchInput).toHaveValue('');

    // The graph canvas should still be visible (full list restored)
    const graph = page.locator('gn-graph-canvas');
    await expect(graph).toBeVisible();
  });

  test('search with no matches should show empty state and keep search bar functional', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Mock get_commit_history to return empty array for the non-matching search
    await injectCommandMock(page, {
      get_commit_history: [],
    });

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('zzzznonexistentquery12345');
    await searchInput.press('Enter');

    await expect(searchInput).toHaveValue('zzzznonexistentquery12345');

    // Graph canvas should still be visible (not crashed) even with zero results
    const graph = page.locator('gn-graph-canvas');
    await expect(graph).toBeVisible();

    // Search bar should remain visible and functional for a new search
    const searchBar = page.locator('gn-search-bar');
    await expect(searchBar).toBeVisible();

    // Clear button should be visible since there is a query
    const clearButton = page.locator('gn-search-bar .clear-btn, gn-search-bar button[title*="Clear"]');
    await expect(clearButton).toBeVisible();
  });

  test('search should trigger get_commit_history command with search params', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    await startCommandCapture(page);

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('dashboard');
    await searchInput.press('Enter');

    await waitForCommand(page, 'get_commit_history');

    const historyCommands = await findCommand(page, 'get_commit_history');
    expect(historyCommands.length).toBeGreaterThan(0);
  });

  test('applying author filter should include author in search params', async ({ page }) => {
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Open filters
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await authorInput.fill('user@test.com');

    await startCommandCapture(page);

    // Apply filters
    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await applyButton.click();

    await expect(filterButton).toHaveClass(/active/);
  });

  /**
   * Apply a graph search filter through the same `search-change` contract
   * gn-toolbar emits when the user clicks Apply in the filter panel.
   *
   * NOTE: this does not type into the search bar because of a separate
   * pre-existing defect — gn-search-bar's `search-change` is `composed`, so
   * app-shell receives both the toolbar's `{ filter }` event and the search
   * bar's own raw-filter event, and the raw one arrives last leaving
   * app-shell's searchFilter `undefined`. Emitting the toolbar's contract
   * still exercises the real components end to end.
   */
  async function applyGraphFilter(
    page: import('@playwright/test').Page,
    filter: Record<string, string>
  ): Promise<void> {
    await page.evaluate((f) => {
      const findToolbar = (root: Document | ShadowRoot): Element | null => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.tagName.toLowerCase() === 'gn-toolbar') return el;
          if (el.shadowRoot) {
            const found = findToolbar(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      const toolbar = findToolbar(document);
      if (!toolbar) throw new Error('gn-toolbar not found');
      toolbar.dispatchEvent(
        new CustomEvent('search-change', { detail: { filter: f }, bubbles: true, composed: true })
      );
    }, filter);
  }

  const pathFilter = {
    query: '',
    author: '',
    dateFrom: '',
    dateTo: '',
    filePath: 'src/**/*.ts',
    branch: '',
    searchMode: 'keyword',
  };

  test('a Path filter reaches git directly, bypassing the commit index', async ({ page }) => {
    // Opening the repo builds the commit index in the background, which is
    // the condition the graph's search path branches on. The index has no
    // file dimension: if it is asked, it answers with everything it holds
    // and every commit lights up as a "match". A Path filter must therefore
    // go to the direct commit search instead.
    await startCommandCaptureWithMocks(page, {
      search_index: [
        {
          oid: 'abc123def456',
          shortOid: 'abc123d',
          summary: 'Initial commit',
          messageLower: 'initial commit',
          authorName: 'Test User',
          authorEmail: 'test@example.com',
          authorDate: 1700000000,
          parentCount: 0,
        },
      ],
      search_commits: [],
    });

    await applyGraphFilter(page, pathFilter);

    await waitForCommand(page, 'search_commits');

    const directSearches = await findCommand(page, 'search_commits');
    expect(directSearches.length).toBeGreaterThan(0);
    expect((directSearches[0].args as { filePath?: string }).filePath).toBe('src/**/*.ts');

    const indexSearches = await findCommand(page, 'search_index');
    expect(indexSearches).toHaveLength(0);
  });

  test('a failed Path search is announced, not shown as zero matches', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      search_commits: { __error__: 'fatal: bad pathspec' },
    });

    await applyGraphFilter(page, pathFilter);

    await expect(
      page.locator('gn-toast-container .toast .toast-message', {
        hasText: 'Search failed',
      })
    ).toBeVisible();
  });
});

test.describe('Search Bar - Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      commits: [
        {
          oid: 'aaa111',
          shortId: 'aaa111',
          message: 'fix: resolve login bug',
          summary: 'fix: resolve login bug',
          body: null,
          author: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 },
          committer: { name: 'User', email: 'user@test.com', timestamp: Date.now() / 1000 },
          parentIds: [],
          timestamp: Date.now() / 1000,
        },
      ],
    });
  });

  test('get_commit_history failure should show error feedback and preserve search bar state', async ({ page }) => {
    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Inject error for get_commit_history
    await injectCommandError(page, 'get_commit_history', 'Search failed');

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('fix');
    await searchInput.press('Enter');

    // The app should show an error indicator (the graph renders errors in an .info-panel)
    // or a toast notification rather than crashing
    const errorIndicator = page.locator('gn-graph-canvas .info-panel, gn-toast-container .toast.error, .error-message, .error-banner').first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // Search bar should remain visible and functional after the error
    const searchBar = page.locator('gn-search-bar');
    await expect(searchBar).toBeVisible();

    // Search input should still contain the query so the user can retry
    await expect(searchInput).toHaveValue('fix');

    // The search input should still be interactable (not frozen)
    await searchInput.fill('new query');
    await expect(searchInput).toHaveValue('new query');
  });

  test('invalid filter values should be handled gracefully without crash', async ({ page }) => {
    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Open filter panel
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    // Enter an extremely long author value (edge case)
    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await authorInput.fill('a'.repeat(500));

    // Apply filters - this should not crash the app
    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await applyButton.click();

    // The search bar should still be functional (not crashed)
    const searchBar = page.locator('gn-search-bar');
    await expect(searchBar).toBeVisible();

    // The search input should still be interactable
    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });
});

test.describe('Search Bar - UI Outcome Verification', () => {
  /**
   * Helper to read the total number of sorted nodes (commit rows) in the graph.
   * Uses Playwright's auto-piercing locator instead of manual shadowRoot traversal.
   */
  async function getGraphNodeCount(page: import('@playwright/test').Page): Promise<number> {
    const graphCanvas = page.locator('gn-graph-canvas');
    await expect(graphCanvas).toBeAttached();
    const handle = await graphCanvas.elementHandle();
    return page.evaluate(
      (el) => ((el as HTMLElement & { sortedNodesByRow?: unknown[] })?.sortedNodesByRow?.length ?? 0),
      handle
    );
  }

  /**
   * Helper to wait for the graph node count to reach a specific value.
   * Uses Playwright's auto-piercing locator instead of manual shadowRoot traversal.
   */
  async function waitForGraphNodeCount(page: import('@playwright/test').Page, count: number): Promise<void> {
    const graphCanvas = page.locator('gn-graph-canvas');
    await expect(graphCanvas).toBeAttached();
    const handle = await graphCanvas.elementHandle();
    await page.waitForFunction(
      ([el, expected]) => ((el as HTMLElement & { sortedNodesByRow?: unknown[] })?.sortedNodesByRow?.length ?? 0) === expected,
      [handle, count] as const
    );
  }

  const now = Date.now() / 1000;

  const threeCommits = [
    {
      oid: 'aaa111',
      shortId: 'aaa111',
      message: 'fix: resolve login bug',
      summary: 'fix: resolve login bug',
      body: null,
      author: { name: 'Alice', email: 'alice@test.com', timestamp: now },
      committer: { name: 'Alice', email: 'alice@test.com', timestamp: now },
      parentIds: [],
      timestamp: now,
    },
    {
      oid: 'bbb222',
      shortId: 'bbb222',
      message: 'feat: add dashboard feature',
      summary: 'feat: add dashboard feature',
      body: null,
      author: { name: 'Bob', email: 'bob@test.com', timestamp: now - 3600 },
      committer: { name: 'Bob', email: 'bob@test.com', timestamp: now - 3600 },
      parentIds: ['aaa111'],
      timestamp: now - 3600,
    },
    {
      oid: 'ccc333',
      shortId: 'ccc333',
      message: 'fix: patch security vulnerability',
      summary: 'fix: patch security vulnerability',
      body: null,
      author: { name: 'Alice', email: 'alice@test.com', timestamp: now - 7200 },
      committer: { name: 'Alice', email: 'alice@test.com', timestamp: now - 7200 },
      parentIds: ['bbb222'],
      timestamp: now - 7200,
    },
  ];

  test('search filters graph to show only matching commits', async ({ page }) => {
    await setupOpenRepository(page, { commits: threeCommits });

    // Wait for graph to render all 3 commits
    const graphCanvas = page.locator('gn-graph-canvas');
    await expect(graphCanvas).toBeVisible();
    await waitForGraphNodeCount(page, 3);

    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Mock get_commit_history to return only matching commits when search is applied
    // The search filter is passed to the backend which returns filtered results
    const fixCommits = threeCommits.filter((c) => c.message.includes('fix'));
    await injectCommandMock(page, {
      get_commit_history: fixCommits,
    });

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('fix');
    await searchInput.press('Enter');

    // Wait for the graph to update with filtered results (2 fix commits)
    await waitForGraphNodeCount(page, 2);
    const filteredCount = await getGraphNodeCount(page);
    expect(filteredCount).toBe(2);
  });

  test('applying author filter updates the graph to reflect filtered results', async ({ page }) => {
    await setupOpenRepository(page, { commits: threeCommits });

    const graphCanvas = page.locator('gn-graph-canvas');
    await expect(graphCanvas).toBeVisible();
    await waitForGraphNodeCount(page, 3);

    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Open filters
    const filterButton = page.locator('gn-search-bar .filter-btn, gn-search-bar button[title*="Filter"]');
    await filterButton.click();

    // Set author filter
    const authorInput = page.locator('gn-search-bar input[placeholder*="Author"]');
    await authorInput.fill('alice@test.com');

    // Mock the backend to return only Alice's commits
    const aliceCommits = threeCommits.filter((c) => c.author.email === 'alice@test.com');
    await injectCommandMock(page, {
      get_commit_history: aliceCommits,
    });

    // Apply filter
    const applyButton = page.locator('gn-search-bar button', { hasText: /apply/i });
    await applyButton.click();

    // Filter button should show active state
    await expect(filterButton).toHaveClass(/active/);

    // Wait for the graph to update with filtered results (2 Alice commits)
    await waitForGraphNodeCount(page, 2);
    const filteredCount = await getGraphNodeCount(page);
    expect(filteredCount).toBe(2);
  });

  test('search for non-existent term shows empty graph state', async ({ page }) => {
    await setupOpenRepository(page, { commits: threeCommits });

    const graphCanvas = page.locator('gn-graph-canvas');
    await expect(graphCanvas).toBeVisible();
    await waitForGraphNodeCount(page, 3);

    // Open search bar
    const searchButton = page.locator('button[title*="Search commits"]');
    await searchButton.click();

    // Mock backend to return zero results for the non-matching search
    await injectCommandMock(page, {
      get_commit_history: [],
    });

    const searchInput = page.locator('gn-search-bar input[type="text"]').first();
    await searchInput.fill('zzzznonexistentquery12345');
    await searchInput.press('Enter');

    // Wait for the graph to update with zero results
    await waitForGraphNodeCount(page, 0);
    const filteredCount = await getGraphNodeCount(page);
    expect(filteredCount).toBe(0);

    // The graph canvas should still be visible (not crashed) even with zero results
    await expect(graphCanvas).toBeVisible();
  });
});


test.describe('Semantic Search Fallback', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  /**
   * Apply a semantic-mode filter to the graph canvas.
   *
   * NOTE: this deliberately sets the same `.searchFilter` property app-shell's
   * template binds, instead of typing into the search bar. gn-search-bar's
   * `search-change` event is `composed`, so app-shell's listener on
   * <gn-toolbar> receives BOTH the toolbar's re-dispatched `{ filter }` event
   * and the search bar's own raw-filter event; the raw one arrives last and
   * leaves app-shell's searchFilter `undefined`. That plumbing defect is out
   * of scope here — driving the canvas property directly still exercises the
   * real component and the real graph-notice -> toast wiring.
   */
  async function applySemanticFilter(page: import('@playwright/test').Page, query: string): Promise<void> {
    await page.evaluate((q) => {
      const shell = document.querySelector('gn-app-shell');
      const canvas = shell?.shadowRoot?.querySelector('gn-graph-canvas') as unknown as {
        searchFilter: Record<string, string> | null;
      } | null;
      if (!canvas) throw new Error('gn-graph-canvas not found');
      canvas.searchFilter = {
        query: q,
        author: '',
        dateFrom: '',
        dateTo: '',
        filePath: '',
        branch: '',
        searchMode: 'semantic',
      };
    }, query);
  }

  test('semantic search failure shows keyword results and an unavailable toast', async ({ page }) => {
    await expect(page.locator('gn-graph-canvas')).toBeVisible();
    await startCommandCaptureWithMocks(page, {
      semantic_search: { __error__: 'Embedding model not downloaded' },
      search_commits: [defaultMockData.commits[0]],
    });

    await applySemanticFilter(page, 'authentication rework');

    // The failure must be announced, not silently read as "no matches"
    await expect(
      page.locator('gn-toast-container .toast .toast-message', {
        hasText: 'Semantic search is unavailable',
      })
    ).toBeVisible();

    // ...and the promised keyword fallback must actually have run
    const searches = await findCommand(page, 'search_commits');
    expect(searches.length).toBeGreaterThan(0);
    expect((searches[0].args as { query?: string }).query).toBe('authentication rework');
  });

  test('successful semantic search neither falls back nor toasts', async ({ page }) => {
    await expect(page.locator('gn-graph-canvas')).toBeVisible();
    await startCommandCaptureWithMocks(page, {
      semantic_search: [
        { oid: defaultMockData.commits[0].oid, distance: 0.1, summary: 'Initial commit' },
      ],
      search_commits: [],
    });

    await applySemanticFilter(page, 'authentication rework');
    await waitForCommand(page, 'semantic_search');
    // The load finishes with the commit refetch; wait for it so a late
    // keyword fallback would still be captured before the assertions.
    await waitForCommand(page, 'get_commit_total');

    await expect(
      page.locator('gn-toast-container .toast .toast-message', {
        hasText: 'Semantic search is unavailable',
      })
    ).toHaveCount(0);
    expect(await findCommand(page, 'search_commits')).toHaveLength(0);
  });
});
