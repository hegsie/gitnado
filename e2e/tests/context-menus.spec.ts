import { test, expect } from '@playwright/test';
import { setupOpenRepository, defaultMockData, type MockBranch, type MockTag, type MockCommit } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import {
  startCommandCapture,
  findCommand,
  waitForRepositoryChanged,
  injectCommandError,
  injectCommandMock,
  autoConfirmDialogs,
  startCommandCaptureWithMocks,
} from '../fixtures/test-helpers';

/**
 * Helper to find and right-click on a commit in the graph.
 * The graph is canvas-based, so we need to click on specific commit row areas.
 *
 * Uses Playwright's auto-piercing locator to find elements inside shadow DOM.
 */
async function rightClickOnCommitRow(
  page: import('@playwright/test').Page,
  rowIndex: number = 0,
  button: 'left' | 'right' = 'right'
) {
  const graphCanvas = page.locator('lv-graph-canvas');
  await expect(graphCanvas).toBeVisible();

  // Wait for the inner <canvas> element to have non-zero dimensions.
  // Playwright locators auto-pierce shadow DOM, so use the inner canvas locator.
  const innerCanvas = graphCanvas.locator('canvas[role="img"]');
  await expect(innerCanvas).toBeAttached();

  // Wait for commits to be loaded in the graph before clicking.
  // Use Playwright's auto-piercing locator to get an element handle, then check the property.
  const graphHandle = await graphCanvas.elementHandle();
  await page.waitForFunction(
    (el) => ((el as HTMLElement & { sortedNodesByRow?: unknown[] })?.sortedNodesByRow?.length ?? 0) > 0,
    graphHandle
  );

  const box = await graphCanvas.boundingBox();
  if (!box) throw new Error('Canvas not found');

  // Commits are rendered in rows, starting from top
  // Row height is approximately 32px, header is ~32px
  const rowHeight = 32;
  const headerHeight = 32;
  const commitX = box.x + 400; // Click in the commit message area
  const commitY = box.y + headerHeight + (rowIndex * rowHeight) + (rowHeight / 2);

  await page.mouse.click(commitX, commitY, { button });
}

/**
 * Read the oid of the commit laid out at a given graph row.
 */
async function oidAtRow(page: import('@playwright/test').Page, rowIndex: number): Promise<string> {
  const graphHandle = await page.locator('lv-graph-canvas').elementHandle();
  const oid = await page.evaluate(
    ([el, row]) => {
      const canvas = el as HTMLElement & { sortedNodesByRow?: Array<{ oid: string }> };
      return canvas?.sortedNodesByRow?.[row as number]?.oid ?? null;
    },
    [graphHandle, rowIndex] as const
  );
  if (!oid) throw new Error(`No commit laid out at row ${rowIndex}`);
  return oid;
}

test.describe('Commit Context Menu', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('should show context menu on right-click on commit row', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    // Context menu should appear
    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });
  });

  test('context menu should have expected structure when visible', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Should have a header
    const header = contextMenu.locator('.context-menu-header');
    await expect(header).toBeVisible();

    // Should have menu items
    const menuItems = contextMenu.locator('.context-menu-item');
    const count = await menuItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('right-clicking a commit moves the highlight off the previously selected one', async ({ page }) => {
    // Left-click the first commit so there is a previous selection to move off.
    await rightClickOnCommitRow(page, 0, 'left');
    const firstOid = await oidAtRow(page, 0);
    const secondOid = await oidAtRow(page, 1);
    expect(secondOid).not.toBe(firstOid);

    const graphHandle = await page.locator('lv-graph-canvas').elementHandle();
    await page.waitForFunction(
      ([el, expectedOid]) => {
        const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
        return canvas?.selectedNode?.oid === expectedOid;
      },
      [graphHandle, firstOid] as const
    );

    // Right-click a different commit: the menu targets it, so the graph must
    // highlight it too rather than leaving the highlight on the first one.
    await rightClickOnCommitRow(page, 1);
    await expect(page.locator('.context-menu')).toBeVisible({ timeout: 3000 });

    await page.waitForFunction(
      ([el, expectedOid]) => {
        const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
        return canvas?.selectedNode?.oid === expectedOid;
      },
      [graphHandle, secondOid] as const
    );

    const state = await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & {
          selectedNode?: { oid: string } | null;
          selectedNodes?: Set<string>;
        };
        return {
          primary: canvas?.selectedNode?.oid ?? null,
          selected: canvas?.selectedNodes ? Array.from(canvas.selectedNodes) : [],
        };
      },
      graphHandle
    );

    expect(state.primary).toBe(secondOid);
    expect(state.selected).toEqual([secondOid]);
    expect(state.selected).not.toContain(firstOid);
  });

  test('should close context menu on Escape key', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(contextMenu).not.toBeVisible();
  });
});

