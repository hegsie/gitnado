import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  getCapturedCommands,
  injectCommandError,
  openViaCommandPalette,
  waitForRepositoryChanged,
} from '../fixtures/test-helpers';

/**
 * The archive / patch / bundle backend was fully built and fully wrapped in
 * git.service.ts, but nothing in the UI ever reached it. These specs drive the
 * new lv-export-import-dialog end-to-end from the surfaces a user actually
 * has: the command palette, the commit context menu and the ref context menu.
 */

const ARCHIVE_FILES = ['README.md', 'src/main.ts', 'src/app.ts'];
const BUNDLE_HEADS = [
  { name: 'refs/heads/imported-branch', oid: 'c'.repeat(40) },
  { name: 'refs/tags/v2.0', oid: 'd'.repeat(40) },
];

async function setupMocks(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await startCommandCaptureWithMocks(page, {
    get_archive_files: ARCHIVE_FILES,
    create_archive: '/tmp/repo.zip',
    create_patch: ['/tmp/patches/0001-a.patch'],
    apply_patch: null,
    apply_patch_to_index: null,
    bundle_create: { bundlePath: '/tmp/x.bundle', refsCount: 3, objectsCount: 42 },
    bundle_list_heads: BUNDLE_HEADS,
    bundle_verify: { isValid: true, refs: BUNDLE_HEADS, requires: [], message: null },
    bundle_unbundle: BUNDLE_HEADS,
    'plugin:dialog|save': '/tmp/repo.zip',
    'plugin:dialog|open': '/tmp/fix.patch',
    ...extra,
  });
}

const dialog = 'lv-export-import-dialog';

async function rightClickOnCommitRow(page: Page, rowIndex = 0): Promise<void> {
  const graphCanvas = page.locator('lv-graph-canvas');
  await expect(graphCanvas).toBeVisible();
  const innerCanvas = graphCanvas.locator('canvas[role="img"]');
  await expect(innerCanvas).toBeAttached();

  const graphHandle = await graphCanvas.elementHandle();
  await page.waitForFunction(
    (el) =>
      ((el as HTMLElement & { sortedNodesByRow?: unknown[] })?.sortedNodesByRow?.length ?? 0) > 0,
    graphHandle,
  );

  const box = await graphCanvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  const rowHeight = 32;
  const headerHeight = 32;
  await page.mouse.click(box.x + 400, box.y + headerHeight + rowIndex * rowHeight + rowHeight / 2, {
    button: 'right',
  });
}

/**
 * The graph is a canvas, so a ref chip has no DOM node to right-click. Drive
 * the same `ref-context-menu` event the canvas hit-test dispatches.
 */
async function openRefContextMenu(page: Page, refName: string): Promise<void> {
  const graphCanvas = page.locator('lv-graph-canvas');
  await expect(graphCanvas).toBeVisible();
  const handle = await graphCanvas.elementHandle();
  await page.evaluate(
    ({ el, name }) => {
      el?.dispatchEvent(
        new CustomEvent('ref-context-menu', {
          detail: {
            refName: name,
            fullName: `refs/heads/${name}`,
            refType: 'localBranch',
            isHead: false,
            position: { x: 200, y: 200 },
          },
          bubbles: true,
          composed: true,
        }),
      );
    },
    { el: handle, name: refName },
  );
}

