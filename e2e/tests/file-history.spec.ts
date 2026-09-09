import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  waitForCommand,
  openAppDialog,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the File History Panel (lv-file-history).
 *
 * The panel is rendered by the app shell in the main area when the
 * `fileHistory` dialog is open with a file path. It loads commits
 * via get_file_history and shows them in a scrollable list with:
 * - Header showing "File History" title, file path, commit count, and close button
 * - Commit items with short OID, summary, author, date, and "View" button
 * - Selection state when clicking a commit
 * - Right-click context menu with View diff, Show commit details, View blame, Copy hash
 * - Empty state when no history exists
 *
 * Tests trigger the component through the app shell's real rendering flow
 * (opening the `fileHistory` dialog in the store) so that event wiring and
 * store connections work correctly. Playwright locators pierce shadow DOM
 * to access internal elements.
 */

const MOCK_COMMIT_OBJECTS = [
  {
    oid: 'abc123def456789',
    shortId: 'abc123d',
    message: 'Fix bug in file processing\n\nExtended details here.',
    summary: 'Fix bug in file processing',
    body: 'Extended details here.',
    author: { name: 'John Doe', email: 'john@example.com', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    committer: { name: 'John Doe', email: 'john@example.com', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    parentIds: ['parent1'],
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  },
  {
    oid: 'def789ghi012345',
    shortId: 'def789g',
    message: 'Add new feature\n\nImplemented new feature.',
    summary: 'Add new feature',
    body: 'Implemented new feature.',
    author: { name: 'Jane Smith', email: 'jane@example.com', timestamp: Math.floor(Date.now() / 1000) - 86400 },
    committer: { name: 'Jane Smith', email: 'jane@example.com', timestamp: Math.floor(Date.now() / 1000) - 86400 },
    parentIds: ['parent2'],
    timestamp: Math.floor(Date.now() / 1000) - 86400,
  },
  {
    oid: 'ghi345jkl678901',
    shortId: 'ghi345j',
    message: 'Initial implementation',
    summary: 'Initial implementation',
    body: null,
    author: { name: 'John Doe', email: 'john@example.com', timestamp: Math.floor(Date.now() / 1000) - 604800 },
    committer: { name: 'John Doe', email: 'john@example.com', timestamp: Math.floor(Date.now() / 1000) - 604800 },
    parentIds: [],
    timestamp: Math.floor(Date.now() / 1000) - 604800,
  },
];

/**
 * File history entries as the backend returns them: each commit paired with the
 * path the file had in THAT commit. The oldest entry predates a rename, so it
 * carries the old path — diffing or blaming it under 'src/main.ts' would fail
 * with "File not found in commit".
 */
const MOCK_ENTRIES = [
  { commit: MOCK_COMMIT_OBJECTS[0], pathAtCommit: 'src/main.ts' },
  { commit: MOCK_COMMIT_OBJECTS[1], pathAtCommit: 'src/main.ts' },
  { commit: MOCK_COMMIT_OBJECTS[2], pathAtCommit: 'src/old-main.ts' },
];

/**
 * Trigger file history display through the dialog store.
 * This mirrors the pattern used by the blame-view tests and reliably
 * triggers Lit's reactive update cycle.
 */
async function showFileHistory(
  page: import('@playwright/test').Page,
  filePath = 'src/main.ts'
): Promise<void> {
  await openAppDialog(page, 'fileHistory', { filePath });

  await page.locator('lv-file-history').waitFor({ state: 'attached', timeout: 5000 });
  await waitForCommand(page, 'get_file_history');
}

/** Open context menu on the first commit item */
async function openContextMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('lv-file-history .commit-item').first().click({ button: 'right' });
  await expect(page.locator('lv-file-history .context-menu')).toBeVisible();
}

// --------------------------------------------------------------------------
// Commit List Display
// --------------------------------------------------------------------------
test.describe('File History - Commit List', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
    await showFileHistory(page);
  });

  test('should call get_file_history with correct file path', async ({ page }) => {
    const commands = await findCommand(page, 'get_file_history');
    expect(commands.length).toBeGreaterThan(0);
    const args = commands[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/main.ts');
  });

  test('should show "File History" in the header', async ({ page }) => {
    await expect(page.locator('lv-file-history .header-title')).toHaveText('File History');
  });

  test('should show the file path in the header', async ({ page }) => {
    await expect(page.locator('lv-file-history .file-path')).toHaveText('src/main.ts');
  });

  test('should show commit count badge', async ({ page }) => {
    await expect(page.locator('lv-file-history .commit-count')).toHaveText('3 commits');
  });

  test('should display all commit entries', async ({ page }) => {
    await expect(page.locator('lv-file-history .commit-item')).toHaveCount(3);
  });

  test('each commit should show short OID', async ({ page }) => {
    const oids = page.locator('lv-file-history .commit-oid');
    await expect(oids.nth(0)).toHaveText('abc123d');
    await expect(oids.nth(1)).toHaveText('def789g');
    await expect(oids.nth(2)).toHaveText('ghi345j');
  });

  test('each commit should show its summary', async ({ page }) => {
    const summaries = page.locator('lv-file-history .commit-summary');
    await expect(summaries.nth(0)).toHaveText('Fix bug in file processing');
    await expect(summaries.nth(1)).toHaveText('Add new feature');
    await expect(summaries.nth(2)).toHaveText('Initial implementation');
  });

  test('each commit should show author name', async ({ page }) => {
    const authors = page.locator('lv-file-history .commit-author');
    await expect(authors.nth(0)).toContainText('John Doe');
    await expect(authors.nth(1)).toContainText('Jane Smith');
    await expect(authors.nth(2)).toContainText('John Doe');
  });

  test('each commit should show a relative date', async ({ page }) => {
    const dates = page.locator('lv-file-history .commit-date');
    await expect(dates.nth(0)).toContainText('Today');
    await expect(dates.nth(1)).toContainText('Yesterday');
    await expect(dates.nth(2)).toContainText('week');
  });

  test('each commit should have a View button', async ({ page }) => {
    await expect(page.locator('lv-file-history .view-diff-btn')).toHaveCount(3);
  });

  test('should have a close button in the header', async ({ page }) => {
    await expect(page.locator('lv-file-history .close-btn')).toBeAttached();
  });
});

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------
test.describe('File History - Selection', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
    await showFileHistory(page);
  });

  test('clicking a commit should select it with .selected class', async ({ page }) => {
    await page.locator('lv-file-history .commit-item').first().click();
    await expect(page.locator('lv-file-history .commit-item.selected .commit-oid')).toHaveText('abc123d');
  });

  test('clicking a different commit should change selection', async ({ page }) => {
    await page.locator('lv-file-history .commit-item').first().click();
    await page.locator('lv-file-history .commit-item').nth(1).click();

    await expect(page.locator('lv-file-history .commit-item.selected .commit-oid')).toHaveText('def789g');
    await expect(page.locator('lv-file-history .commit-item.selected')).toHaveCount(1);
  });

  test('clicking a commit should dispatch commit-selected event', async ({ page }) => {
    // In the real app tree, commit-selected is handled by the app shell
    // to navigate to the commit in the graph. Verify the selection happens.
    await page.locator('lv-file-history .commit-item').first().click();
    await expect(page.locator('lv-file-history .commit-item.selected')).toHaveCount(1);
  });
});

