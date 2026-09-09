import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { GraphPanelPage, RightPanelPage } from '../pages/panels.page';
import { startCommandCapture, startCommandCaptureWithMocks, findCommand, waitForRepositoryChanged, injectCommandError, injectCommandMock, waitForCommand } from '../fixtures/test-helpers';

/**
 * Helper to get a Playwright ElementHandle for the lv-graph-canvas element.
 * Uses Playwright's auto-piercing locator instead of manual shadowRoot traversal.
 */
async function getGraphCanvasHandle(page: import('@playwright/test').Page) {
  const graphCanvas = page.locator('lv-graph-canvas');
  await expect(graphCanvas).toBeAttached();
  return await graphCanvas.elementHandle();
}

/**
 * Helper to read the graph canvas internal selectedNode OID via page.evaluate().
 * The graph renders on a <canvas>, so we read component state directly.
 */
async function getSelectedNodeOid(page: import('@playwright/test').Page): Promise<string | null> {
  const handle = await getGraphCanvasHandle(page);
  return page.evaluate(
    (el) => {
      const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
      return canvas?.selectedNode?.oid ?? null;
    },
    handle
  );
}

/**
 * Helper to read all selected OIDs from the graph canvas.
 */
async function getSelectedNodeOids(page: import('@playwright/test').Page): Promise<string[]> {
  const handle = await getGraphCanvasHandle(page);
  return page.evaluate(
    (el) => {
      const canvas = el as HTMLElement & { selectedNodes?: Set<string> };
      if (!canvas?.selectedNodes) return [];
      return Array.from(canvas.selectedNodes);
    },
    handle
  );
}

/**
 * Helper to read the total number of sorted nodes (commit rows) in the graph.
 */
async function getSortedNodeCount(page: import('@playwright/test').Page): Promise<number> {
  const handle = await getGraphCanvasHandle(page);
  return page.evaluate(
    (el) => {
      const canvas = el as HTMLElement & { sortedNodesByRow?: unknown[] };
      return canvas?.sortedNodesByRow?.length ?? 0;
    },
    handle
  );
}

/**
 * Helper to wait for the graph canvas to have a specific number of sorted nodes.
 */
async function waitForNodeCount(page: import('@playwright/test').Page, count: number): Promise<void> {
  const handle = await getGraphCanvasHandle(page);
  await page.waitForFunction(
    ([el, expected]) => {
      const canvas = el as HTMLElement & { sortedNodesByRow?: unknown[] };
      return (canvas?.sortedNodesByRow?.length ?? 0) === expected;
    },
    [handle, count] as const
  );
}

/**
 * Helper to wait for a specific commit to be selected in the graph canvas.
 */
async function waitForSelectedNode(page: import('@playwright/test').Page, oid: string): Promise<void> {
  const handle = await getGraphCanvasHandle(page);
  await page.waitForFunction(
    ([el, expectedOid]) => {
      const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
      return canvas?.selectedNode?.oid === expectedOid;
    },
    [handle, oid] as const
  );
}

/**
 * Helper to wait for any commit to be selected in the graph canvas.
 */
async function waitForAnySelectedNode(page: import('@playwright/test').Page): Promise<void> {
  const handle = await getGraphCanvasHandle(page);
  await page.waitForFunction(
    (el) => {
      const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
      return canvas?.selectedNode?.oid != null;
    },
    handle
  );
}

/**
 * Helper to wait for no commit to be selected in the graph canvas.
 */
async function waitForNoSelectedNode(page: import('@playwright/test').Page): Promise<void> {
  const handle = await getGraphCanvasHandle(page);
  await page.waitForFunction(
    (el) => {
      const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
      return canvas?.selectedNode == null;
    },
    handle
  );
}

/**
 * Helper to focus the internal <canvas> element inside lv-graph-canvas
 * so keyboard events reach the component's own handler.
 * Uses Playwright's auto-piercing locator instead of manual shadowRoot traversal.
 */
async function focusGraphInternalCanvas(page: import('@playwright/test').Page): Promise<void> {
  const internalCanvas = page.locator('lv-graph-canvas canvas[role="img"]');
  await expect(internalCanvas).toBeAttached();
  await internalCanvas.focus();
}

/**
 * Helper to create commit mock data with sequential timestamps.
 */
function makeCommit(index: number, parentIds: string[] = []) {
  const now = Date.now() / 1000;
  return {
    oid: `commit${index}`,
    shortId: `commit${index}`.slice(0, 7),
    message: `Commit ${index}`,
    summary: `Commit ${index}`,
    body: null,
    author: { name: 'Test User', email: 'test@example.com', timestamp: now - index * 3600 },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: now - index * 3600 },
    parentIds,
    timestamp: now - index * 3600,
  };
}

test.describe('Commit Graph', () => {
  let app: AppPage;
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should display graph canvas', async () => {
    await expect(graph.canvas).toBeVisible();
  });

  test('graph canvas should be the main content area', async () => {
    await app.waitForReady();
    await expect(graph.canvas).toBeVisible();
    const canvasElement = graph.canvas.locator('canvas[role="img"]');
    await expect(canvasElement).toBeAttached();
  });
});