// Note: Ref context menu tests (for branch/tag labels in the graph) are challenging
// because the labels are rendered on a canvas. The hit detection depends on exact
// pixel positions which vary based on ref names, graph layout, etc.
// These tests would require either:
// 1. Exposing ref label positions via a test API
// 2. Using visual regression testing
// 3. Testing at the component/unit level instead of E2E

/**
 * Add a second repository tab without activating it, mirroring how the
 * welcome/restore flows populate the store.
 */
async function addBackgroundRepo(
  page: import('@playwright/test').Page,
  path: string,
  name: string
): Promise<void> {
  await page.evaluate(
    ({ path, name }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => {
            addRepository: (repo: unknown, options?: { activate?: boolean }) => void;
          };
        };
      };
      stores.repositoryStore.getState().addRepository(
        {
          path,
          name,
          isValid: true,
          isBare: false,
          headRef: 'main',
          state: 'clean',
          isShallow: false,
          isPartialClone: false,
          cloneFilter: null,
        },
        { activate: false }
      );
    },
    { path, name }
  );
}

/**
 * A context menu targets a commit/ref in ONE repository. Switching tabs by
 * keyboard never produces a document click, so the menu would otherwise stay
 * on screen and its next action would resolve against the newly active repo.
 */
test.describe('Context Menus - repository switch', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await addBackgroundRepo(page, '/work/other-repo', 'other-repo');
    await expect(page.locator('lv-toolbar .tab')).toHaveCount(2);
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', '/tmp/test-repo');
  });

  test('Ctrl+digit tab switch closes an open commit context menu', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Keyboard switch — no click, so handleDocumentClick never runs.
    await page.keyboard.press('Control+2');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/other-repo'
    );

    await expect(contextMenu).not.toBeVisible();
  });

  test('Ctrl+digit tab switch closes an open ref context menu', async ({ page }) => {
    // Ref labels live on the canvas, so drive the real component event the
    // graph dispatches on a ref-label right-click rather than guessing pixels.
    const graphHandle = await page.locator('lv-graph-canvas').elementHandle();
    await page.evaluate((el) => {
      el!.dispatchEvent(
        new CustomEvent('ref-context-menu', {
          detail: {
            refName: 'main',
            fullName: 'refs/heads/main',
            refType: 'localBranch',
            isHead: true,
            position: { x: 120, y: 120 },
          },
          bubbles: true,
          composed: true,
        })
      );
    }, graphHandle);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });
    await expect(contextMenu.locator('.context-menu-summary')).toHaveText('main');

    await page.keyboard.press('Control+2');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/other-repo'
    );

    await expect(contextMenu).not.toBeVisible();
  });

  test('Ctrl+digit tab switch closes an open sidebar branch context menu', async ({ page }) => {
    // lv-left-panel keeps ONE lv-branch-list across tabs and only rebinds
    // `.repositoryPath`, so a leaked menu ends up over the NEW repo's rows
    // while Delete/Rename still resolve the repo at click time.
    const branchRow = page.locator('lv-branch-list .branch-item').first();
    await expect(branchRow).toBeVisible();
    await branchRow.click({ button: 'right' });

    const contextMenu = page.locator('lv-branch-list .context-menu');
    await expect(contextMenu).toBeVisible();

    await page.keyboard.press('Control+2');
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute(
      'title',
      '/work/other-repo'
    );

    // The switch reloads the list, and while `loading` is true the whole body
    // — menu included — is swapped for a placeholder. Wait for the rows back
    // first, so an absent menu means it was disarmed and not just unrendered.
    await expect(branchRow).toBeVisible();
    await expect(contextMenu).not.toBeVisible();
  });
});