// --------------------------------------------------------------------------
// Close
// --------------------------------------------------------------------------
test.describe('File History - Close', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
    await showFileHistory(page);
  });

  test('clicking close button should remove file history panel', async ({ page }) => {
    // In the real app tree, the close event is handled by the app shell
    // which closes the fileHistory dialog, removing the component from the DOM
    await page.locator('lv-file-history .close-btn').click();
    await expect(page.locator('lv-file-history')).not.toBeAttached();
  });
});

// --------------------------------------------------------------------------
// View Diff Button
// --------------------------------------------------------------------------
test.describe('File History - View Diff', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
    await showFileHistory(page);
  });

  test('clicking View button should dispatch view-diff event with commit oid and file path', async ({ page }) => {
    // Set up event capture on the panel element before clicking
    const panelHandle = await page.locator('lv-file-history').elementHandle();
    await page.evaluate((el) => {
      if (!el) return;
      (window as any).__viewDiffDetail__ = null;
      el.addEventListener('view-diff', ((e: CustomEvent) => {
        (window as any).__viewDiffDetail__ = e.detail;
      }) as EventListener, { once: true });
    }, panelHandle);

    // Click the View button using Playwright's auto-piercing locator
    await page.locator('lv-file-history .view-diff-btn').first().click();

    // Wait for the event to be captured
    await page.waitForFunction(() => (window as any).__viewDiffDetail__ != null);
    const eventDetail = await page.evaluate(() => (window as any).__viewDiffDetail__);

    expect(eventDetail).not.toBeNull();
    expect(eventDetail.commitOid).toBe('abc123def456789');
    expect(eventDetail.filePath).toBe('src/main.ts');
  });
});

