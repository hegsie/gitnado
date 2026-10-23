import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandMock,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * Helper to select a commit by dispatching the commit-selected event on the graph canvas.
 * The graph canvas is inside app-shell's shadow DOM, so we traverse it manually.
 * The event handler on app-shell sets selectedCommit and auto-switches to the Details tab.
 */
async function selectCommit(
  page: import('@playwright/test').Page,
  commit: {
    oid: string;
    shortId: string;
    message: string;
    summary: string;
    body: string | null;
    author: { name: string; email: string; timestamp: number };
    committer: { name: string; email: string; timestamp: number };
    parentIds: string[];
    timestamp: number;
  }
): Promise<void> {
  const graphCanvas = page.locator('gn-graph-canvas');
  const handle = await graphCanvas.elementHandle();
  await page.evaluate(([el, commitData]) => {
    if (!el) throw new Error('gn-graph-canvas not found');
    el.dispatchEvent(
      new CustomEvent('commit-selected', {
        detail: { commit: commitData, commits: [commitData], refs: [] },
        bubbles: true,
        composed: true,
      })
    );
  }, [handle, commit] as const);

  // Wait for the commit details component to receive the commit and render
  await page.locator('gn-commit-details .commit-message').waitFor({ state: 'visible', timeout: 5000 });
}

/** Default commit used for most tests */
const defaultCommit = {
  oid: 'abc123def456',
  shortId: 'abc123d',
  message: 'Initial commit\n\nThis is the first commit.',
  summary: 'Initial commit',
  body: 'This is the first commit.',
  author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
  committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
  parentIds: [] as string[],
  timestamp: Date.now() / 1000,
};

/** Mock files for commit file list tests */
const mockFiles = [
  { path: 'src/main.ts', status: 'modified', additions: 10, deletions: 5 },
  { path: 'src/utils/helper.ts', status: 'new', additions: 25, deletions: 0 },
  { path: 'README.md', status: 'modified', additions: 3, deletions: 1 },
];

test.describe('Commit Details Panel', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, { get_commit_files: mockFiles });
    await selectCommit(page, defaultCommit);
  });

  test('should show commit details panel when Details tab is clicked', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitDetails).toBeVisible();
  });

  test('should show commit SHA', async ({ page }) => {
    await rightPanel.switchToDetails();

    // The component renders SHA in a <code class="commit-oid"> element
    const shaElement = rightPanel.commitDetails.locator('.commit-oid');
    await expect(shaElement).toBeVisible();
    // The default mock commit has oid 'abc123def456', displayed as first 7 chars
    await expect(shaElement).toContainText('abc123d');
  });

  test('should show author name', async ({ page }) => {
    await rightPanel.switchToDetails();

    // Author section has section-title "Author" followed by meta-value with name
    const authorSection = rightPanel.commitDetails.locator('.section', { hasText: 'Author' });
    await expect(authorSection).toBeVisible();

    const authorName = authorSection.locator('.meta-value').first();
    await expect(authorName).toContainText('Test User');
  });

  test('should show timestamp', async ({ page }) => {
    await rightPanel.switchToDetails();

    // Timestamp is in a .timestamp element within the Author section
    const timestamp = rightPanel.commitDetails.locator('.timestamp');
    await expect(timestamp).toBeVisible();
    // Should contain some time text (relative or absolute)
    const text = await timestamp.textContent();
    expect(text!.length).toBeGreaterThan(0);
  });

  test('should show commit message summary', async ({ page }) => {
    await rightPanel.switchToDetails();

    const summary = rightPanel.commitDetails.locator('.commit-message');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Initial commit');
  });
});