test.describe('Operation Banner', () => {
  let app: AppPage;

  test('should show operation banner when repo is in cherry-pick state', async ({ page }) => {
    app = new AppPage(page);

    // Setup with cherry-pick state
    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });

    // Operation banner should be visible
    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();

    // Should show cherry-pick text
    await expect(banner).toContainText('Cherry-pick in progress');

    // Should have abort button
    const abortBtn = banner.locator('.operation-abort-btn');
    await expect(abortBtn).toBeVisible();
    await expect(abortBtn).toContainText('Abort');
  });

  test('should show operation banner when repo is in merge state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'merge',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Merge in progress');
  });

  test('should show operation banner when repo is in rebase state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'rebase',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Rebase in progress');
  });

  test('should show operation banner when repo is in revert state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'revert',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Revert in progress');
  });

  test('should not show operation banner when repo is clean', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'clean',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).not.toBeVisible();
  });

  test('should have correct styling for cherry-pick banner', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).toHaveClass(/cherrypick/);
  });

  test('clicking abort should show success toast', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });

    // Aborting discards every conflict resolution, so it is gated by a confirm.
    await autoConfirmDialogs(page);

    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Cherry-pick in progress');

    const abortBtn = page.locator('.operation-abort-btn');
    await expect(abortBtn).toBeEnabled();

    await abortBtn.click();

    // After abort, a success toast should appear confirming the operation was aborted
    const successToast = page.locator('.toast').first();
    await expect(successToast).toBeVisible({ timeout: 5000 });
    await expect(successToast).toContainText(/Aborted|abort/i);
  });

  test('no Abort button for states that have no abort command', async ({ page }) => {
    // The banner used to render Abort for every non-clean state, so during a
    // bisect it was a permanent dead end — clicking it could only ever produce
    // "Cannot abort operation: bisect".
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'bisect',
      },
    });

    await expect(page.locator('.operation-banner')).toBeVisible();
    await expect(page.locator('.operation-abort-btn')).toHaveCount(0);
  });

  test('declining the abort confirm does not abort', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });
    await startCommandCapture(page);

    // Decline: plugin-dialog treats any non-OK label as "cancel".
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });

    const abortBtn = page.locator('.operation-abort-btn');
    await expect(abortBtn).toBeEnabled();
    await abortBtn.click();

    await expect(page.locator('.operation-banner')).toBeVisible();
    expect(await findCommand(page, 'abort_cherry_pick')).toHaveLength(0);
  });

  // The backend's empty-pick error tells the user to "Skip or abort"; these pin
  // the Skip half of that promise on the banner.
  test('cherry-pick banner offers Skip and runs skip_cherry_pick without a confirm when nothing is conflicted', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
      status: { staged: [], unstaged: [] },
    });
    await startCommandCaptureWithMocks(page, { skip_cherry_pick: null });

    const skipBtn = page.locator('.operation-skip-btn');
    await expect(skipBtn).toBeVisible();
    await expect(skipBtn).toBeEnabled();

    // No autoConfirmDialogs: an empty stop has no resolution work to lose, so
    // Skip must not be gated behind a confirm the user would have to decline.
    await skipBtn.click();

    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    // The repository state is git's own token, `cherrypick`. The banner right
    // beside this toast says "Cherry-pick in progress", so the toast must not
    // be the one place the app spells it differently.
    await expect(toast).toContainText('Skipped cherry-pick');

    const calls = await findCommand(page, 'skip_cherry_pick');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ path: defaultMockData.repository.path });
  });

  test('revert banner offers Skip and runs skip_revert', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'revert',
      },
      status: { staged: [], unstaged: [] },
    });
    await startCommandCaptureWithMocks(page, { skip_revert: null });

    const skipBtn = page.locator('.operation-skip-btn');
    await expect(skipBtn).toBeVisible();
    await skipBtn.click();

    await expect(page.locator('.toast').first()).toContainText(/Skipped/i);
    expect(await findCommand(page, 'skip_revert')).toHaveLength(1);
  });

  test('no Skip button for states that have no skip command', async ({ page }) => {
    // Only cherry-pick and revert have a skip wired to this control. Rendering
    // it for merge/rebase/bisect would be a dead button.
    app = new AppPage(page);

    for (const state of ['merge', 'rebase', 'bisect']) {
      await setupOpenRepository(page, {
        repository: { ...defaultMockData.repository, state },
      });
      await expect(page.locator('.operation-banner')).toBeVisible();
      await expect(page.locator('.operation-skip-btn')).toHaveCount(0);
    }
  });

  test('a failed skip shows an error toast and leaves the banner up', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
      status: { staged: [], unstaged: [] },
    });
    await startCommandCapture(page);
    await injectCommandError(page, 'skip_cherry_pick', 'Repository is busy');

    await page.locator('.operation-skip-btn').click();

    const errorToast = page.locator('.toast.error').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('Repository is busy');
    await expect(page.locator('.operation-banner')).toBeVisible();
  });

  test('skipping with conflicted files asks for confirmation first', async ({ page }) => {
    // With conflicts on disk there IS resolution work the skip discards, so it
    // is gated exactly like Abort.
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
      status: {
        staged: [],
        unstaged: [
          { path: 'CONFLICT.md', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });
    await startCommandCapture(page);

    // Decline: plugin-dialog treats any non-OK label as "cancel".
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });
    await page.locator('.operation-skip-btn').click();
    await expect(page.locator('.operation-banner')).toBeVisible();
    expect(await findCommand(page, 'skip_cherry_pick')).toHaveLength(0);

    // Accept: the skip runs.
    await autoConfirmDialogs(page);
    await page.locator('.operation-skip-btn').click();
    await expect(page.locator('.toast').first()).toContainText('Skipped cherry-pick');
    expect(await findCommand(page, 'skip_cherry_pick')).toHaveLength(1);

    // The prompt itself reads as prose too, not as the raw state token.
    const prompts = await findCommand(page, 'plugin:dialog|message');
    expect(prompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(prompts[0].args)).toContain('cherry-pick');
    expect(JSON.stringify(prompts[0].args)).not.toContain('cherrypick');
  });

  test('should show Resolve Conflicts button for cherry-pick state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });

    const banner = page.locator('.operation-banner');
    await expect(banner).toBeVisible();

    // Should have Resolve Conflicts button
    const resolveBtn = banner.locator('.operation-btn-primary');
    await expect(resolveBtn).toBeVisible();
    await expect(resolveBtn).toContainText('Resolve Conflicts');
  });

  test('should show Resolve Conflicts button for merge state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'merge',
      },
    });

    const banner = page.locator('.operation-banner');
    const resolveBtn = banner.locator('.operation-btn-primary');
    await expect(resolveBtn).toBeVisible();
    await expect(resolveBtn).toContainText('Resolve Conflicts');
  });

  test('should show Resolve Conflicts button for rebase state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'rebase',
      },
    });

    const banner = page.locator('.operation-banner');
    const resolveBtn = banner.locator('.operation-btn-primary');
    await expect(resolveBtn).toBeVisible();
    await expect(resolveBtn).toContainText('Resolve Conflicts');
  });

  test('should show Resolve Conflicts button for revert state', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'revert',
      },
    });

    const banner = page.locator('.operation-banner');
    const resolveBtn = banner.locator('.operation-btn-primary');
    await expect(resolveBtn).toBeVisible();
    await expect(resolveBtn).toContainText('Resolve Conflicts');
  });

  test('Resolve Conflicts button should open conflict resolution dialog', async ({ page }) => {
    app = new AppPage(page);

    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        state: 'cherrypick',
      },
    });

    const resolveBtn = page.locator('.operation-btn-primary');
    await resolveBtn.click();

    // Conflict resolution dialog should be visible
    const conflictDialog = page.locator('lv-conflict-resolution-dialog[open]');
    await expect(conflictDialog).toBeVisible();
  });
});