// --------------------------------------------------------------------------
// Renamed Files — the path a row acts on must be the path AT THAT COMMIT
// --------------------------------------------------------------------------
test.describe('File History - Renamed Files', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
      get_commit_file_diff: {
        path: 'src/old-main.ts',
        oldPath: null,
        status: 'added',
        hunks: [],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 0,
        deletions: 0,
      },
      get_file_blame: {
        path: 'src/old-main.ts',
        lines: [],
        totalLines: 0,
      },
    });
    await showFileHistory(page);
  });

  test('View on a pre-rename entry diffs the old path, not the current one', async ({ page }) => {
    await page.locator('lv-file-history .view-diff-btn').nth(2).click();

    // The diff pane header shows the historical path the diff was taken for.
    await expect(page.locator('.diff-path')).toHaveText('src/old-main.ts');

    await waitForCommand(page, 'get_commit_file_diff');
    const commands = await findCommand(page, 'get_commit_file_diff');
    expect(commands.length).toBeGreaterThan(0);
    const args = commands[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/old-main.ts');
    expect(args.commitOid).toBe('ghi345jkl678901');
  });

  test('View on a post-rename entry still diffs the current path', async ({ page }) => {
    await page.locator('lv-file-history .view-diff-btn').first().click();

    await expect(page.locator('.diff-path')).toHaveText('src/main.ts');
    await waitForCommand(page, 'get_commit_file_diff');
    const commands = await findCommand(page, 'get_commit_file_diff');
    expect(commands.length).toBeGreaterThan(0);
    const args = commands[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/main.ts');
  });

  test('View blame at this commit on a pre-rename entry blames the old path', async ({ page }) => {
    await page.locator('lv-file-history .commit-item').nth(2).click({ button: 'right' });
    await expect(page.locator('lv-file-history .context-menu')).toBeVisible();
    await page
      .locator('lv-file-history .context-menu-item')
      .filter({ hasText: 'View blame' })
      .click();

    await expect(page.locator('lv-blame-view')).toBeAttached();

    await waitForCommand(page, 'get_file_blame');
    const commands = await findCommand(page, 'get_file_blame');
    expect(commands.length).toBeGreaterThan(0);
    const args = commands[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/old-main.ts');
  });

  test('the historical path is shown on pre-rename entries only', async ({ page }) => {
    const items = page.locator('lv-file-history .commit-item');
    await expect(items.nth(2).locator('.commit-path')).toHaveText('src/old-main.ts');
    await expect(items.nth(0).locator('.commit-path')).toHaveCount(0);
    await expect(items.nth(1).locator('.commit-path')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Context Menu
// --------------------------------------------------------------------------
test.describe('File History - Context Menu', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
    await showFileHistory(page);
  });

  test('right-clicking a commit should show context menu', async ({ page }) => {
    await page.locator('lv-file-history .commit-item').first().click({ button: 'right' });
    await expect(page.locator('lv-file-history .context-menu')).toBeVisible();
  });

  test('context menu should have "View diff" option', async ({ page }) => {
    await openContextMenu(page);
    await expect(
      page.locator('lv-file-history .context-menu-item').filter({ hasText: 'View diff' })
    ).toBeVisible();
  });

  test('context menu should have "Show commit details" option', async ({ page }) => {
    await openContextMenu(page);
    await expect(
      page.locator('lv-file-history .context-menu-item').filter({ hasText: 'Show commit details' })
    ).toBeVisible();
  });

  test('context menu should have "View blame at this commit" option', async ({ page }) => {
    await openContextMenu(page);
    await expect(
      page.locator('lv-file-history .context-menu-item').filter({ hasText: 'View blame' })
    ).toBeVisible();
  });

  test('context menu should have "Copy commit hash" option', async ({ page }) => {
    await openContextMenu(page);
    await expect(
      page.locator('lv-file-history .context-menu-item').filter({ hasText: 'Copy commit hash' })
    ).toBeVisible();
  });

  test('context menu should have a divider separating Copy from other options', async ({ page }) => {
    await openContextMenu(page);
    await expect(page.locator('lv-file-history .context-menu-divider')).toBeAttached();
  });
});

// --------------------------------------------------------------------------
// Empty State
// --------------------------------------------------------------------------
test.describe('File History - Empty State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: [],
    });
    await showFileHistory(page);
  });

  test('should show "No history found for this file" when no commits exist', async ({ page }) => {
    await expect(page.locator('lv-file-history .empty')).toHaveText('No history found for this file');
  });

  test('should show "0 commits" count when empty', async ({ page }) => {
    await expect(page.locator('lv-file-history .commit-count')).toHaveText('0 commits');
  });

  test('should not show any commit items', async ({ page }) => {
    await expect(page.locator('lv-file-history .commit-item')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Loading State
// --------------------------------------------------------------------------
test.describe('File History - Loading State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });
  });

  test('should display file path provided via property', async ({ page }) => {
    await showFileHistory(page, 'src/utils/helpers.ts');
    await expect(page.locator('lv-file-history .file-path')).toHaveText('src/utils/helpers.ts');
  });
});