test.describe('Graph with Multiple Commits', () => {
  let app: AppPage;
  let graph: GraphPanelPage;
  let rightPanel: RightPanelPage;

  // commit0 is the newest tip; commit2 is the root
  const commits = [
    makeCommit(0, ['commit1']),
    makeCommit(1, ['commit2']),
    makeCommit(2, []),
  ];

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    graph = new GraphPanelPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, { commits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 3);
  });

  test('should render all commits in the graph', async ({ page }) => {
    const nodeCount = await getSortedNodeCount(page);
    expect(nodeCount).toBe(3);
  });

  test('should have loaded commit history from backend', async ({ page }) => {
    await startCommandCapture(page);

    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { repositoryPath: string };
        if (canvas) {
          const path = canvas.repositoryPath;
          canvas.repositoryPath = '';
          canvas.repositoryPath = path;
        }
      },
      handle
    );
    await waitForCommand(page, 'get_commit_history');

    const commitHistoryCalls = await findCommand(page, 'get_commit_history');
    expect(commitHistoryCalls.length).toBeGreaterThan(0);
  });

  test('keyboard navigation down should select the first commit', async ({ page }) => {
    const initialOid = await getSelectedNodeOid(page);
    expect(initialOid).toBeNull();

    await graph.navigateDown();
    await waitForSelectedNode(page, 'commit0');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).not.toBeNull();
    expect(selectedOid).toBe('commit0');
  });

  test('keyboard navigation down then down should move selection forward', async ({ page }) => {
    await graph.navigateDown();
    await waitForSelectedNode(page, 'commit0');
    const firstOid = await getSelectedNodeOid(page);

    await graph.navigateDown();
    const handle = await getGraphCanvasHandle(page);
    await page.waitForFunction(
      ([el, prevOid]) => {
        const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
        const current = canvas?.selectedNode?.oid ?? null;
        return current != null && current !== prevOid;
      },
      [handle, firstOid] as const
    );
    const secondOid = await getSelectedNodeOid(page);

    expect(secondOid).not.toBeNull();
    expect(secondOid).not.toBe(firstOid);
  });

  test('keyboard navigation up should move selection backward', async ({ page }) => {
    await graph.navigateDown();
    await waitForAnySelectedNode(page);
    await graph.navigateDown();
    await waitForSelectedNode(page, 'commit1');
    const secondOid = await getSelectedNodeOid(page);

    await graph.navigateUp();
    const handle = await getGraphCanvasHandle(page);
    await page.waitForFunction(
      ([el, prevOid]) => {
        const canvas = el as HTMLElement & { selectedNode?: { oid: string } | null };
        const current = canvas?.selectedNode?.oid ?? null;
        return current != null && current !== prevOid;
      },
      [handle, secondOid] as const
    );
    const afterUpOid = await getSelectedNodeOid(page);

    expect(afterUpOid).not.toBeNull();
    expect(afterUpOid).not.toBe(secondOid);
  });

  test('Home should navigate to the first commit', async ({ page }) => {
    await graph.navigateDown();
    await graph.navigateDown();
    await waitForAnySelectedNode(page);

    await graph.navigateToFirst();
    await waitForSelectedNode(page, 'commit0');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit0');
  });

  test('End should navigate to the last commit', async ({ page }) => {
    await graph.navigateToLast();
    await waitForSelectedNode(page, 'commit2');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit2');
  });

  test('selecting a commit should dispatch commit-selected event and update right panel', async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __COMMIT_SELECTED_EVENTS__: unknown[] }).__COMMIT_SELECTED_EVENTS__ = [];
      document.addEventListener('commit-selected', (e: Event) => {
        const detail = (e as CustomEvent).detail;
        (window as unknown as { __COMMIT_SELECTED_EVENTS__: unknown[] }).__COMMIT_SELECTED_EVENTS__.push(detail);
      });
    });

    await graph.navigateDown();
    await page.waitForFunction(() => {
      const events = (window as unknown as { __COMMIT_SELECTED_EVENTS__?: unknown[] }).__COMMIT_SELECTED_EVENTS__ || [];
      return events.length > 0;
    });

    const events = await page.evaluate(() => {
      return (window as unknown as { __COMMIT_SELECTED_EVENTS__: Array<{ commit: { oid: string; summary: string } | null }> }).__COMMIT_SELECTED_EVENTS__;
    });

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.commit).not.toBeNull();
    expect(lastEvent.commit!.oid).toBe('commit0');

    const detailsTab = rightPanel.detailsTab;
    await expect(detailsTab).toBeVisible();

    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails).toBeVisible();
    const commitMessage = commitDetails.locator('.commit-message');
    await expect(commitMessage).toContainText('Commit 0');
  });

  test('selecting different commits should update the commit details panel', async ({ page }) => {
    await graph.navigateDown();
    await waitForSelectedNode(page, 'commit0');

    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails).toBeVisible();
    const commitMessage = commitDetails.locator('.commit-message');
    await expect(commitMessage).toContainText('Commit 0');

    await graph.navigateDown();
    await waitForSelectedNode(page, 'commit1');

    await expect(commitMessage).toContainText('Commit 1');
  });
});