test.describe('Export / Import dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('exports an archive from the command palette', async ({ page }) => {
    await setupMocks(page);
    await openViaCommandPalette(page, 'Export archive');

    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
    await expect(page.locator(`${dialog} [data-testid="archive-file-count"]`)).toHaveText(
      `${ARCHIVE_FILES.length} files`,
    );

    await page.locator(`${dialog} [data-testid="archive-export"]`).click();

    await expect
      .poll(async () => (await findCommand(page, 'create_archive')).length)
      .toBeGreaterThan(0);
    const [call] = await findCommand(page, 'create_archive');
    expect((call.args as { treeRef?: string }).treeRef).toBe('HEAD');
    await expect(page.locator('lv-toast-container').getByText(/Archive written to/)).toBeVisible();
  });

  test('shows an archive failure inside the dialog instead of dead-ending', async ({ page }) => {
    await setupMocks(page);
    await injectCommandError(page, 'create_archive', 'fatal: not a valid object name');
    await openViaCommandPalette(page, 'Export archive');
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();

    await page.locator(`${dialog} [data-testid="archive-export"]`).click();

    await expect(page.locator(`${dialog} [data-testid="dialog-error"]`)).toContainText(
      'not a valid object name',
    );
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
  });

  test('checks a patch and then applies it, refreshing the repository', async ({ page }) => {
    await setupMocks(page);
    await openViaCommandPalette(page, 'Apply patch file');
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();

    await page.locator(`${dialog} [data-testid="patch-choose-file"]`).click();
    await expect(page.locator(`${dialog} [data-testid="chosen-patch-file"]`)).toHaveText(
      '/tmp/fix.patch',
    );

    await page.locator(`${dialog} [data-testid="patch-check"]`).click();
    await expect(page.locator('lv-toast-container').getByText(/applies cleanly/)).toBeVisible();
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();

    const refreshed = await waitForRepositoryChanged(page, async () => {
      await page.locator(`${dialog} [data-testid="patch-apply"]`).click();
    });
    expect(refreshed, 'applying a patch must refresh the repository view').toBe(true);

    const applies = await findCommand(page, 'apply_patch');
    expect(applies.some((c) => !(c.args as { checkOnly?: boolean }).checkOnly)).toBe(true);
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeHidden();
  });

  test('imports a bundle and refreshes the repository', async ({ page }) => {
    await setupMocks(page, { 'plugin:dialog|open': '/tmp/x.bundle' });
    await openViaCommandPalette(page, 'Import bundle');
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();

    await page.locator(`${dialog} [data-testid="bundle-choose-file"]`).click();
    await expect(page.locator(dialog).getByText('refs/heads/imported-branch')).toBeVisible();

    const refreshed = await waitForRepositoryChanged(page, async () => {
      await page.locator(`${dialog} [data-testid="bundle-import"]`).click();
    });
    expect(refreshed, 'importing refs must refresh the repository view').toBe(true);

    expect((await findCommand(page, 'bundle_unbundle')).length).toBe(1);
    const commands = await getCapturedCommands(page);
    const unbundleAt = commands.findIndex((c) => c.command === 'bundle_unbundle');
    const refreshAt = commands.findIndex(
      (c, i) => i > unbundleAt && c.command === 'open_repository',
    );
    expect(refreshAt, 'the repository is re-read after the import').toBeGreaterThan(unbundleAt);
    await expect(page.locator('lv-toast-container').getByText(/Imported 2 refs/)).toBeVisible();
  });

  test('opens the Patch tab with the right-clicked commit pre-checked', async ({ page }) => {
    await setupMocks(page);
    await rightClickOnCommitRow(page, 0);

    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    const oid = await menu.locator('.context-menu-oid').textContent();
    await menu.getByText('Create patch…').click();

    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
    const checked = page.locator(`${dialog} input[type="checkbox"]:checked`);
    await expect(checked).toHaveCount(1);
    await expect(await checked.getAttribute('data-oid')).toContain((oid ?? '').trim());
  });

  test('opens the Archive tab on the ref the context menu was opened for', async ({ page }) => {
    await setupMocks(page);
    await openRefContextMenu(page, 'feature/test');

    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await menu.getByText('Export archive…').click();

    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
    // The deep link, not the HEAD default the palette entry would have shown.
    await expect(page.locator(`${dialog} #archive-ref`)).toHaveValue('feature/test');
    await expect
      .poll(async () =>
        (await findCommand(page, 'get_archive_files')).map(
          (c) => (c.args as { treeRef?: string }).treeRef,
        ),
      )
      .toContain('feature/test');
  });
});

/**
 * The dialog pins the repository it was opened for, so a tab switch behind an
 * open dialog must not swap the refs under the user's cursor — the next
 * Export would otherwise run a name from the newly active repo against the
 * pinned one.
 */
test.describe('Export / Import dialog - repository pinning', () => {
  const OTHER_REPO = '/work/other-repo';
  const OTHER_BRANCHES = [
    {
      name: 'other-main',
      shorthand: 'other-main',
      isHead: true,
      isRemote: false,
      upstream: null,
      targetOid: 'e'.repeat(40),
      isStale: false,
    },
  ];

  /** get_branches answers per repository so the two tabs cannot be confused. */
  async function mockBranchesPerRepo(
    page: Page,
    byPath: Record<string, unknown>,
  ): Promise<void> {
    await page.evaluate((map) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'get_branches') {
          const path = (args as { path?: string } | undefined)?.path ?? '';
          if (path in map) return map[path];
        }
        return original(command, args);
      };
    }, byPath);
  }

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
          headRef: 'other-main',
          state: 'clean',
          isShallow: false,
          isPartialClone: false,
          cloneFilter: null,
        });
      },
      { path, name },
    );
  }

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('keeps the pinned repository refs when the active tab changes', async ({ page }) => {
    await setupMocks(page);
    await mockBranchesPerRepo(page, { [OTHER_REPO]: OTHER_BRANCHES });
    await openViaCommandPalette(page, 'Export archive');
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
    await expect(page.locator(`${dialog} #archive-ref option[value="feature/test"]`)).toHaveCount(1);

    await addRepo(page, OTHER_REPO, 'other-repo');

    // The other repo is active AND its branches have replaced the sidebar's —
    // so the dialog's bound `branches` really did change underneath it.
    await expect(page.locator('lv-toolbar .tab.active')).toHaveAttribute('title', OTHER_REPO);
    await expect(page.locator('lv-branch-list .branch-item.active')).toContainText('other-main');

    // …and the dialog still offers the repository it was opened for.
    await expect(page.locator(`${dialog} lv-modal[open]`)).toBeVisible();
    await expect(page.locator(`${dialog} #archive-ref option[value="feature/test"]`)).toHaveCount(1);
    await expect(page.locator(`${dialog} #archive-ref option[value="other-main"]`)).toHaveCount(0);
  });
});