test.describe('Commit Details - Files Changed', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, { get_commit_files: mockFiles });
    await selectCommit(page, defaultCommit);
  });

  test('should show files changed section', async ({ page }) => {
    await rightPanel.switchToDetails();

    // The section title is "Files Changed (N)" where N is the count
    const filesSection = rightPanel.commitDetails.locator('.section-title', { hasText: 'Files Changed' });
    await expect(filesSection).toBeVisible();
  });

  test('should list exactly 3 files', async ({ page }) => {
    await rightPanel.switchToDetails();

    // Wait for file items to appear
    const fileItems = rightPanel.commitFilesChanged;
    await expect(fileItems).toHaveCount(3);
  });

  test('should display file names', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);

    // Check individual file names are present (filenames are just the basename)
    const fileTexts = rightPanel.commitDetails.locator('.file-name');
    await expect(fileTexts.nth(0)).toContainText('main.ts');
    await expect(fileTexts.nth(1)).toContainText('helper.ts');
    await expect(fileTexts.nth(2)).toContainText('README.md');
  });

  test('file items should be clickable', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);

    // Click the first file item - it should get selected
    const firstFile = rightPanel.commitFilesChanged.first();
    await firstFile.click();

    // After clicking, the file-item should have the 'selected' class
    await expect(firstFile).toHaveClass(/selected/);
  });

  test('should show file status indicators', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);

    // First file is 'modified' -> status label 'M'
    const firstStatus = rightPanel.commitFilesChanged.nth(0).locator('.file-status');
    await expect(firstStatus).toContainText('M');
    await expect(firstStatus).toHaveClass(/modified/);

    // Second file is 'new' -> status label 'A'
    const secondStatus = rightPanel.commitFilesChanged.nth(1).locator('.file-status');
    await expect(secondStatus).toContainText('A');
    await expect(secondStatus).toHaveClass(/new/);
  });
});

test.describe('Commit Details - Context Menu', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, { get_commit_files: mockFiles });
    await selectCommit(page, defaultCommit);
  });

  test('should open context menu on right-click on file', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);

    // Right-click on the first file item
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });

    // Context menu should appear within the commit-details shadow DOM
    const contextMenu = rightPanel.commitDetails.locator('.context-menu');
    await expect(contextMenu).toBeVisible();
  });

  test('context menu should have View diff option', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });

    const contextMenu = rightPanel.commitDetails.locator('.context-menu');
    await expect(contextMenu).toBeVisible();

    const viewDiffItem = contextMenu.locator('.context-menu-item', { hasText: 'View diff' });
    await expect(viewDiffItem).toBeVisible();
  });

  test('context menu should have Copy file path option', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });

    const contextMenu = rightPanel.commitDetails.locator('.context-menu');
    await expect(contextMenu).toBeVisible();

    const copyPathItem = contextMenu.locator('.context-menu-item', { hasText: 'Copy file path' });
    await expect(copyPathItem).toBeVisible();
  });

  test('context menu should have View history option', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });

    const contextMenu = rightPanel.commitDetails.locator('.context-menu');
    await expect(contextMenu).toBeVisible();

    const historyItem = contextMenu.locator('.context-menu-item', { hasText: 'View history' });
    await expect(historyItem).toBeVisible();
  });

  test('context menu should have View blame option for non-deleted files', async ({ page }) => {
    await rightPanel.switchToDetails();

    await expect(rightPanel.commitFilesChanged).toHaveCount(3);
    // Right-click on the first file (modified, not deleted)
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });

    const contextMenu = rightPanel.commitDetails.locator('.context-menu');
    await expect(contextMenu).toBeVisible();

    const blameItem = contextMenu.locator('.context-menu-item', { hasText: 'View blame' });
    await expect(blameItem).toBeVisible();
  });
});

test.describe('Commit Details - Parent Commits', () => {
  let rightPanel: RightPanelPage;

  /** Commit with a parent */
  const commitWithParent = {
    oid: 'def456abc789',
    shortId: 'def456a',
    message: 'Add feature\n\nImplemented new feature.',
    summary: 'Add feature',
    body: 'Implemented new feature.',
    author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
    parentIds: ['abc123def456'],
    timestamp: Date.now() / 1000,
  };

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, { get_commit_files: [] });
    await selectCommit(page, commitWithParent);
  });

  test('should show parent commit section', async ({ page }) => {
    await rightPanel.switchToDetails();

    // The parent section has section-title "Parent"
    const parentSection = rightPanel.commitDetails.locator('.section-title', { hasText: 'Parent' });
    await expect(parentSection).toBeVisible();
  });

  test('should show parent commit OID as clickable link', async ({ page }) => {
    await rightPanel.switchToDetails();

    const parentOid = rightPanel.commitDetails.locator('.parent-oid');
    await expect(parentOid).toBeVisible();
    // Parent OID should show first 7 chars of 'abc123def456'
    await expect(parentOid).toContainText('abc123d');
  });

  test('parent OID should be clickable', async ({ page }) => {
    await rightPanel.switchToDetails();

    await startCommandCapture(page);

    const parentOid = rightPanel.commitDetails.locator('.parent-oid');
    await expect(parentOid).toBeVisible();

    // Clicking the parent OID dispatches a 'select-commit' event
    // We verify it's clickable and doesn't throw
    await parentOid.click();
  });
});

