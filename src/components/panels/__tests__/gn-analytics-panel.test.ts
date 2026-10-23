/**
 * Unit tests for gn-analytics-panel component.
 *
 * Renders the REAL gn-analytics-panel component, mocks only the Tauri invoke
 * layer, and verifies the actual component behavior and DOM output.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnAnalyticsPanel } from '../gn-analytics-panel.ts';
import '../gn-analytics-panel.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const mockRepoStatistics = {
  totalCommits: 142,
  totalBranches: 5,
  totalTags: 3,
  totalContributors: 4,
  totalFiles: 87,
  repoSizeBytes: 2_500_000,
  firstCommitDate: 1609459200, // 2021-01-01
  lastCommitDate: 1704067200, // 2024-01-01
  repoAgeDays: 1096,
  activityByMonth: [
    { year: 2023, month: 10, commits: 15, authors: 2 },
    { year: 2023, month: 11, commits: 22, authors: 3 },
    { year: 2023, month: 12, commits: 8, authors: 1 },
  ],
  activityByWeekday: [
    { day: 'Sunday', commits: 5 },
    { day: 'Monday', commits: 30 },
    { day: 'Tuesday', commits: 28 },
    { day: 'Wednesday', commits: 25 },
    { day: 'Thursday', commits: 27 },
    { day: 'Friday', commits: 20 },
    { day: 'Saturday', commits: 7 },
  ],
  activityByHour: Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    commits: i >= 9 && i <= 17 ? 10 + i : 2,
  })),
  topContributors: [
    { name: 'Alice', email: 'alice@example.com', commits: 80, linesAdded: 5000, linesDeleted: 1200, firstCommit: 1609459200, lastCommit: 1704067200 },
    { name: 'Bob', email: 'bob@example.com', commits: 40, linesAdded: 2000, linesDeleted: 800, firstCommit: 1622505600, lastCommit: 1700000000 },
    { name: 'Charlie', email: 'charlie@example.com', commits: 15, linesAdded: 700, linesDeleted: 300, firstCommit: 1640995200, lastCommit: 1690000000 },
    { name: 'Diana', email: 'diana@example.com', commits: 7, linesAdded: 200, linesDeleted: 50, firstCommit: 1672531200, lastCommit: 1680000000 },
  ],
  fileTypes: [
    { extension: '.ts', fileCount: 40, totalLines: 8000 },
    { extension: '.rs', fileCount: 25, totalLines: 6000 },
    { extension: '.json', fileCount: 10, totalLines: 500 },
    { extension: '.md', fileCount: 5, totalLines: 300 },
    { extension: '.css', fileCount: 7, totalLines: 1200 },
  ],
  totalLinesAdded: 7900,
  totalLinesDeleted: 2350,
};

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(stats = mockRepoStatistics): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_repo_statistics':
        return stats;
      default:
        return null;
    }
  };
}

function setupErrorMocks(errorMessage: string): void {
  mockInvoke = async (command: string) => {
    if (command === 'get_repo_statistics') {
      throw new Error(errorMessage);
    }
    return null;
  };
}

async function renderPanel(repoPath: string | null = REPO_PATH): Promise<GnAnalyticsPanel> {
  const el = await fixture<GnAnalyticsPanel>(
    html`<gn-analytics-panel .repositoryPath=${repoPath}></gn-analytics-panel>`,
  );
  await el.updateComplete;
  // Wait for async load
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

async function renderPanelWithActive(active: boolean): Promise<GnAnalyticsPanel> {
  const el = await fixture<GnAnalyticsPanel>(
    html`<gn-analytics-panel .repositoryPath=${REPO_PATH} .active=${active}></gn-analytics-panel>`,
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

/** Statistics as they look AFTER a commit landed in the repository. */
const UPDATED_STATS = { ...mockRepoStatistics, totalCommits: 143, totalContributors: 5 };

/** Wait past the refresh debounce window plus the mocked fetch. */
async function settleRefresh(el: GnAnalyticsPanel): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  await el.updateComplete;
}

