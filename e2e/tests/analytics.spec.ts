import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import { injectCommandMock, injectCommandError } from '../fixtures/test-helpers';

/** Mock statistics data returned by get_repo_statistics */
const mockStatistics = {
  totalCommits: 256,
  totalBranches: 8,
  totalTags: 5,
  totalContributors: 6,
  totalFiles: 120,
  repoSizeBytes: 4_200_000,
  firstCommitDate: 1609459200,
  lastCommitDate: 1704067200,
  repoAgeDays: 1096,
  activityByMonth: [
    { year: 2023, month: 10, commits: 30, authors: 3 },
    { year: 2023, month: 11, commits: 45, authors: 4 },
    { year: 2023, month: 12, commits: 18, authors: 2 },
  ],
  activityByWeekday: [
    { day: 'Sunday', commits: 10 },
    { day: 'Monday', commits: 55 },
    { day: 'Tuesday', commits: 50 },
    { day: 'Wednesday', commits: 48 },
    { day: 'Thursday', commits: 42 },
    { day: 'Friday', commits: 35 },
    { day: 'Saturday', commits: 16 },
  ],
  activityByHour: Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    commits: i >= 9 && i <= 17 ? 15 + i : 3,
  })),
  topContributors: [
    { name: 'Alice', email: 'alice@test.com', commits: 100, linesAdded: 8000, linesDeleted: 2000, firstCommit: 1609459200, lastCommit: 1704067200 },
    { name: 'Bob', email: 'bob@test.com', commits: 80, linesAdded: 5000, linesDeleted: 1500, firstCommit: 1622505600, lastCommit: 1700000000 },
    { name: 'Charlie', email: 'charlie@test.com', commits: 40, linesAdded: 2000, linesDeleted: 800, firstCommit: 1640995200, lastCommit: 1690000000 },
  ],
  fileTypes: [
    { extension: '.ts', fileCount: 50, totalLines: 12000 },
    { extension: '.rs', fileCount: 30, totalLines: 8000 },
    { extension: '.json', fileCount: 15, totalLines: 1000 },
    { extension: '.md', fileCount: 10, totalLines: 500 },
    { extension: '.css', fileCount: 15, totalLines: 2500 },
  ],
  totalLinesAdded: 15000,
  totalLinesDeleted: 4300,
};

/**
 * Force the analytics panel to reload data.
 * The component lives deep in shadow DOM (app-shell > ... > gn-right-panel > gn-analytics-panel).
 * We traverse shadow roots to find it, reset its cache, and trigger loadStats().
 */
async function reloadAnalyticsPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    function deepQuerySelector(root: ParentNode, selector: string): Element | null {
      const el = root.querySelector(selector);
      if (el) return el;
      const allElements = root.querySelectorAll('*');
      for (const elem of allElements) {
        if (elem.shadowRoot) {
          const found = deepQuerySelector(elem.shadowRoot, selector);
          if (found) return found;
        }
      }
      return null;
    }

    const panel = deepQuerySelector(document, 'gn-analytics-panel');
    if (!panel) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ap = panel as any;
    // Reset lastLoadedPath so loadStats() will actually fetch again
    ap.lastLoadedPath = null;
    ap.loadStats();
  });
}

test.describe('Analytics Panel', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    // Inject mock before any analytics interaction
    await injectCommandMock(page, { get_repo_statistics: mockStatistics });
  });

  test('should show Analytics tab in right panel', async () => {
    await expect(rightPanel.analyticsTab).toBeVisible();
  });

  test('should switch to analytics panel when tab is clicked', async () => {
    await rightPanel.switchToAnalytics();
    await expect(rightPanel.analyticsPanel).toBeVisible();
  });

  test('should display overview cards with summary statistics', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    await page.locator('gn-analytics-panel .stat-card').first().waitFor({ state: 'visible', timeout: 5000 });

    const cards = page.locator('gn-analytics-panel .stat-card');
    await expect(cards).toHaveCount(9);

    // Verify commits count is displayed
    const values = page.locator('gn-analytics-panel .stat-value');
    await expect(values.first()).toHaveText('256');
  });

  test('should display commit activity timeline chart', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const activityBars = page.locator('gn-analytics-panel .section:has-text("Commit Activity") .chart-bar');
    await activityBars.first().waitFor({ state: 'visible', timeout: 5000 });

    // Should have 3 bars (one per month)
    await expect(activityBars).toHaveCount(3);
  });

  test('should display activity patterns section', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const patternsSection = page.locator('gn-analytics-panel .section:has-text("Activity Patterns")');
    await expect(patternsSection).toBeVisible({ timeout: 5000 });

    await expect(patternsSection.locator('.chart-sub-title:has-text("Day of Week")')).toBeVisible();
    await expect(patternsSection.locator('.chart-sub-title:has-text("Hour")')).toBeVisible();
  });

  test('should display top contributors', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const contribSection = page.locator('gn-analytics-panel .section:has-text("Top Contributors")');
    await expect(contribSection).toBeVisible({ timeout: 5000 });

    const rows = contribSection.locator('.contributor-row');
    await expect(rows).toHaveCount(3);

    await expect(contribSection.locator('.contributor-name').first()).toHaveText('Alice');
  });

  test('should display file type distribution', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const fileSection = page.locator('gn-analytics-panel .section:has-text("File Types")');
    await expect(fileSection).toBeVisible({ timeout: 5000 });

    await expect(fileSection.locator('.donut-container svg')).toBeVisible();

    const fileRows = fileSection.locator('.file-type-row');
    await expect(fileRows).toHaveCount(5);
  });

  test('should show error state when command fails', async ({ page }) => {
    // Inject error mock — this replaces the success mock from beforeEach
    await injectCommandError(page, 'get_repo_statistics', 'Statistics unavailable');

    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const errorEl = page.locator('gn-analytics-panel .error');
    await expect(errorEl).toBeVisible({ timeout: 5000 });
    await expect(errorEl).toContainText('Statistics unavailable');
  });

  test('should show retry button on error', async ({ page }) => {
    await injectCommandError(page, 'get_repo_statistics', 'Temporary failure');

    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const retryBtn = page.locator('gn-analytics-panel .retry-btn');
    await expect(retryBtn).toBeVisible({ timeout: 5000 });
  });

  test('should refresh statistics after a repository change made on another tab', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const values = page.locator('gn-analytics-panel .stat-value');
    await expect(values.first()).toHaveText('256');

    // A commit lands while the user is back on the Changes tab.
    await injectCommandMock(page, {
      get_repo_statistics: { ...mockStatistics, totalCommits: 257 },
    });
    await rightPanel.changesTab.click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('repository-refresh')));

    await rightPanel.switchToAnalytics();

    // Returning to Analytics must show the post-commit numbers, not the ones
    // captured when the repository was opened.
    await expect(values.first()).toHaveText('257');
  });

  test('should re-read statistics when the manual refresh button is clicked', async ({ page }) => {
    await rightPanel.switchToAnalytics();
    await reloadAnalyticsPanel(page);

    const values = page.locator('gn-analytics-panel .stat-value');
    await expect(values.first()).toHaveText('256');

    await injectCommandMock(page, {
      get_repo_statistics: { ...mockStatistics, totalCommits: 300 },
    });

    await page.locator('gn-analytics-panel .refresh-btn').click();

    await expect(values.first()).toHaveText('300');
  });
});