test.describe('Commit Details - Error Handling', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should handle get_commit_files failure gracefully', async ({ page }) => {
    // Inject error for get_commit_files - this makes it throw
    await injectCommandError(page, 'get_commit_files', 'Failed to read commit files');

    // Select the commit AFTER injecting the error
    await selectCommit(page, defaultCommit);

    await rightPanel.switchToDetails();

    // The component should still be visible and not crash
    await expect(rightPanel.commitDetails).toBeVisible();

    // Files section should show "Files Changed (0)" with empty state (not a crash)
    const filesTitle = rightPanel.commitDetails.locator('.section-title', { hasText: 'Files Changed' });
    await expect(filesTitle).toBeVisible();

    // File items should be empty (0 files)
    await expect(rightPanel.commitFilesChanged).toHaveCount(0);
  });

});

test.describe('Commit Details - UI Outcome Verification', () => {
  let rightPanel: RightPanelPage;

  test('clicking a file in commit details should open diff view with content', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    // Provide commit files
    await injectCommandMock(page, {
      get_commit_files: mockFiles,
      get_commit_file_diff: {
        path: 'src/main.ts',
        oldPath: null,
        status: 'modified',
        hunks: [
          {
            header: '@@ -1,3 +1,4 @@',
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            lines: [
              { content: 'import { App } from "./app";', origin: 'context', oldLineNo: 1, newLineNo: 1 },
              { content: 'const x = 1;', origin: 'deletion', oldLineNo: 2, newLineNo: null },
              { content: 'const x = 2;', origin: 'addition', oldLineNo: null, newLineNo: 2 },
              { content: 'export default App;', origin: 'context', oldLineNo: 3, newLineNo: 3 },
            ],
          },
        ],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 1,
        deletions: 1,
      },
    });

    await selectCommit(page, defaultCommit);
    await rightPanel.switchToDetails();

    // Wait for file items to appear
    await expect(rightPanel.commitFilesChanged).toHaveCount(3);

    // Click on the first file to open diff
    await rightPanel.commitFilesChanged.first().click();

    // Verify the file becomes selected
    await expect(rightPanel.commitFilesChanged.first()).toHaveClass(/selected/);

    // Verify the diff view becomes visible with the mocked content
    const diffView = page.locator('gn-diff-view');
    await expect(diffView).toBeVisible({ timeout: 5000 });
    await expect(diffView.locator('.line.code-addition')).toHaveCount(1);
    await expect(diffView.locator('.line.code-deletion')).toHaveCount(1);
    await expect(diffView.locator('.line.code-addition')).toContainText('const x = 2;');
  });

  test('merge commit with multiple parents should show merge info', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    const mergeCommit = {
      oid: 'merge123abc456',
      shortId: 'merge12',
      message: 'Merge branch "feature" into main\n\nMerged feature branch.',
      summary: 'Merge branch "feature" into main',
      body: 'Merged feature branch.',
      author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      parentIds: ['parent1abc', 'parent2def'],
      timestamp: Date.now() / 1000,
    };

    await injectCommandMock(page, { get_commit_files: [] });
    await selectCommit(page, mergeCommit);
    await rightPanel.switchToDetails();

    // Verify the parent section is visible
    const parentSection = rightPanel.commitDetails.locator('.section-title', { hasText: 'Parent' });
    await expect(parentSection).toBeVisible();

    // Verify both parent OIDs are shown (merge commit has two parents)
    const parentOids = rightPanel.commitDetails.locator('.parent-oid');
    await expect(parentOids).toHaveCount(2);

    // Verify the parent OIDs show the short forms
    await expect(parentOids.nth(0)).toContainText('parent1');
    await expect(parentOids.nth(1)).toContainText('parent2');
  });

  test('root commit with no parents should not show parent navigation', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    const rootCommit = {
      oid: 'root000abc123',
      shortId: 'root000',
      message: 'Initial commit\n\nVery first commit in the repository.',
      summary: 'Initial commit',
      body: 'Very first commit in the repository.',
      author: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      committer: { name: 'Test User', email: 'test@example.com', timestamp: Date.now() / 1000 },
      parentIds: [],
      timestamp: Date.now() / 1000,
    };

    await injectCommandMock(page, { get_commit_files: [] });
    await selectCommit(page, rootCommit);
    await rightPanel.switchToDetails();

    // Verify the commit details panel is visible
    await expect(rightPanel.commitDetails).toBeVisible();

    // Verify the commit message is displayed
    const summary = rightPanel.commitDetails.locator('.commit-message');
    await expect(summary).toContainText('Initial commit');

    // Verify no parent OID links are shown for a root commit
    const parentOids = rightPanel.commitDetails.locator('.parent-oid');
    await expect(parentOids).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Restore a file to its version in the selected commit
// --------------------------------------------------------------------------
test.describe('Commit Details - Restore file from commit', () => {
  let rightPanel: RightPanelPage;

  /** Files including a deleted one, whose blob is not in this commit's tree. */
  const restoreFiles = [
    { path: 'src/main.ts', status: 'modified', additions: 10, deletions: 5 },
    { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 9 },
  ];

  const restoreItem = (page: import('@playwright/test').Page) =>
    page.locator('gn-commit-details .context-menu .context-menu-item', {
      hasText: 'Restore this version',
    });

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_commit_files: restoreFiles,
      checkout_file_from_commit: {
        filePath: 'src/main.ts',
        commitOid: 'abc123def456',
        content: 'restored',
        isBinary: false,
        size: 8,
      },
      'plugin:dialog|message': 'Ok',
    });
    await selectCommit(page, defaultCommit);
    await rightPanel.switchToDetails();
    await expect(rightPanel.commitFilesChanged).toHaveCount(2);
  });

  test('restores a file from the selected commit and confirms it', async ({ page }) => {
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });
    await expect(restoreItem(page)).toBeVisible();
    await restoreItem(page).click();

    // The user is warned before the working copy is overwritten and staged.
    const confirms = await findCommand(page, 'plugin:dialog|message');
    expect(confirms.length).toBeGreaterThan(0);
    const confirmArgs = confirms[confirms.length - 1].args as Record<string, string>;
    expect(confirmArgs.title).toBe('Restore File');
    expect(confirmArgs.message).toContain('src/main.ts');
    expect(confirmArgs.message).toMatch(/overwrites/i);
    expect(confirmArgs.message).toMatch(/stages/i);

    await expect
      .poll(async () => (await findCommand(page, 'checkout_file_from_commit')).length)
      .toBe(1);
    const calls = await findCommand(page, 'checkout_file_from_commit');
    const args = calls[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/main.ts');
    expect(args.commit).toBe('abc123def456');

    const toast = page.locator('gn-toast-container .toast.success .toast-message');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('src/main.ts');
  });

  test('offers restore for a file the commit changed but not one it deleted', async ({ page }) => {
    // Both halves in one test so the negative cannot pass vacuously.
    await rightPanel.commitFilesChanged.first().click({ button: 'right' });
    await expect(restoreItem(page)).toBeVisible();
    // A document click dismisses it (handleDocumentClick).
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await expect(rightPanel.commitDetails.locator('.context-menu')).toHaveCount(0);

    // The deleted file's blob is not in this commit's tree, so restoring it
    // could only fail — the item is hidden rather than offered and refused.
    await rightPanel.commitFilesChanged.nth(1).click({ button: 'right' });
    await expect(rightPanel.commitDetails.locator('.context-menu')).toBeVisible();
    await expect(restoreItem(page)).toHaveCount(0);
  });

  test('declining the confirm restores nothing', async ({ page }) => {
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });

    await rightPanel.commitFilesChanged.first().click({ button: 'right' });
    await restoreItem(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'plugin:dialog|message')).length)
      .toBeGreaterThan(0);
    expect(await findCommand(page, 'checkout_file_from_commit')).toHaveLength(0);
    await expect(page.locator('gn-toast-container .toast')).toHaveCount(0);
  });

  test('shows an error toast when the restore fails', async ({ page }) => {
    await injectCommandError(page, 'checkout_file_from_commit', 'File not found in commit');

    await rightPanel.commitFilesChanged.first().click({ button: 'right' });
    await restoreItem(page).click();

    const toast = page.locator('gn-toast-container .toast.error .toast-message');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('File not found in commit');
  });
});