test.describe('Graph Commit Selection', () => {
  let app: AppPage;
  let graph: GraphPanelPage;
  let rightPanel: RightPanelPage;

  const commits = [
    makeCommit(0, []),
    makeCommit(1, ['commit0']),
    makeCommit(2, ['commit1']),
  ];

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    graph = new GraphPanelPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, { commits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 3);
  });

  test('selecting a commit via selectCommit API should update selection state', async ({ page }) => {
    const handle = await getGraphCanvasHandle(page);
    const result = await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        return canvas?.selectCommit('commit1') ?? false;
      },
      handle
    );

    expect(result).toBe(true);
    await waitForSelectedNode(page, 'commit1');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit1');
  });

  test('selected commit details should appear in the right panel', async ({ page }) => {
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        canvas?.selectCommit('commit1');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit1');

    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails).toBeVisible();

    const commitOid = commitDetails.locator('.commit-oid');
    await expect(commitOid).toContainText('commit1'.slice(0, 7));

    const commitMessage = commitDetails.locator('.commit-message');
    await expect(commitMessage).toContainText('Commit 1');
  });

  test('a refresh that rewrites away the selected commit empties the commit details panel', async ({ page }) => {
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        canvas?.selectCommit('commit1');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit1');

    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails.locator('.commit-message')).toContainText('Commit 1');

    // The history is rewritten (amend/rebase/squash): commit1 and commit2 are
    // gone, replaced by commit3 on top of commit0
    await injectCommandMock(page, {
      get_commit_history: [makeCommit(3, ['commit0']), makeCommit(0, [])],
      get_refs_by_commit: {
        commit3: [
          { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
        ],
      },
      get_commit_total: 2,
    });
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { refresh: () => void };
        canvas?.refresh();
      },
      handle
    );
    await waitForNodeCount(page, 2);

    // The panel must not keep showing a commit that no longer exists
    await expect(commitDetails.locator('.empty-state')).toBeVisible();
    await expect(commitDetails.locator('.empty-state')).toContainText('Select a commit to view details');
    await expect(commitDetails.locator('.commit-message')).toHaveCount(0);
    expect(await getSelectedNodeOid(page)).toBeNull();
  });

  test('a refresh that rewrites away the primary of a multi-selection shows a surviving commit', async ({ page }) => {
    const handle = await getGraphCanvasHandle(page);
    // commit2 is the primary of a two-commit selection (the canvas hit-test
    // cannot be driven by a real ctrl+click in Playwright)
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & {
          selectCommit: (oid: string) => boolean;
          selectedNodes?: Set<string>;
        };
        canvas?.selectCommit('commit2');
        canvas?.selectedNodes?.add('commit1');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit2');

    // The tip is amended away; commit1 stays in the rewritten history
    await injectCommandMock(page, {
      get_commit_history: [makeCommit(3, ['commit1']), makeCommit(1, ['commit0']), makeCommit(0, [])],
      get_refs_by_commit: {
        commit3: [
          { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
        ],
      },
      get_commit_total: 3,
    });
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { refresh: () => void };
        canvas?.refresh();
      },
      handle
    );
    await waitForSelectedNode(page, 'commit1');

    // The panel follows the survivor instead of going blank while the graph
    // still highlights it
    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails.locator('.commit-message')).toContainText('Commit 1');
    await expect(commitDetails.locator('.empty-state')).toHaveCount(0);
    expect(await getSelectedNodeOids(page)).toEqual(['commit1']);
  });

  test('a refresh that keeps the selected commit keeps the commit details panel', async ({ page }) => {
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        canvas?.selectCommit('commit1');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit1');

    // An ordinary refresh (pull, fetch, watcher refs-changed): a new commit
    // lands on top and every existing commit survives
    await injectCommandMock(page, {
      get_commit_history: [
        makeCommit(3, ['commit2']),
        makeCommit(2, ['commit1']),
        makeCommit(1, ['commit0']),
        makeCommit(0, []),
      ],
      get_refs_by_commit: {
        commit3: [
          { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
        ],
      },
      get_commit_total: 4,
    });
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { refresh: () => void };
        canvas?.refresh();
      },
      handle
    );
    await waitForNodeCount(page, 4);

    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails.locator('.commit-message')).toContainText('Commit 1');
    expect(await getSelectedNodeOid(page)).toBe('commit1');
  });

  test('Escape should deselect the current commit', async ({ page }) => {
    await graph.navigateDown();
    await waitForAnySelectedNode(page);
    const selectedBefore = await getSelectedNodeOid(page);
    expect(selectedBefore).not.toBeNull();

    // Focus the internal <canvas> element inside lv-graph-canvas
    // so the Escape keydown event reaches the component's own handler
    await focusGraphInternalCanvas(page);
    await page.keyboard.press('Escape');
    await waitForNoSelectedNode(page);

    const selectedAfter = await getSelectedNodeOid(page);
    expect(selectedAfter).toBeNull();

    const selectedOids = await getSelectedNodeOids(page);
    expect(selectedOids).toHaveLength(0);
  });
});

test.describe('Diff Overlay', () => {
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page);
    await expect(graph.canvas).toBeVisible();
  });

  test('diff overlay should not be visible by default', async () => {
    await expect(graph.diffOverlay).not.toBeVisible();
  });

  test('isDiffVisible should return false when no diff is shown', async () => {
    const isVisible = await graph.isDiffVisible();
    expect(isVisible).toBe(false);
  });
});

test.describe('Blame Overlay', () => {
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page);
    await expect(graph.canvas).toBeVisible();
  });

  test('blame overlay should not be visible by default', async () => {
    await expect(graph.blameOverlay).not.toBeVisible();
  });

  test('isBlameVisible should return false when no blame is shown', async () => {
    const isVisible = await graph.isBlameVisible();
    expect(isVisible).toBe(false);
  });
});