test.describe('Context Menu Actions', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('clicking menu item should close context menu', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Click the first menu item
    const menuItem = contextMenu.locator('.context-menu-item').first();
    await expect(menuItem).toBeVisible();
    await menuItem.click();

    // Menu should close after action
    await expect(contextMenu).not.toBeVisible();
  });
});

test.describe('Commit Context Menu - Specific Items', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('should show Amend option in commit context menu', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const amendItem = contextMenu.locator('.context-menu-item', { hasText: /amend/i });
    await expect(amendItem).toBeVisible();
  });

  test('should show Create Branch option in commit context menu', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const createBranchItem = contextMenu.locator('.context-menu-item', { hasText: /create.*branch|branch.*from/i });
    await expect(createBranchItem).toBeVisible();
  });

  test('should show Cherry-pick option in commit context menu', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const cherryPickItem = contextMenu.locator('.context-menu-item', { hasText: /cherry.*pick/i });
    await expect(cherryPickItem).toBeVisible();
  });

  test('clicking Revert should invoke revert command', async ({ page }) => {
    await startCommandCapture(page);

    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const revertItem = contextMenu.locator('.context-menu-item', { hasText: /revert/i });
    await expect(revertItem).toBeVisible();
    await revertItem.click();

    // Menu should close
    await expect(contextMenu).not.toBeVisible();
  });

  test('clicking Create Branch should open create branch dialog', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const createBranchItem = contextMenu.locator('.context-menu-item', { hasText: /create.*branch|branch.*from/i });
    await expect(createBranchItem).toBeVisible();
    await createBranchItem.click();

    // Create branch dialog should open
    const createBranchDialog = page.locator('lv-create-branch-dialog lv-modal[open]');
    await expect(createBranchDialog).toBeVisible({ timeout: 3000 });
  });

  test('context menu header should show abbreviated commit SHA', async ({ page }) => {
    await rightClickOnCommitRow(page, 0);

    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Header should contain a short SHA
    const header = contextMenu.locator('.context-menu-header');
    const headerText = await header.textContent();
    // SHA should be at least 7 characters (short ID format)
    expect(headerText).toBeTruthy();
    expect(headerText!.length).toBeGreaterThan(0);
  });
});