test.describe('Commit Details - Renamed Files', () => {
  /** The rename entry the backend reports for a moved-and-edited file. */
  const renamedEntry = {
    path: 'src/new_name.ts',
    oldPath: 'src/old_name.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
  };

  test('clicking a renamed file shows the rename diff, not the whole file as added', async ({
    page,
  }) => {
    const rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      get_commit_files: [renamedEntry],
      get_commit_file_diff: {
        path: 'src/new_name.ts',
        oldPath: 'src/old_name.ts',
        status: 'renamed',
        hunks: [
          {
            header: '@@ -1,4 +1,4 @@',
            oldStart: 1,
            oldLines: 4,
            newStart: 1,
            newLines: 4,
            lines: [
              { content: 'alpha', origin: 'context', oldLineNo: 1, newLineNo: 1 },
              { content: 'beta', origin: 'deletion', oldLineNo: 2, newLineNo: null },
              { content: 'beta-edited', origin: 'addition', oldLineNo: null, newLineNo: 2 },
              { content: 'gamma', origin: 'context', oldLineNo: 3, newLineNo: 3 },
            ],
          },
        ],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 1,
        deletions: 1,
      },
    });

    await selectCommit(page, defaultCommit);
    await rightPanel.switchToDetails();

    // The file list must badge the entry as a rename and name where it came from.
    await expect(rightPanel.commitFilesChanged).toHaveCount(1);
    await expect(rightPanel.commitFilesChanged.first().locator('.file-status')).toHaveText('R');
    await expect(rightPanel.commitFilesChanged.first().locator('.file-renamed-from')).toContainText(
      'src/old_name.ts'
    );

    await rightPanel.commitFilesChanged.first().click();

    const diffView = page.locator('gn-diff-view');
    await expect(diffView).toBeVisible({ timeout: 5000 });

    // Only the edited pair renders — a whole-file add would show every line as
    // an addition and none as a deletion.
    await expect(diffView.locator('.line.code-addition')).toHaveCount(1);
    await expect(diffView.locator('.line.code-addition')).toContainText('beta-edited');
    await expect(diffView.locator('.line.code-deletion')).toHaveCount(1);
    await expect(diffView.locator('.line.code-deletion')).toContainText('beta');

    // The command must be asked for the file's current path in this commit.
    const calls = await findCommand(page, 'get_commit_file_diff');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0].args as { filePath: string }).filePath).toBe('src/new_name.ts');
    expect((calls[0].args as { commitOid: string }).commitOid).toBe(defaultCommit.oid);
  });

  test('a pure rename shows the empty-diff notice rather than a blank pane', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_commit_files: [{ ...renamedEntry, additions: 0, deletions: 0 }],
      get_commit_file_diff: {
        path: 'src/new_name.ts',
        oldPath: 'src/old_name.ts',
        status: 'renamed',
        hunks: [],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 0,
        deletions: 0,
      },
    });

    await selectCommit(page, defaultCommit);
    await rightPanel.switchToDetails();
    await rightPanel.commitFilesChanged.first().click();

    const diffView = page.locator('gn-diff-view');
    await expect(diffView.locator('.empty')).toHaveText('No changes in this file');
    await expect(diffView.locator('.line.code-addition')).toHaveCount(0);
  });

  test('a failing rename diff shows an error instead of an empty pane', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);

    await injectCommandMock(page, { get_commit_files: [renamedEntry] });
    await injectCommandError(page, 'get_commit_file_diff', 'File not found in commit');

    await selectCommit(page, defaultCommit);
    await rightPanel.switchToDetails();
    await rightPanel.commitFilesChanged.first().click();

    const diffView = page.locator('gn-diff-view');
    await expect(diffView.locator('.error')).toContainText('File not found in commit');
  });
});