test.describe('Graph Scrolling', () => {
  let graph: GraphPanelPage;

  // Create 50 commits in a linear chain; commit0 is the newest tip and
  // commit49 the root, matching the descending fixture timestamps
  const commits = Array.from({ length: 50 }, (_, i) =>
    makeCommit(i, i < 49 ? [`commit${i + 1}`] : [])
  );

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page, { commits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 50);
  });

  test('should render all 50 commits in the graph layout', async ({ page }) => {
    const nodeCount = await getSortedNodeCount(page);
    expect(nodeCount).toBe(50);
  });

  test('should handle large commit history without errors', async () => {
    await expect(graph.canvas).toBeVisible();
    const errorPanel = graph.canvas.locator('.info-panel');
    await expect(errorPanel).not.toBeVisible();
  });

  test('should navigate through many commits with arrow keys', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await graph.navigateDown();
    }
    await waitForSelectedNode(page, 'commit9');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).not.toBeNull();
    expect(selectedOid).toBe('commit9');
  });

  test('End should navigate to the last of 50 commits', async ({ page }) => {
    await graph.navigateToLast();
    await waitForSelectedNode(page, 'commit49');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit49');
  });

  test('Home after End should return to the first commit', async ({ page }) => {
    await graph.navigateToLast();
    await waitForSelectedNode(page, 'commit49');

    await graph.navigateToFirst();
    await waitForSelectedNode(page, 'commit0');

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit0');
  });
});

test.describe('Empty Repository Graph', () => {
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page, {
      commits: [],
      branches: [],
    });
  });

  test('should render the canvas area even with no commits', async () => {
    await expect(graph.canvas).toBeVisible();
  });

  test('should have zero sorted nodes when there are no commits', async ({ page }) => {
    await waitForNodeCount(page, 0);
    const nodeCount = await getSortedNodeCount(page);
    expect(nodeCount).toBe(0);
  });

  test('keyboard navigation should not crash on empty graph', async ({ page }) => {
    await graph.canvas.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('End');

    await expect(graph.canvas).toBeVisible();

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBeNull();
  });

  test('Escape should not crash on empty graph', async ({ page }) => {
    // In an empty graph, pressing Escape should not crash
    await focusGraphInternalCanvas(page);
    await page.keyboard.press('Escape');

    // The canvas should still be visible and functional
    await expect(graph.canvas).toBeVisible();

    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBeNull();
  });
});

test.describe('Graph - UI Outcome Verification', () => {
  let graph: GraphPanelPage;
  let rightPanel: RightPanelPage;

  // commit0 is the newest tip; commit2 is the root
  const commits = [
    makeCommit(0, ['commit1']),
    makeCommit(1, ['commit2']),
    makeCommit(2, []),
  ];

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, { commits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 3);
  });

  test('clicking a commit via selectCommit API updates the details panel with that commit info', async ({ page }) => {
    // Use the component's public selectCommit API to simulate a mouse click selection
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        canvas?.selectCommit('commit2');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit2');

    // Verify the details panel shows the selected commit's information
    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails).toBeVisible();
    await expect(commitDetails.locator('.commit-message')).toContainText('Commit 2');
    await expect(commitDetails.locator('.commit-oid')).toContainText('commit2'.slice(0, 7));
  });

  test('deselecting a commit clears the details panel or shows empty state', async ({ page }) => {
    // Select a commit first
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean };
        canvas?.selectCommit('commit1');
      },
      handle
    );
    await waitForSelectedNode(page, 'commit1');

    // Verify the commit details panel is showing
    const commitDetails = page.locator('lv-commit-details');
    await expect(commitDetails).toBeVisible();
    await expect(commitDetails.locator('.commit-message')).toContainText('Commit 1');

    // Deselect by pressing Escape on the internal canvas
    await focusGraphInternalCanvas(page);
    await page.keyboard.press('Escape');
    await waitForNoSelectedNode(page);

    // After deselection the details panel should either be hidden
    // or no longer display the previous commit's info
    const detailsStillVisible = await commitDetails.count() > 0 && await commitDetails.isVisible();
    if (detailsStillVisible) {
      // The commit-specific content should be cleared
      const oidEl = commitDetails.locator('.commit-oid');
      const oidText = await oidEl.count() > 0 ? await oidEl.textContent() : '';
      const hasCommit1Oid = oidText?.includes('commit1'.slice(0, 7)) ?? false;
      expect(hasCommit1Oid).toBe(false);
    }

    // Confirm no commit is selected
    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBeNull();
  });

  test('mouse-based selection via selectCommit marks the commit as selected in graph state', async ({ page }) => {
    // Initially no commit should be selected
    const initialOid = await getSelectedNodeOid(page);
    expect(initialOid).toBeNull();

    // Simulate mouse click by calling selectCommit (canvas-based graph cannot be directly clicked by Playwright)
    const handle = await getGraphCanvasHandle(page);
    const result = await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { selectCommit: (oid: string) => boolean; selectedNode?: { oid: string } | null };
        const success = canvas?.selectCommit('commit0') ?? false;
        return { success, selectedOid: canvas?.selectedNode?.oid ?? null };
      },
      handle
    );

    expect(result.success).toBe(true);
    expect(result.selectedOid).toBe('commit0');

    // Wait for the selection state to propagate
    await waitForSelectedNode(page, 'commit0');

    // Verify via the helper that the selection is tracked in the component state
    const selectedOid = await getSelectedNodeOid(page);
    expect(selectedOid).toBe('commit0');

    // Also verify the selectedNodes set includes this commit
    const selectedOids = await getSelectedNodeOids(page);
    expect(selectedOids).toContain('commit0');
  });
});