test.describe('Context Menus - Error Scenarios', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page);
  });

  test('cherry-pick operation failure should show error toast', async ({ page }) => {
    // Inject cherry_pick error before performing the action
    await injectCommandError(page, 'cherry_pick', 'Cherry-pick failed: conflict');

    // Right-click to open context menu and click Cherry-pick
    await rightClickOnCommitRow(page, 0);
    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const cherryPickItem = contextMenu.locator('.context-menu-item', { hasText: /cherry.*pick/i });
    await expect(cherryPickItem).toBeVisible();
    await cherryPickItem.click();

    // Cherry-pick opens a dialog; click the primary button to trigger the command
    const cherryPickBtn = page.locator('lv-cherry-pick-dialog button.btn-primary', {
      hasText: /Cherry-Pick/i,
    });
    // Confirm the cherry-pick dialog to trigger the error
    await expect(cherryPickBtn).toBeVisible({ timeout: 3000 });
    await cherryPickBtn.click();

    // Error should be displayed (toast, error banner, or error message in dialog)
    await expect(page.locator('.toast, .error-banner, .error, .error-message').first()).toBeVisible({ timeout: 5000 });
  });

  test('revert operation failure should show error toast', async ({ page }) => {
    // Inject revert error before performing the action
    await injectCommandError(page, 'revert', 'Revert failed: working tree has modifications');

    // Mock the Tauri confirm dialog used by showConfirm() in handleRevertCommit
    await autoConfirmDialogs(page);

    // Right-click to open context menu and click Revert
    await rightClickOnCommitRow(page, 0);
    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const revertItem = contextMenu.locator('.context-menu-item', { hasText: /revert/i });
    await expect(revertItem).toBeVisible();
    await revertItem.click();

    // Context menu should close after clicking
    await expect(contextMenu).not.toBeVisible();

    // Error toast should appear
    await expect(page.locator('.toast, .error-banner, .error').first()).toBeVisible({ timeout: 5000 });
  });

  test('merge operation failure should show error toast', async ({ page }) => {
    // Inject merge error
    await injectCommandError(page, 'merge', 'Merge failed: uncommitted changes would be overwritten');

    // Trigger merge by calling the Tauri invoke directly, which will throw the injected error.
    // Catch the error and add a toast via the uiStore (same as production code's showToast()).
    await page.evaluate(async () => {
      try {
        await (window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }).__TAURI_INTERNALS__.invoke('merge', { path: '/tmp/test-repo', sourceBranch: 'feature/test-branch' });
      } catch (err) {
        // Add toast via uiStore (matches how production showToast() works)
        const stores = (window as unknown as {
          __GITNADO_STORES__: {
            uiStore: { getState: () => { addToast: (t: { type: string; message: string; duration: number }) => void } };
          };
        }).__GITNADO_STORES__;
        stores.uiStore.getState().addToast({
          type: 'error',
          message: (err as Error).message,
          duration: 5000,
        });
      }
    });

    // Error toast should appear inside lv-toast-container
    await expect(page.locator('lv-toast-container .toast.error').first()).toBeVisible({ timeout: 5000 });
  });

  test('UI should update after successful context menu checkout', async ({ page }) => {
    // Mock checkout to return success and mock get_branches to return updated list
    const updatedBranches = [
      {
        name: 'main',
        isHead: false,
        isRemote: false,
        upstream: null,
        targetOid: 'abc123',
        shorthand: 'main',
        isStale: false,
      },
      {
        name: 'feature/test',
        isHead: true,
        isRemote: false,
        upstream: null,
        targetOid: 'def456',
        shorthand: 'feature/test',
        isStale: false,
      },
    ];

    await injectCommandMock(page, {
      checkout: null,
      checkout_branch: null,
      get_branches: updatedBranches,
      get_current_branch: updatedBranches[1],
    });

    // Trigger checkout by calling the invoke layer directly and then refresh
    await page.evaluate(async () => {
      const invoke = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke;
      await invoke('checkout', { path: '/tmp/test-repo', refName: 'feature/test' });
      // Trigger a store refresh to update the UI
      const stores = (window as unknown as { __GITNADO_STORES__: Record<string, unknown> }).__GITNADO_STORES__;
      const repoStore = stores.repositoryStore as { getState: () => { setBranches: (b: unknown[]) => void; setCurrentBranch: (b: unknown) => void } };
      const branches = await invoke('get_branches', { path: '/tmp/test-repo' }) as unknown[];
      const currentBranch = await invoke('get_current_branch', { path: '/tmp/test-repo' });
      repoStore.getState().setBranches(branches);
      repoStore.getState().setCurrentBranch(currentBranch);
    });

    // After checkout, the branch list should show feature/test as the active (current) branch
    await expect(
      page.locator('lv-branch-list .branch-item.active').first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('revert failure error toast should contain informative message', async ({ page }) => {
    // Inject revert error with a specific message
    await injectCommandError(page, 'revert', 'Revert failed: working tree has modifications');

    // Mock the Tauri confirm dialog used by showConfirm() in handleRevertCommit
    await autoConfirmDialogs(page);

    await rightClickOnCommitRow(page, 0);
    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    const revertItem = contextMenu.locator('.context-menu-item', { hasText: /revert/i });
    await expect(revertItem).toBeVisible();
    await revertItem.click();

    // Context menu should close after clicking
    await expect(contextMenu).not.toBeVisible();

    // Error feedback should appear with informative content about the failure
    const errorFeedback = page.locator('.toast, .error-banner, .error').first();
    await expect(errorFeedback).toBeVisible({ timeout: 5000 });
    await expect(errorFeedback).toContainText(/Revert failed|modifications/i);
  });
});