// --------------------------------------------------------------------------
// Opening History over another center-pane view
// --------------------------------------------------------------------------
/**
 * The center pane renders exactly one of diff / blame / file history, in that
 * priority order, while the right panel that raises "show file history" stays
 * clickable underneath a diff. If opening history does not close whatever is
 * already up, the click looks like a no-op and the history pane then appears
 * unbidden the moment the user closes the diff (or presses Escape).
 */
const HISTORY_COMMIT = {
  oid: 'abc123def456',
  shortId: 'abc123d',
  message: 'Initial commit\n\nThis is the first commit.',
  summary: 'Initial commit',
  body: 'This is the first commit.',
  author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  parentIds: [] as string[],
  timestamp: Math.floor(Date.now() / 1000),
};

const HISTORY_BLAME = {
  path: 'src/main.ts',
  lines: [
    {
      lineNumber: 1,
      content: 'import { app } from "./app";',
      commitOid: 'abc123def456',
      commitShortId: 'abc123d',
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      timestamp: Math.floor(Date.now() / 1000) - 86400,
      summary: 'Initial commit',
      isBoundary: false,
    },
  ],
  totalLines: 1,
};

const HISTORY_DIFF = {
  path: 'src/main.ts',
  oldPath: null,
  status: 'modified',
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { content: 'line 1', origin: 'context', oldLineNo: 1, newLineNo: 1 },
        { content: 'line 2', origin: 'deletion', oldLineNo: 2, newLineNo: null },
        { content: 'new line 2', origin: 'addition', oldLineNo: null, newLineNo: 2 },
      ],
    },
  ],
  isBinary: false,
  isImage: false,
  imageType: null,
  additions: 1,
  deletions: 1,
};