test.describe('Graph Error Handling', () => {
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page);
    await expect(graph.canvas).toBeVisible();
  });

  test('should handle get_commit_history failure gracefully', async ({ page }) => {
    // Inject an error so the next call to get_commit_history will fail
    await injectCommandError(page, 'get_commit_history', 'Failed to read commit history: corrupt object');

    // Switch the graph to a NEVER-loaded repo so the failing load runs in
    // the foreground. (Re-setting the same path would serve the per-repo
    // graph cache and retry in the background, which deliberately does not
    // surface an error state over the still-valid cached graph.)
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { repositoryPath: string };
        canvas.repositoryPath = '/tmp/never-loaded-repo';
      },
      handle
    );

    await expect(graph.canvas).toBeVisible();

    // The graph should show an empty/error state - either zero nodes or an info panel
    const nodeCount = await getSortedNodeCount(page);

    // Either the graph shows zero nodes (graceful empty state),
    // an info panel with error information, or a toast notification
    const hasEmptyState = nodeCount === 0;

    if (!hasEmptyState) {
      await expect(
        page.locator('.info-panel, .toast.error, .toast, .error, .error-banner').first()
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test('keeps showing the cached graph when a background refetch fails', async ({ page }) => {
    // The repo is already loaded (and cached) from beforeEach
    const handle = await getGraphCanvasHandle(page);
    const nodesBefore = await getSortedNodeCount(page);
    expect(nodesBefore).toBeGreaterThan(0);

    await startCommandCapture(page);
    await injectCommandError(page, 'get_commit_history', 'repository temporarily unavailable');

    // Re-setting the same path serves the cache and revalidates in the
    // background; the failing revalidation must not blank the graph or
    // paint an error banner over it
    await page.evaluate(
      (el) => {
        const canvas = el as HTMLElement & { repositoryPath: string };
        const path = canvas.repositoryPath;
        canvas.repositoryPath = '';
        canvas.repositoryPath = path;
      },
      handle
    );

    // Wait until the (failing) background reload actually ran
    await waitForCommand(page, 'get_commit_history');

    await expect(graph.canvas).toBeVisible();
    expect(await getSortedNodeCount(page)).toBe(nodesBefore);
    // The graph's real error surface is the info panel with "Error" text
    await expect(
      page.locator('lv-graph-canvas .info-panel', { hasText: 'Error' })
    ).toHaveCount(0);
  });
});

test.describe('Branch Visibility Filtering', () => {
  let graph: GraphPanelPage;

  // Fork topology: commit1 (main, HEAD) and commit2 (feature) both branch
  // off commit0, so hiding "feature" must remove exactly commit2.
  const forkCommits = [
    makeCommit(1, ['commit0']),
    makeCommit(2, ['commit0']),
    makeCommit(0, []),
  ];

  const forkRefs = {
    commit1: [
      { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
    ],
    commit2: [
      { name: 'refs/heads/feature', shorthand: 'feature', refType: 'localBranch', isHead: false },
    ],
  };

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page, { commits: forkCommits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 3);

    // Provide branch refs and reload so the graph picks them up
    await injectCommandMock(page, { get_refs_by_commit: forkRefs });
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate((el) => {
      (el as HTMLElement & { refresh(): void }).refresh();
    }, handle);
    // Refs are loaded when the branch panel can list them
    await page.locator('lv-graph-canvas .toolbar-btn', { hasText: 'Branches' }).click();
    await expect(
      page.locator('lv-graph-canvas .branch-item', { hasText: 'feature' })
    ).toBeVisible();
  });

  test('hiding a branch removes its exclusive commits from the graph', async ({ page }) => {
    const featureCheckbox = page
      .locator('lv-graph-canvas .branch-item', { hasText: 'feature' })
      .locator('input[type="checkbox"]');
    await featureCheckbox.uncheck();

    // commit2 is only reachable from "feature", so the graph drops to 2 nodes
    await waitForNodeCount(page, 2);
    const handle = await getGraphCanvasHandle(page);
    const oids = await page.evaluate((el) => {
      const canvas = el as HTMLElement & { sortedNodesByRow?: Array<{ oid: string }> };
      return (canvas?.sortedNodesByRow ?? []).map((n) => n.oid);
    }, handle);
    expect(oids).not.toContain('commit2');
    expect(oids).toContain('commit1');
    expect(oids).toContain('commit0');
  });

  test('re-showing a hidden branch restores its commits', async ({ page }) => {
    const featureCheckbox = page
      .locator('lv-graph-canvas .branch-item', { hasText: 'feature' })
      .locator('input[type="checkbox"]');

    await featureCheckbox.uncheck();
    await waitForNodeCount(page, 2);

    await featureCheckbox.check();
    await waitForNodeCount(page, 3);
  });

  test('hiding the HEAD branch keeps HEAD history visible', async ({ page }) => {
    const mainCheckbox = page
      .locator('lv-graph-canvas .branch-item', { hasText: 'main' })
      .locator('input[type="checkbox"]');
    await mainCheckbox.uncheck();

    // main is HEAD — its commits must not disappear
    const handle = await getGraphCanvasHandle(page);
    const oids = await page.evaluate((el) => {
      const canvas = el as HTMLElement & { sortedNodesByRow?: Array<{ oid: string }> };
      return (canvas?.sortedNodesByRow ?? []).map((n) => n.oid);
    }, handle);
    expect(oids).toContain('commit1');
    expect(oids).toContain('commit0');
  });
});

/**
 * A refresh (commit, pull, merge, or the file watcher's refs-changed) reloads
 * the graph from page 1 while the scrollbar still spans the whole history.
 * A viewport that had been paginated deep must not be left staring at rows
 * that are no longer loaded.
 */