function firstStatValue(el: GnAnalyticsPanel): string {
  const cards = el.shadowRoot!.querySelectorAll('.stat-card');
  return cards[0].querySelector('.stat-value')!.textContent!.trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-analytics-panel', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
  });

  // ── 1. Loading state ────────────────────────────────────────────────
  describe('loading state', () => {
    it('shows loading text during data fetch', async () => {
      // Use a mock that never resolves to keep loading state
      mockInvoke = () => new Promise(() => {});
      const el = await fixture<GnAnalyticsPanel>(
        html`<gn-analytics-panel .repositoryPath=${REPO_PATH}></gn-analytics-panel>`,
      );
      await el.updateComplete;

      const loading = el.shadowRoot!.querySelector('.loading');
      expect(loading).to.not.be.null;
      expect(loading!.textContent).to.include('Loading statistics');
    });
  });

  // ── 2. Empty state (no repository) ──────────────────────────────────
  describe('empty state', () => {
    it('shows empty state when no repository path', async () => {
      const el = await renderPanel(null);
      const empty = el.shadowRoot!.querySelector('.empty-state');
      expect(empty).to.not.be.null;
      expect(empty!.textContent).to.include('No repository open');
    });
  });

  // ── 3. Error state ──────────────────────────────────────────────────
  describe('error state', () => {
    it('shows error message when command fails', async () => {
      setupErrorMocks('Repository not found');
      const el = await renderPanel();

      const error = el.shadowRoot!.querySelector('.error');
      expect(error).to.not.be.null;
      expect(error!.textContent).to.include('Repository not found');
    });

    it('shows retry button on error', async () => {
      setupErrorMocks('Network error');
      const el = await renderPanel();

      const retryBtn = el.shadowRoot!.querySelector('.retry-btn');
      expect(retryBtn).to.not.be.null;
    });

    it('retries loading when retry button is clicked', async () => {
      setupErrorMocks('Temporary error');
      const el = await renderPanel();

      // Now switch to success mock
      clearHistory();
      setupDefaultMocks();

      const retryBtn = el.shadowRoot!.querySelector('.retry-btn') as HTMLButtonElement;
      retryBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Should have called the command again
      expect(findCommands('get_repo_statistics').length).to.be.greaterThan(0);
      // Should now show content instead of error
      const error = el.shadowRoot!.querySelector('.error');
      expect(error).to.be.null;
    });
  });

  // ── 4. Overview Cards ───────────────────────────────────────────────
  describe('overview cards', () => {
    it('renders overview section with stat cards', async () => {
      const el = await renderPanel();

      const section = el.shadowRoot!.querySelector('.section');
      expect(section).to.not.be.null;

      const header = section!.querySelector('.section-header');
      expect(header!.textContent).to.include('Overview');
    });

    it('renders correct number of stat cards', async () => {
      const el = await renderPanel();

      const cards = el.shadowRoot!.querySelectorAll('.stat-card');
      // 9 cards: commits, contributors, branches, tags, files, repo size, days old, first commit, last commit
      expect(cards.length).to.equal(9);
    });

    it('displays correct commit count', async () => {
      const el = await renderPanel();

      const cards = el.shadowRoot!.querySelectorAll('.stat-card');
      const values = Array.from(cards).map((c) => c.querySelector('.stat-value')!.textContent!.trim());
      // First card should be commits = 142
      expect(values[0]).to.equal('142');
    });

    it('displays formatted repo size', async () => {
      const el = await renderPanel();

      const cards = el.shadowRoot!.querySelectorAll('.stat-card');
      const labels = Array.from(cards).map((c) => c.querySelector('.stat-label')!.textContent!.trim());
      const sizeIndex = labels.indexOf('Repo Size');
      expect(sizeIndex).to.be.greaterThan(-1);
      const sizeValue = cards[sizeIndex].querySelector('.stat-value')!.textContent!.trim();
      expect(sizeValue).to.include('MB');
    });
  });

  // ── 5. Activity Timeline ────────────────────────────────────────────
  describe('activity timeline', () => {
    it('renders commit activity chart with bars', async () => {
      const el = await renderPanel();

      const bars = el.shadowRoot!.querySelectorAll('.chart-bar');
      // 3 months + 7 weekdays + 24 hours = 34 total bars
      expect(bars.length).to.be.greaterThan(0);
    });

    it('renders correct number of timeline bars for months', async () => {
      const el = await renderPanel();

      // Find the commit activity section
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const activitySection = Array.from(sections).find(
        (s) => s.querySelector('.section-header')?.textContent?.includes('Commit Activity'),
      );
      expect(activitySection).to.not.be.null;

      const bars = activitySection!.querySelectorAll('.chart-bar');
      expect(bars.length).to.equal(3); // 3 months of data
    });
  });

  // ── 6. Activity Patterns ────────────────────────────────────────────
  describe('activity patterns', () => {
    it('renders weekday chart with 7 bars', async () => {
      const el = await renderPanel();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const patternSection = Array.from(sections).find(
        (s) => s.querySelector('.section-header')?.textContent?.includes('Activity Patterns'),
      );
      expect(patternSection).to.not.be.null;

      const subTitles = patternSection!.querySelectorAll('.chart-sub-title');
      const weekdaySub = Array.from(subTitles).find((t) => t.textContent?.includes('Day of Week'));
      expect(weekdaySub).to.not.be.null;
    });

    it('renders hour chart with 24 bars', async () => {
      const el = await renderPanel();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const patternSection = Array.from(sections).find(
        (s) => s.querySelector('.section-header')?.textContent?.includes('Activity Patterns'),
      );
      expect(patternSection).to.not.be.null;

      const subTitles = patternSection!.querySelectorAll('.chart-sub-title');
      const hourSub = Array.from(subTitles).find((t) => t.textContent?.includes('Hour'));
      expect(hourSub).to.not.be.null;
    });
  });

  // ── 7. Contributors ─────────────────────────────────────────────────
  describe('contributors', () => {
    it('renders contributor list', async () => {
      const el = await renderPanel();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const contribSection = Array.from(sections).find(
        (s) => s.querySelector('.section-header')?.textContent?.includes('Top Contributors'),
      );
      expect(contribSection).to.not.be.null;
    });

    it('renders correct number of contributors', async () => {
      const el = await renderPanel();

      const rows = el.shadowRoot!.querySelectorAll('.contributor-row');
      expect(rows.length).to.equal(4); // 4 contributors in mock data
    });

    it('contributors sorted by commit count (descending)', async () => {
      const el = await renderPanel();

      const names = Array.from(el.shadowRoot!.querySelectorAll('.contributor-name')).map(
        (n) => n.textContent!.trim(),
      );
      expect(names[0]).to.equal('Alice');
      expect(names[1]).to.equal('Bob');
      expect(names[2]).to.equal('Charlie');
      expect(names[3]).to.equal('Diana');
    });

    it('displays lines added/deleted', async () => {
      const el = await renderPanel();

      const added = el.shadowRoot!.querySelectorAll('.lines-added');
      const deleted = el.shadowRoot!.querySelectorAll('.lines-deleted');
      expect(added.length).to.be.greaterThan(0);
      expect(deleted.length).to.be.greaterThan(0);
      // First contributor (Alice) should show +5K
      expect(added[0].textContent).to.include('+5');
    });

    it('renders progress bars for contributors', async () => {
      const el = await renderPanel();

      const bars = el.shadowRoot!.querySelectorAll('.contributor-bar');
      expect(bars.length).to.equal(4);
    });
  });

  // ── 8. File Types ───────────────────────────────────────────────────
  describe('file types', () => {
    it('renders file types section', async () => {
      const el = await renderPanel();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const fileSection = Array.from(sections).find(
        (s) => s.querySelector('.section-header')?.textContent?.includes('File Types'),
      );
      expect(fileSection).to.not.be.null;
    });

    it('renders donut chart', async () => {
      const el = await renderPanel();

      const donut = el.shadowRoot!.querySelector('.donut-container svg');
      expect(donut).to.not.be.null;
    });

    it('renders file type list', async () => {
      const el = await renderPanel();

      const rows = el.shadowRoot!.querySelectorAll('.file-type-row');
      expect(rows.length).to.equal(5); // 5 file types in mock data
    });

    it('displays correct file extension names', async () => {
      const el = await renderPanel();

      const exts = Array.from(el.shadowRoot!.querySelectorAll('.file-type-ext')).map(
        (e) => e.textContent!.trim(),
      );
      expect(exts).to.include('.ts');
      expect(exts).to.include('.rs');
    });
  });

  // ── 9. Data loading ─────────────────────────────────────────────────
  describe('data loading', () => {
    it('calls get_repo_statistics with correct args', async () => {
      await renderPanel();

      const cmds = findCommands('get_repo_statistics');
      expect(cmds.length).to.equal(1);
      const args = cmds[0].args as Record<string, unknown>;
      expect(args.path).to.equal(REPO_PATH);
      expect(args.includeActivity).to.equal(true);
      expect(args.includeContributors).to.equal(true);
      expect(args.includeFileTypes).to.equal(true);
    });

    it('reloads when repositoryPath changes', async () => {
      const el = await renderPanel();
      clearHistory();

      el.repositoryPath = '/other/repo';
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const cmds = findCommands('get_repo_statistics');
      expect(cmds.length).to.equal(1);
      const args = cmds[0].args as Record<string, unknown>;
      expect(args.path).to.equal('/other/repo');
    });
  });

  // ── 10. Null optional fields ────────────────────────────────────────
  describe('null optional fields', () => {
    it('renders without activity sections when null', async () => {
      setupDefaultMocks({
        ...mockRepoStatistics,
        activityByMonth: null,
        activityByWeekday: null,
        activityByHour: null,
        topContributors: null,
        fileTypes: null,
      } as unknown as typeof mockRepoStatistics);

      const el = await renderPanel();

      // Should still render overview
      const overviewCards = el.shadowRoot!.querySelectorAll('.stat-card');
      expect(overviewCards.length).to.equal(9);

      // Should NOT render activity/contributor/file sections
      const sections = el.shadowRoot!.querySelectorAll('.section');
      expect(sections.length).to.equal(1); // Only overview
    });
  });

  // ── 11. Zero commits ───────────────────────────────────────────────
  describe('zero commits', () => {
    it('renders overview with zero values', async () => {
      setupDefaultMocks({
        totalCommits: 0,
        totalBranches: 0,
        totalTags: 0,
        totalContributors: 0,
        totalFiles: 0,
        repoSizeBytes: 0,
        firstCommitDate: null,
        lastCommitDate: null,
        repoAgeDays: 0,
        activityByMonth: [],
        activityByWeekday: null,
        activityByHour: null,
        topContributors: [],
        fileTypes: [],
        totalLinesAdded: 0,
        totalLinesDeleted: 0,
      } as unknown as typeof mockRepoStatistics);

      const el = await renderPanel();

      const cards = el.shadowRoot!.querySelectorAll('.stat-card');
      expect(cards.length).to.equal(9);

      const firstValue = cards[0].querySelector('.stat-value')!.textContent!.trim();
      expect(firstValue).to.equal('0');
    });
  });
  // ── 11. Refresh (repository-refresh + manual button) ────────────────
  describe('refresh', () => {
    it('reloads statistics when repository-refresh fires while the Analytics tab is showing', async () => {
      const el = await renderPanel();
      expect(firstStatValue(el)).to.equal('142');

      clearHistory();
      setupDefaultMocks(UPDATED_STATS);
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      expect(findCommands('get_repo_statistics').length).to.equal(1);
      expect(firstStatValue(el)).to.equal('143');
    });

    it('defers the reload while the tab is hidden and runs it when the tab is shown', async () => {
      const el = await renderPanelWithActive(false);
      expect(firstStatValue(el)).to.equal('142');

      clearHistory();
      setupDefaultMocks(UPDATED_STATS);
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      // Hidden tab: the expensive statistics walk must not run yet.
      expect(findCommands('get_repo_statistics').length).to.equal(0);
      expect(firstStatValue(el)).to.equal('142');

      el.active = true;
      await settleRefresh(el);

      expect(findCommands('get_repo_statistics').length).to.equal(1);
      expect(firstStatValue(el)).to.equal('143');
    });

    it('defers the reload when the tab is hidden inside the debounce window', async () => {
      const el = await renderPanel();
      expect(firstStatValue(el)).to.equal('142');

      clearHistory();
      setupDefaultMocks(UPDATED_STATS);
      // Refresh arrives while Analytics is up, then the user switches tab
      // before the debounce elapses.
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      el.active = false;
      await settleRefresh(el);

      // The walk must not run behind a hidden tab.
      expect(findCommands('get_repo_statistics').length).to.equal(0);
      expect(firstStatValue(el)).to.equal('142');

      // ...and it must not be forgotten either.
      el.active = true;
      await settleRefresh(el);

      expect(findCommands('get_repo_statistics').length).to.equal(1);
      expect(firstStatValue(el)).to.equal('143');
    });

    it('re-fetches statistics when the Overview refresh button is clicked', async () => {
      const el = await renderPanel();

      clearHistory();
      setupDefaultMocks(UPDATED_STATS);
      const btn = el.shadowRoot!.querySelector('.refresh-btn') as HTMLButtonElement | null;
      expect(btn).to.not.be.null;
      btn!.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(findCommands('get_repo_statistics').length).to.equal(1);
      expect(firstStatValue(el)).to.equal('143');
    });

    it('keeps the rendered statistics and surfaces an error when a refresh fails', async () => {
      const el = await renderPanel();

      clearHistory();
      setupErrorMocks('Statistics walk failed');
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      const banner = el.shadowRoot!.querySelector('.refresh-error');
      expect(banner).to.not.be.null;
      expect(banner!.textContent).to.include('Statistics walk failed');
      // The charts must survive a failed refresh.
      expect(el.shadowRoot!.querySelectorAll('.stat-card').length).to.equal(9);
      expect(el.shadowRoot!.querySelector('.error')).to.be.null;
    });

    it('still shows the full error screen with Retry when the first load fails', async () => {
      setupErrorMocks('Repository not found');
      const el = await renderPanel();

      expect(el.shadowRoot!.querySelector('.error')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.retry-btn')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.refresh-error')).to.be.null;
    });

    it('coalesces a burst of repository-refresh events into a single statistics walk', async () => {
      const el = await renderPanel();

      clearHistory();
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      expect(findCommands('get_repo_statistics').length).to.equal(1);
    });

    it('ignores repository-refresh when no repository is open', async () => {
      const el = await renderPanel(null);

      clearHistory();
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      expect(findCommands('get_repo_statistics').length).to.equal(0);
      const empty = el.shadowRoot!.querySelector('.empty-state');
      expect(empty!.textContent).to.include('No repository open');
    });

    it('stops listening after the panel is disconnected', async () => {
      const el = await renderPanel();
      el.remove();

      clearHistory();
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await new Promise((r) => setTimeout(r, 400));

      expect(findCommands('get_repo_statistics').length).to.equal(0);
    });

    it('keeps the charts up and marks the refresh control busy while a refresh is running', async () => {
      const el = await renderPanel();

      mockInvoke = () => new Promise(() => {});
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await settleRefresh(el);

      const btn = el.shadowRoot!.querySelector('.refresh-btn') as HTMLButtonElement | null;
      expect(btn).to.not.be.null;
      expect(btn!.hasAttribute('disabled')).to.be.true;
      expect(el.shadowRoot!.querySelectorAll('.stat-card').length).to.equal(9);
      expect(el.shadowRoot!.querySelector('.loading')).to.be.null;
    });
  });
});