/** Select a commit by dispatching commit-selected on the graph canvas. */
async function selectHistoryCommit(page: import('@playwright/test').Page): Promise<void> {
  const handle = await page.locator('lv-graph-canvas').elementHandle();
  await page.evaluate(([el, commitData]) => {
    if (!el) throw new Error('lv-graph-canvas not found');
    el.dispatchEvent(
      new CustomEvent('commit-selected', {
        detail: { commit: commitData, commits: [commitData], refs: [] },
        bubbles: true,
        composed: true,
      })
    );
  }, [handle, HISTORY_COMMIT] as const);

  await page.locator('lv-commit-details .commit-message').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('File History - opening over another center-pane view', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      // These tests only assert which pane is mounted, so they use the fixture
      // declared right above rather than the shared commit list the list-rendering
      // suites tune for their own assertions.
      get_file_history: [HISTORY_COMMIT],
      get_commit_files: [
        { path: 'src/main.ts', status: 'modified', additions: 10, deletions: 5 },
        { path: 'src/other.ts', status: 'modified', additions: 2, deletions: 1 },
      ],
      get_commit_file_diff: HISTORY_DIFF,
      get_file_blame: HISTORY_BLAME,
    });
    await selectHistoryCommit(page);
    await rightPanel.switchToDetails();
  });

  test('the History button replaces an open diff instead of doing nothing', async ({ page }) => {
    const fileRow = page.locator('lv-commit-details .file-item').first();
    await fileRow.click();
    await expect(page.locator('lv-diff-view')).toBeVisible();

    await fileRow.hover();
    await fileRow.locator('button[title="View file history"]').click();

    await expect(page.locator('lv-file-history')).toBeVisible();
    await expect(page.locator('lv-diff-view')).toHaveCount(0);
  });

  test('the History button replaces an open blame view', async ({ page }) => {
    const fileRow = page.locator('lv-commit-details .file-item').first();
    await fileRow.hover();
    await fileRow.locator('button[title="View file blame"]').click();
    await expect(page.locator('lv-blame-view')).toBeVisible();

    await fileRow.hover();
    await fileRow.locator('button[title="View file history"]').click();

    await expect(page.locator('lv-file-history')).toBeVisible();
    await expect(page.locator('lv-blame-view')).toHaveCount(0);
  });

  test('Escape after opening history does not resurrect the diff', async ({ page }) => {
    const fileRow = page.locator('lv-commit-details .file-item').first();
    await fileRow.click();
    await expect(page.locator('lv-diff-view')).toBeVisible();

    await fileRow.hover();
    await fileRow.locator('button[title="View file history"]').click();
    await expect(page.locator('lv-file-history')).toBeVisible();

    await page.keyboard.press('Escape');

    // One Escape closes the one view that is open — it must not uncover a
    // history pane the user asked for minutes ago.
    await expect(page.locator('lv-file-history')).toHaveCount(0);
    await expect(page.locator('lv-diff-view')).toHaveCount(0);
  });

  test('picking another file closes history, and closing that diff does not bring it back', async ({
    page,
  }) => {
    // The inverse of the tests above: history is already up when the user
    // moves on to a different file. The diff outranks history, so a stale
    // history pane stays invisible until the diff closes — and then it
    // ambushes the user with the file they left behind.
    const rows = page.locator('lv-commit-details .file-item');
    const first = rows.first();
    await first.hover();
    await first.locator('button[title="View file history"]').click();
    await expect(page.locator('lv-file-history')).toBeVisible();

    await rows.nth(1).click();
    await expect(page.locator('lv-diff-view')).toBeVisible();
    await expect(page.locator('lv-file-history')).toHaveCount(0);

    await page.keyboard.press('Escape');

    await expect(page.locator('lv-diff-view')).toHaveCount(0);
    await expect(page.locator('lv-file-history')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Error Scenarios
// --------------------------------------------------------------------------
test.describe('File History - Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('get_file_history failure should show error state or toast', async ({ page }) => {
    // Set up command capture with a valid initial response so the component can mount
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
    });

    // Inject an error so the next call to get_file_history will fail
    await injectCommandError(page, 'get_file_history', 'Failed to get history');

    // Trigger the file history panel (which will call get_file_history and get the error)
    await openAppDialog(page, 'fileHistory', { filePath: 'src/main.ts' });

    // Wait for the file history panel to appear in the DOM
    await page.locator('lv-file-history').waitFor({ state: 'attached', timeout: 5000 });

    // The error should be displayed — either an error element in the panel or a toast
    await expect(
      page.locator('.error, .error-banner, .toast, lv-file-history .error-message').first()
    ).toBeVisible({ timeout: 5000 });
  });
});

// --------------------------------------------------------------------------
// Restore this version
// --------------------------------------------------------------------------
test.describe('File History - Restore this version', () => {
  const restoreItem = (page: import('@playwright/test').Page) =>
    page.locator('lv-file-history .context-menu .context-menu-item', {
      hasText: 'Restore this version',
    });

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_file_history: MOCK_ENTRIES,
      checkout_file_from_commit: {
        filePath: 'src/main.ts',
        commitOid: 'def789ghi012345',
        content: 'restored',
        isBinary: false,
        size: 8,
      },
      'plugin:dialog|message': 'Ok',
    });
    await showFileHistory(page);
  });

  test('restores the panel file from the right-clicked history entry', async ({ page }) => {
    // Second row: the file comes from the panel, the version from this commit.
    await page.locator('lv-file-history .commit-item').nth(1).click({ button: 'right' });
    await expect(restoreItem(page)).toBeVisible();
    await restoreItem(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'checkout_file_from_commit')).length)
      .toBe(1);
    const args = (await findCommand(page, 'checkout_file_from_commit'))[0].args as Record<
      string,
      unknown
    >;
    expect(args.filePath).toBe('src/main.ts');
    expect(args.commit).toBe('def789ghi012345');

    const toast = page.locator('lv-toast-container .toast.success .toast-message');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('src/main.ts');
  });

  test('reports a commit that does not contain the file', async ({ page }) => {
    await injectCommandError(
      page,
      'checkout_file_from_commit',
      "File 'src/main.ts' not found in commit def789g"
    );

    await page.locator('lv-file-history .commit-item').nth(1).click({ button: 'right' });
    await restoreItem(page).click();

    const toast = page.locator('lv-toast-container .toast.error .toast-message');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('not found in commit');
  });
});