test.describe('Graph refresh while scrolled deep', () => {
  const TOTAL = 500;
  const PAGE_SIZE = 100;

  /**
   * Serve `get_commit_history` in real pages (injectCommandMock can only
   * return a static value, and this needs to honour skip/limit).
   */
  async function installPaginatedHistoryMock(
    page: import('@playwright/test').Page,
    opts: { total: number; pageSize: number }
  ): Promise<void> {
    await page.evaluate(({ total, pageSize }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;

      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'get_commit_history') {
          const a = args as { skip?: number; limit?: number } | undefined;
          const skip = a?.skip ?? 0;
          const limit = a?.limit ?? pageSize;
          const count = Math.max(0, Math.min(limit, total - skip));
          const now = Date.now() / 1000;
          const commits = [];
          for (let i = skip; i < skip + count; i++) {
            commits.push({
              oid: `commit${i}`,
              shortId: `commit${i}`.slice(0, 7),
              message: `Commit ${i}`,
              summary: `Commit ${i}`,
              body: null,
              author: { name: 'Test User', email: 'test@example.com', timestamp: now - i * 3600 },
              committer: { name: 'Test User', email: 'test@example.com', timestamp: now - i * 3600 },
              parentIds: i + 1 < total ? [`commit${i + 1}`] : [],
              timestamp: now - i * 3600,
            });
          }
          return commits;
        }
        if (command === 'get_commit_total') {
          return total;
        }
        return originalInvoke(command, args);
      };
    }, opts);
  }

  /** Commits the renderer would actually paint for the current viewport */
  async function paintedNodeCount(page: import('@playwright/test').Page): Promise<number> {
    const handle = await getGraphCanvasHandle(page);
    return page.evaluate((el) => {
      const canvas = el as HTMLElement & {
        virtualScroll?: { getRenderData(v: unknown): { nodes: unknown[] } };
        getViewport?: () => unknown;
      };
      if (!canvas.virtualScroll || !canvas.getViewport) return 0;
      return canvas.virtualScroll.getRenderData(canvas.getViewport()).nodes.length;
    }, handle);
  }

  test('repaints the graph after a refresh while scrolled deep into the history', async ({ page }) => {
    const graph = new GraphPanelPage(page);
    await setupOpenRepository(page);
    await expect(graph.canvas).toBeVisible();

    await installPaginatedHistoryMock(page, { total: TOTAL, pageSize: PAGE_SIZE });

    // Reload against the paginated history: page 1 only
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate(
      ([el, pageSize]) => {
        const canvas = el as HTMLElement & { commitCount: number; refresh(): void };
        canvas.commitCount = pageSize as number;
        canvas.refresh();
      },
      [handle, PAGE_SIZE] as const
    );
    await waitForNodeCount(page, PAGE_SIZE);

    // Scroll deep into the unloaded region; the catch-up chain fills it in
    await page.evaluate(
      ([el, row]) => {
        const canvas = el as HTMLElement & {
          scrollState: { setScroll(top: number, left: number): void };
          PADDING: number;
          ROW_HEIGHT: number;
        };
        canvas.scrollState.setScroll(canvas.PADDING + (row as number) * canvas.ROW_HEIGHT, 0);
      },
      [handle, 300] as const
    );
    await waitForNodeCount(page, TOTAL);
    expect(await paintedNodeCount(page)).toBeGreaterThan(0);

    // A commit/pull/watcher refresh — exactly what app-shell's handleRefresh does
    await startCommandCapture(page);
    await page.evaluate((el) => {
      (el as HTMLElement & { refresh(): void }).refresh();
    }, handle);

    // The viewport must show commits again, not a blank canvas
    await page.waitForFunction((el) => {
      const canvas = el as HTMLElement & {
        virtualScroll?: { getRenderData(v: unknown): { nodes: unknown[] } };
        getViewport?: () => unknown;
      };
      if (!canvas.virtualScroll || !canvas.getViewport) return false;
      return canvas.virtualScroll.getRenderData(canvas.getViewport()).nodes.length > 0;
    }, handle);

    // ...because the catch-up chain restarted, not because nothing reloaded
    const historyCalls = await findCommand(page, 'get_commit_history');
    const catchUpCalls = historyCalls.filter(
      (c) => ((c.args as { skip?: number } | undefined)?.skip ?? 0) > 0
    );
    expect(catchUpCalls.length).toBeGreaterThan(0);
    await expect(page.locator('lv-graph-canvas .info-panel')).toHaveCount(0);
  });
});

test.describe('Graph Empty Repository', () => {
  let graph: GraphPanelPage;

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    // A freshly initialised repository: the walk returns no commits
    await setupOpenRepository(page, { commits: [] });
    await expect(graph.canvas).toBeVisible();
  });

  test('shows the empty state instead of a blank canvas', async ({ page }) => {
    const emptyState = page.locator('lv-graph-canvas .graph-overlay.empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('No commits yet');
    await expect(emptyState).toContainText('Commit panel');
  });

  test('announces "No commits" rather than a permanent loading label', async ({ page }) => {
    const canvasElement = page.locator('lv-graph-canvas canvas[role="img"]');
    await expect(canvasElement).toHaveAttribute('aria-label', 'No commits');
  });

  test('does not show the error panel for an empty repository', async ({ page }) => {
    await expect(page.locator('lv-graph-canvas .graph-overlay.empty-state')).toBeVisible();
    await expect(page.locator('lv-graph-canvas .info-panel.error-panel')).toHaveCount(0);
  });

  test('replaces the empty state once a commit exists', async ({ page }) => {
    await expect(page.locator('lv-graph-canvas .graph-overlay.empty-state')).toBeVisible();

    await injectCommandMock(page, { get_commit_history: [makeCommit(0)] });
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate((el) => {
      (el as HTMLElement & { refresh(): void }).refresh();
    }, handle);

    await waitForNodeCount(page, 1);
    await expect(page.locator('lv-graph-canvas .graph-overlay.empty-state')).toHaveCount(0);
  });
});

test.describe('Graph Load Error Retry', () => {
  let graph: GraphPanelPage;

  const commits = [makeCommit(0, ['commit1']), makeCommit(1, [])];

  /** Make the next commit walk fail and force a reload */
  async function failNextLoad(page: import('@playwright/test').Page, message: string) {
    await injectCommandError(page, 'get_commit_history', message);
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate((el) => {
      (el as HTMLElement & { refresh(): void }).refresh();
    }, handle);
  }

  test.beforeEach(async ({ page }) => {
    graph = new GraphPanelPage(page);
    await setupOpenRepository(page, { commits });
    await expect(graph.canvas).toBeVisible();
    await waitForNodeCount(page, 2);
  });

  test('shows a Retry button when the commit walk fails', async ({ page }) => {
    await failNextLoad(page, 'unable to read the object database');

    const errorPanel = page.locator('lv-graph-canvas .info-panel.error-panel');
    await expect(errorPanel).toBeVisible();
    await expect(errorPanel).toContainText('unable to read the object database');
    await expect(errorPanel.locator('.retry-btn')).toBeVisible();
    await expect(errorPanel.locator('.retry-btn')).toBeEnabled();

    // The previously loaded commits are still painted, so the canvas keeps
    // announcing them — the failure is announced by the panel's role="alert"
    const canvasElement = page.locator('lv-graph-canvas canvas[role="img"]');
    await expect(canvasElement).toHaveAttribute('aria-label', /showing 2/);
  });

  test('Retry reloads the graph and clears the error on success', async ({ page }) => {
    await failNextLoad(page, 'unable to read the object database');
    const errorPanel = page.locator('lv-graph-canvas .info-panel.error-panel');
    await expect(errorPanel).toBeVisible();

    // The repository becomes readable again
    await startCommandCaptureWithMocks(page, { get_commit_history: commits });

    await errorPanel.locator('.retry-btn').click();

    await expect(errorPanel).toHaveCount(0);
    await waitForNodeCount(page, 2);
    const retryCalls = await findCommand(page, 'get_commit_history');
    expect(retryCalls.length).toBeGreaterThan(0);
  });

  test('Retry keeps the error panel when the reload fails again', async ({ page }) => {
    await failNextLoad(page, 'unable to read the object database');
    const errorPanel = page.locator('lv-graph-canvas .info-panel.error-panel');
    await expect(errorPanel).toBeVisible();

    await injectCommandError(page, 'get_commit_history', 'still unreadable');
    await errorPanel.locator('.retry-btn').click();

    await expect(errorPanel).toContainText('still unreadable');
    await expect(errorPanel.locator('.retry-btn')).toBeEnabled();
  });

  test('Retry on a repository that is now empty shows the empty state', async ({ page }) => {
    await failNextLoad(page, 'unable to read the object database');
    const errorPanel = page.locator('lv-graph-canvas .info-panel.error-panel');
    await expect(errorPanel).toBeVisible();

    await injectCommandMock(page, { get_commit_history: [] });
    await errorPanel.locator('.retry-btn').click();

    await expect(errorPanel).toHaveCount(0);
    await expect(page.locator('lv-graph-canvas .graph-overlay.empty-state')).toBeVisible();
  });
});

/**
 * Ctrl+clicking several commits and acting on the whole set.
 *
 * The canvas has always built a multi-selection; nothing consumed it, so the
 * commit context menu could only ever act on one commit. These drive real
 * Ctrl+clicks on the canvas (the row-based hit test makes the coordinates
 * computable) and assert the batch actions the menu grows.
 */
test.describe('Graph multi-selection actions', () => {
  const HISTORY = [makeCommit(0, ['commit1']), makeCommit(1, ['commit2']), makeCommit(2, [])];

  /** Screen coordinates of a graph row, derived the way hitTest reads them. */
  async function rowPoint(
    page: import('@playwright/test').Page,
    row: number
  ): Promise<{ x: number; y: number }> {
    const box = await page.locator('lv-graph-canvas canvas[role="img"]').boundingBox();
    if (!box) throw new Error('the graph canvas has no box');
    const handle = await getGraphCanvasHandle(page);
    const metrics = await page.evaluate((el) => {
      const canvas = el as HTMLElement & {
        HEADER_HEIGHT: number;
        PADDING: number;
        ROW_HEIGHT: number;
        getViewport: () => { scrollTop: number };
      };
      return {
        header: canvas.HEADER_HEIGHT,
        padding: canvas.PADDING,
        rowHeight: canvas.ROW_HEIGHT,
        scrollTop: canvas.getViewport().scrollTop,
      };
    }, handle);
    return {
      x: box.x + 12,
      y:
        box.y +
        metrics.header +
        metrics.padding +
        row * metrics.rowHeight -
        metrics.scrollTop,
    };
  }

  async function clickRow(
    page: import('@playwright/test').Page,
    row: number,
    options: { ctrl?: boolean; button?: 'right' } = {}
  ): Promise<void> {
    const point = await rowPoint(page, row);
    // page.mouse.click takes no modifiers — hold Control around the click the
    // way a user does.
    if (options.ctrl) await page.keyboard.down('Control');
    try {
      await page.mouse.click(point.x, point.y, options.button ? { button: options.button } : {});
    } finally {
      if (options.ctrl) await page.keyboard.up('Control');
    }
  }

  /** Load a three-commit history (commit0 newest, commit2 the root). */
  async function loadHistory(
    page: import('@playwright/test').Page,
    extraMocks: Record<string, unknown> = {}
  ): Promise<void> {
    await startCommandCaptureWithMocks(page, {
      get_commit_history: HISTORY,
      get_commit_total: 3,
      get_refs_by_commit: {},
      cherry_pick: HISTORY[0],
      'plugin:dialog|message': 'Ok',
      ...extraMocks,
    });
    const handle = await getGraphCanvasHandle(page);
    await page.evaluate((el) => {
      (el as HTMLElement & { refresh(): void }).refresh();
    }, handle);
    await waitForNodeCount(page, 3);
  }

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await expect(page.locator('lv-graph-canvas')).toBeVisible();
  });

  test('ctrl-clicking builds a selection the context menu can act on', async ({ page }) => {
    await loadHistory(page);

    await clickRow(page, 2);
    await waitForSelectedNode(page, 'commit2');
    await clickRow(page, 1, { ctrl: true });
    await clickRow(page, 0, { ctrl: true });

    expect((await getSelectedNodeOids(page)).sort()).toEqual(['commit0', 'commit1', 'commit2']);
    // The set is announced, not just painted
    await expect(page.locator('lv-graph-canvas [role="status"]')).toContainText(
      '3 commits selected'
    );

    // Right-clicking inside the selection keeps it and opens the batch menu
    await clickRow(page, 1, { button: 'right' });
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.locator('[data-testid="multi-commit-count"]')).toHaveText(
      '3 commits selected'
    );
    await expect(page.locator('[data-testid="multi-cherry-pick"]')).toHaveText(
      /Cherry-pick 3 commits/
    );
    await expect(page.locator('[data-testid="multi-create-patch"]')).toHaveText(
      /Create patch from 3 commits/
    );
    // Compare takes two refs, so three commits do not offer it
    await expect(page.locator('[data-testid="multi-compare"]')).toHaveCount(0);
  });

  test('cherry-picking the selection applies every commit oldest first', async ({ page }) => {
    await loadHistory(page);

    await clickRow(page, 0);
    await waitForSelectedNode(page, 'commit0');
    await clickRow(page, 1, { ctrl: true });
    await clickRow(page, 2, { ctrl: true });
    await clickRow(page, 0, { button: 'right' });

    await page.locator('[data-testid="multi-cherry-pick"]').click();

    await waitForCommand(page, 'cherry_pick');
    await expect
      .poll(async () => (await findCommand(page, 'cherry_pick')).length)
      .toBe(3);
    const picks = await findCommand(page, 'cherry_pick');
    // Clicked newest first; applied ancestor first regardless
    expect(picks.map((c) => (c.args as { commitOid: string }).commitOid)).toEqual([
      'commit2',
      'commit1',
      'commit0',
    ]);
    await expect(page.locator('.toast.success').first()).toContainText(
      'Cherry-picked 3 commits'
    );
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  test('a failed pick stops the sequence and reports what is left', async ({ page }) => {
    await loadHistory(page, {
      cherry_pick: { __error__: 'could not apply patch' },
    });

    await clickRow(page, 2);
    await waitForSelectedNode(page, 'commit2');
    await clickRow(page, 1, { ctrl: true });
    await clickRow(page, 0, { ctrl: true });
    await clickRow(page, 1, { button: 'right' });

    await page.locator('[data-testid="multi-cherry-pick"]').click();

    await waitForCommand(page, 'cherry_pick');
    const toast = page.locator('.toast.error').first();
    await expect(toast).toContainText('stopped on the first of 3 commits');
    await expect(toast).toContainText('could not apply patch');
    await expect(toast).toContainText('Still to apply after it: commit1, commit0');
    // It stopped: the remaining commits were never sent
    expect(await findCommand(page, 'cherry_pick')).toHaveLength(1);
  });

  test('two selected commits can be compared against each other', async ({ page }) => {
    await loadHistory(page);

    await clickRow(page, 0);
    await waitForSelectedNode(page, 'commit0');
    await clickRow(page, 2, { ctrl: true });
    await clickRow(page, 0, { button: 'right' });

    await expect(page.locator('[data-testid="multi-compare"]')).toBeVisible();
    await page.locator('[data-testid="multi-compare"]').click();

    await expect(page.locator('lv-compare-branches-dialog lv-modal[open]')).toBeVisible();
    // The older commit is the base, the newer one the compare side
    await expect(page.locator('lv-compare-branches-dialog #base-ref-select')).toHaveValue(
      'commit2'
    );
    await expect(page.locator('lv-compare-branches-dialog #compare-ref-select')).toHaveValue(
      'commit0'
    );
  });

  test('the export dialog opens with the whole selection pre-ticked for patches', async ({
    page,
  }) => {
    await loadHistory(page);

    await clickRow(page, 2);
    await waitForSelectedNode(page, 'commit2');
    await clickRow(page, 1, { ctrl: true });
    await clickRow(page, 0, { ctrl: true });
    await clickRow(page, 1, { button: 'right' });

    await page.locator('[data-testid="multi-create-patch"]').click();

    await expect(page.locator('lv-export-import-dialog lv-modal[open]')).toBeVisible();
    for (const oid of ['commit0', 'commit1', 'commit2']) {
      await expect(
        page.locator(`lv-export-import-dialog input[data-oid="${oid}"]`)
      ).toBeChecked();
    }
    await expect(
      page.locator('lv-export-import-dialog [data-testid="patch-selected-count"]')
    ).toContainText('3 selected');
  });
});
