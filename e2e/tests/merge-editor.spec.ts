import { test, expect } from '@playwright/test';
import { setupOpenRepository, withConflicts } from '../fixtures/tauri-mock';
import {
  startCommandCapture,
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  injectCommandMock,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Merge Editor and Conflict Resolution Dialog
 *
 * The conflict resolution dialog opens when the app-shell receives an
 * 'open-conflict-dialog' or 'merge-conflict' event. It embeds the
 * lv-merge-editor component for 3-way conflict resolution.
 *
 * The dialog is `lv-conflict-resolution-dialog` (rendered by app-shell when showConflictDialog=true).
 * The merge editor within it is `lv-merge-editor`.
 */

/** Open the conflict resolution dialog by clicking the "Resolve Conflicts" button in the operation banner */
async function openConflictResolutionDialog(page: import('@playwright/test').Page) {
  // The operation banner appears when the repository state is 'merge' (set by withConflicts()).
  // It contains a "Resolve Conflicts" button that calls handleOpenConflictDialog() on app-shell,
  // which sets showConflictDialog=true and renders the lv-conflict-resolution-dialog.
  const resolveBtn = page.locator('.operation-btn-primary', { hasText: 'Resolve Conflicts' });
  await expect(resolveBtn).toBeVisible();
  await resolveBtn.click();

  // Wait for the dialog to become visible
  await page.locator('lv-conflict-resolution-dialog[open]').waitFor({ state: 'visible' });

  // Wait for conflicts to finish loading (file list items appear)
  await page.locator('lv-conflict-resolution-dialog .file-item').first().waitFor({ state: 'visible' });

  // Wait for the merge editor to finish loading its content
  await expect(page.locator('lv-merge-editor .toolbar')).toBeVisible();
}

/** Shared mock overrides for conflict resolution commands */
const conflictMocks = (conflictFiles: unknown[]) => ({
  get_conflicts: conflictFiles,
  get_blob_content: 'const value = "base";',
  read_file_content:
    '<<<<<<< HEAD\nconst value = "ours";\n=======\nconst value = "theirs";\n>>>>>>> feature-branch',
  resolve_conflict: null,
  abort_merge: null,
  auto_detect_merge_tool: null,
  is_ai_available: false,
});

test.describe('Merge Editor - Conflict Resolution Dialog', () => {
  const twoConflictFiles = [
    {
      path: 'src/conflict.ts',
      ancestor: { oid: 'ancestor_oid_123' },
      ours: { oid: 'ours_oid_456' },
      theirs: { oid: 'theirs_oid_789' },
    },
    {
      path: 'src/another.ts',
      ancestor: { oid: 'ancestor_oid_aaa' },
      ours: { oid: 'ours_oid_bbb' },
      theirs: { oid: 'theirs_oid_ccc' },
    },
  ];

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
          { path: 'src/another.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });

    // Mock commands for conflict resolution
    await injectCommandMock(page, conflictMocks(twoConflictFiles));
  });

  test('AI actions stay visible and explain themselves when the chosen provider is down', async ({
    page,
  }) => {
    // A provider is selected in Settings but unreachable. Requests are never
    // redirected to another provider, so the AI actions cannot run — but they
    // must say why rather than vanish without explanation.
    await injectCommandMock(page, {
      is_ai_available: false,
      ai_unavailable_reason: {
        reason:
          'Anthropic Claude is not available. Please check its API key in Settings, or select a different provider.',
        providerSelected: true,
      },
    });

    await openConflictResolutionDialog(page);

    const suggest = page.locator('lv-merge-editor button', { hasText: 'AI Suggest' }).first();
    await expect(suggest).toBeVisible();
    await expect(suggest).toBeDisabled();
    await expect(suggest).toHaveAttribute('title', /Anthropic Claude/);

    const resolveAll = page.locator('lv-merge-editor button', { hasText: 'AI Resolve All' });
    await expect(resolveAll).toBeVisible();
    await expect(resolveAll).toBeDisabled();
    await expect(resolveAll).toHaveAttribute('title', /Anthropic Claude/);
  });

  test('AI actions stay hidden when no provider has been configured', async ({ page }) => {
    await injectCommandMock(page, {
      is_ai_available: false,
      ai_unavailable_reason: {
        reason: 'No AI provider available. Please configure a provider in Settings.',
        providerSelected: false,
      },
    });

    await openConflictResolutionDialog(page);

    await expect(page.locator('lv-merge-editor button', { hasText: 'AI Suggest' })).toHaveCount(0);
    await expect(page.locator('lv-merge-editor button', { hasText: 'AI Resolve All' })).toHaveCount(
      0,
    );
  });

  test('dialog opens and lists conflicted files', async ({ page }) => {
    await openConflictResolutionDialog(page);

    const dialog = page.locator('lv-conflict-resolution-dialog');
    await expect(dialog).toBeVisible();

    // Should show "Resolve Merge Conflicts" title
    const headerTitle = dialog.locator('.header-title');
    await expect(headerTitle).toContainText('Resolve');
    await expect(headerTitle).toContainText('Conflicts');

    // Should list both conflicted files
    const fileItems = dialog.locator('.file-item');
    await expect(fileItems).toHaveCount(2);
  });

  test('first file is selected by default and shows merge editor', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // First file should be selected
    const selectedFile = page.locator('lv-conflict-resolution-dialog .file-item.selected');
    await expect(selectedFile).toBeVisible();

    // Merge editor should be visible
    const mergeEditor = page.locator('lv-merge-editor');
    await expect(mergeEditor).toBeVisible();
  });

  test('merge editor displays three source panels (Ours, Base, Theirs) and Output', async ({
    page,
  }) => {
    await openConflictResolutionDialog(page);

    const mergeEditor = page.locator('lv-merge-editor');
    await expect(mergeEditor).toBeVisible();

    // Should have the three source panel headers
    const oursHeader = mergeEditor.locator('.panel-header.ours');
    const baseHeader = mergeEditor.locator('.panel-header.base');
    const theirsHeader = mergeEditor.locator('.panel-header.theirs');
    const outputHeader = mergeEditor.locator('.panel-header.output');

    await expect(oursHeader).toBeVisible();
    await expect(baseHeader).toBeVisible();
    await expect(theirsHeader).toBeVisible();
    await expect(outputHeader).toBeVisible();

    await expect(oursHeader).toContainText('Ours');
    await expect(baseHeader).toContainText('Base');
    await expect(theirsHeader).toContainText('Theirs');
    await expect(outputHeader).toContainText('Output');
  });

  test('toolbar shows file path and action buttons', async ({ page }) => {
    await openConflictResolutionDialog(page);

    const toolbar = page.locator('lv-merge-editor .toolbar');
    await expect(toolbar).toBeVisible();

    // File path should be visible in toolbar title
    const toolbarTitle = page.locator('lv-merge-editor .toolbar-title');
    await expect(toolbarTitle).toContainText('conflict');

    // Should have Use Ours, Use Theirs, and Mark Resolved buttons in toolbar-actions
    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    const useTheirsBtn = page.locator('lv-merge-editor .toolbar-actions .btn-theirs');
    const markResolvedBtn = page.locator('lv-merge-editor .toolbar-actions .btn-primary');

    await expect(useOursBtn).toBeVisible();
    await expect(useTheirsBtn).toBeVisible();
    await expect(markResolvedBtn).toBeVisible();

    await expect(useOursBtn).toContainText('Use Ours');
    await expect(useTheirsBtn).toContainText('Use Theirs');
    await expect(markResolvedBtn).toContainText('Mark Resolved');
  });

  test('output panel shows conflict blocks with Use Ours/Theirs/Both/Edit buttons', async ({
    page,
  }) => {
    await openConflictResolutionDialog(page);

    const mergeEditor = page.locator('lv-merge-editor');

    // The conflict count in the output header should indicate conflicts remaining
    const conflictCount = mergeEditor.locator('.conflict-count');
    await expect(conflictCount).toBeVisible();
    await expect(conflictCount).toContainText('1 conflict remaining');

    // The unresolved conflict renders as a structured block with per-block actions
    const block = mergeEditor.locator('.code-conflict-block');
    await expect(block).toBeVisible();
    await expect(block.locator('button', { hasText: 'Use Ours' })).toBeVisible();
    await expect(block.locator('button', { hasText: 'Use Theirs' })).toBeVisible();
    await expect(block.locator('button', { hasText: 'Use Both' })).toBeVisible();
    await expect(block.locator('button', { hasText: 'Edit' })).toBeVisible();

    // Both sides are shown side by side inside the block
    await expect(block.locator('.code-conflict-side-ours')).toContainText('ours');
    await expect(block.locator('.code-conflict-side-theirs')).toContainText('theirs');
  });

  test('never renders raw conflict markers anywhere in the editor', async ({ page }) => {
    await openConflictResolutionDialog(page);

    const mergeEditor = page.locator('lv-merge-editor');
    await expect(mergeEditor.locator('.code-conflict-block')).toBeVisible();

    const text = await mergeEditor.innerText();
    expect(text).not.toContain('<<<<<<<');
    expect(text).not.toContain('=======');
    expect(text).not.toContain('>>>>>>>');
  });

  test('per-block Use Theirs resolves just that block and enables Mark Resolved', async ({
    page,
  }) => {
    await openConflictResolutionDialog(page);

    // Mark Resolved is disabled while the conflict block is unresolved
    const markResolvedBtn = page.locator('lv-merge-editor .toolbar-actions .btn-primary');
    await expect(markResolvedBtn).toBeDisabled();

    const block = page.locator('lv-merge-editor .code-conflict-block');
    await block.locator('button', { hasText: 'Use Theirs' }).click();

    // The block is resolved: count reads "No conflicts", theirs content is in
    // the output, and Mark Resolved becomes clickable
    await expect(page.locator('lv-merge-editor .conflict-count')).toContainText('No conflicts');
    await expect(page.locator('lv-merge-editor #panel-output')).toContainText('theirs');
    await expect(markResolvedBtn).toBeEnabled();
  });

  test('per-block Edit opens a marker-free editor and Apply resolves the block', async ({
    page,
  }) => {
    await openConflictResolutionDialog(page);

    const block = page.locator('lv-merge-editor .code-conflict-block');
    await block.locator('button', { hasText: 'Edit' }).click();

    // The edit textarea is prefilled from both sides, never with marker text
    const textarea = page.locator('lv-merge-editor .segment-editor textarea');
    await expect(textarea).toBeVisible();
    const draft = await textarea.inputValue();
    expect(draft).not.toContain('<<<<<<<');
    expect(draft).not.toContain('=======');
    expect(draft).toContain('ours');
    expect(draft).toContain('theirs');

    await textarea.fill('const value = "hand-merged";');
    await page.locator('lv-merge-editor .segment-editor button', { hasText: 'Apply' }).click();

    await expect(page.locator('lv-merge-editor .conflict-count')).toContainText('No conflicts');
    await expect(page.locator('lv-merge-editor #panel-output')).toContainText('hand-merged');
  });

  test('clicking Use Ours in toolbar replaces output with ours content', async ({ page }) => {
    await openConflictResolutionDialog(page);

    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    await expect(useOursBtn).toBeVisible();
    await useOursBtn.click();

    // After accepting ours, conflict count should show "No conflicts"
    const conflictCount = page.locator('lv-merge-editor .conflict-count');
    await expect(conflictCount).toContainText('No conflicts');
  });

  test('toolbar Use Ours confirms before replacing a per-block pick', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // Make a per-block pick — this is the in-progress work the confirm guards.
    const block = page.locator('lv-merge-editor .code-conflict-block');
    await block.locator('button', { hasText: 'Use Theirs' }).click();
    const output = page.locator('lv-merge-editor #panel-output');
    await expect(output).toContainText('const value = "theirs";');

    // Declining must leave the pick exactly as it was. The whole-file blobs
    // all read as `base` here, so its absence proves nothing was overwritten.
    await startCommandCaptureWithMocks(page, { 'plugin:dialog|confirm': false });
    await page.locator('lv-merge-editor .toolbar-actions .btn-ours').click();
    await waitForCommand(page, 'plugin:dialog|message');
    await expect(output).toContainText('const value = "theirs";');
    await expect(output).not.toContainText('const value = "base";');

    // Accepting replaces the pick with the whole ours blob.
    await startCommandCaptureWithMocks(page, { 'plugin:dialog|confirm': true });
    await page.locator('lv-merge-editor .toolbar-actions .btn-ours').click();
    await waitForCommand(page, 'plugin:dialog|message');
    await expect(output).toContainText('const value = "base";');
    await expect(output).not.toContainText('const value = "theirs";');
  });

  test('declining the take-side confirm keeps the deleted-side file unresolved', async ({
    page,
  }) => {
    // Modify/delete: git leaves the workdir file marker-free, so the toolbar's
    // "Use Theirs (delete file)" is a take-side that stages a deletion on disk.
    await injectCommandMock(page, {
      get_conflicts: [
        {
          path: 'src/conflict.ts',
          ancestor: { oid: 'ancestor_oid_123' },
          ours: { oid: 'ours_oid_456' },
          theirs: null,
        },
      ],
      read_file_content: 'const value = "ours";',
      resolve_conflict_take_side: null,
    });
    await openConflictResolutionDialog(page);

    // Accept ours whole-file first — the only in-editor work reachable here.
    await page.locator('lv-merge-editor .toolbar-actions .btn-ours').click();
    const output = page.locator('lv-merge-editor #panel-output');
    await expect(output).toContainText('const value = "base";');

    const deleteBtn = page.locator('lv-merge-editor .toolbar-actions .btn-theirs', {
      hasText: 'Use Theirs (delete file)',
    });
    await expect(deleteBtn).toBeVisible();

    await startCommandCaptureWithMocks(page, { 'plugin:dialog|confirm': false });
    await deleteBtn.click();
    await waitForCommand(page, 'plugin:dialog|message');
    expect(await findCommand(page, 'resolve_conflict_take_side')).toHaveLength(0);
    await expect(output).toContainText('const value = "base";');

    // Confirming stages the deletion and lands in the terminal deleted state.
    // (Each stacked mock wrapper records the call, so assert on the args, not
    // on how many times the capture layers saw it.)
    await startCommandCaptureWithMocks(page, { 'plugin:dialog|confirm': true });
    await deleteBtn.click();
    await waitForCommand(page, 'resolve_conflict_take_side');
    const taken = await findCommand(page, 'resolve_conflict_take_side');
    expect((taken[0].args as { side: string }).side).toBe('theirs');
    await expect(output).toContainText('this file was deleted by the resolution');
  });

  test('clicking Use Theirs in toolbar replaces output with theirs content', async ({ page }) => {
    await openConflictResolutionDialog(page);

    const useTheirsBtn = page.locator('lv-merge-editor .toolbar-actions .btn-theirs');
    await expect(useTheirsBtn).toBeVisible();
    await useTheirsBtn.click();

    // After accepting theirs, conflict count should show "No conflicts"
    const conflictCount = page.locator('lv-merge-editor .conflict-count');
    await expect(conflictCount).toContainText('No conflicts');
  });

  test('Mark Resolved calls resolve_conflict command', async ({ page }) => {
    await startCommandCapture(page);
    await openConflictResolutionDialog(page);

    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    await expect(useOursBtn).toBeVisible();
    await useOursBtn.click();

    // Click Mark Resolved
    const markResolvedBtn = page.locator('lv-merge-editor .toolbar-actions .btn-primary');
    await markResolvedBtn.click();

    await waitForCommand(page, 'resolve_conflict');

    const commands = await findCommand(page, 'resolve_conflict');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Verify the file is marked as resolved in the file list
    const resolvedFile = page.locator('lv-conflict-resolution-dialog .file-item.resolved');
    await expect(resolvedFile).toBeVisible({ timeout: 3000 });

    // Verify the progress subtitle updates to reflect one resolved file
    const subtitle = page.locator('lv-conflict-resolution-dialog .header-subtitle');
    await expect(subtitle).toContainText('1 of 2');
  });

  test('Abort button shows confirmation dialog', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // Click Abort button in the footer
    const abortBtn = page.locator(
      'lv-conflict-resolution-dialog .footer-actions .btn-danger'
    );
    await expect(abortBtn).toContainText('Abort');
    await abortBtn.click();

    // Confirmation dialog should appear
    const confirmDialog = page.locator('lv-conflict-resolution-dialog .confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText('Abort');
  });

  test('Continue button is disabled when conflicts remain unresolved', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // Continue button should be disabled since not all files are resolved
    const continueBtn = page.locator(
      'lv-conflict-resolution-dialog .footer-actions .btn-primary'
    );
    await expect(continueBtn).toBeDisabled();
  });

  test('file navigation between conflicted files works', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // Should show navigation buttons
    const nextBtn = page.locator('lv-conflict-resolution-dialog .nav-btn', { hasText: 'Next' });
    await expect(nextBtn).toBeVisible();

    // Click next to go to second file
    await nextBtn.click();

    // Second file should now be selected
    const selectedFile = page.locator('lv-conflict-resolution-dialog .file-item.selected');
    await expect(selectedFile).toBeVisible();
  });

  test('shows progress of resolved files', async ({ page }) => {
    await openConflictResolutionDialog(page);

    // Header subtitle should show "0 of 2 conflicts resolved"
    const subtitle = page.locator('lv-conflict-resolution-dialog .header-subtitle');
    await expect(subtitle).toContainText('0 of 2');
  });

  test('clicking a conflicted file in the sidebar opens the conflict dialog, not the diff view', async ({
    page,
  }) => {
    // Click the SECOND conflicted file — the dialog must open on the file
    // that was actually clicked, not just the first conflict in the list.
    const fileItem = page.locator('lv-file-status .file-item', { hasText: 'another.ts' }).first();
    await expect(fileItem).toBeVisible();
    await fileItem.click();

    // The conflict resolution dialog opens instead of the raw diff view
    await expect(page.locator('lv-conflict-resolution-dialog[open]')).toBeVisible();
    await expect(page.locator('lv-merge-editor .toolbar')).toBeVisible();

    // Preselected on the clicked file
    await expect(page.locator('lv-merge-editor .toolbar-title')).toContainText('another.ts');
    await expect(
      page.locator('lv-conflict-resolution-dialog .file-item.selected')
    ).toContainText('another.ts');

    // And no raw conflict markers are visible anywhere on the page
    const dialogText = await page.locator('lv-conflict-resolution-dialog').innerText();
    expect(dialogText).not.toContain('<<<<<<<');
    expect(dialogText).not.toContain('>>>>>>>');
  });
});

test.describe('Merge Editor - Live diff transitions', () => {
  test('an open diff transitions when its file becomes conflicted and closes when resolved', async ({
    page,
  }) => {
    await setupOpenRepository(page, {
      status: {
        staged: [],
        unstaged: [
          { path: 'src/live.ts', status: 'modified', isStaged: false, isConflicted: false },
        ],
      },
    });

    // Open the diff on the (not yet conflicted) file
    const fileItem = page.locator('lv-file-status .file-item', { hasText: 'live.ts' }).first();
    await expect(fileItem).toBeVisible();
    await fileItem.click();
    await expect(page.locator('lv-diff-view')).toBeVisible();
    await expect(page.locator('lv-diff-view .conflict-redirect')).toHaveCount(0);

    // An external merge conflicts the file — the status refresh must flip the
    // open diff to the merge-editor redirect instead of rendering marker text.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: { getState: () => { setStatus: (s: unknown[]) => void } };
      };
      stores.repositoryStore.getState().setStatus([
        { path: 'src/live.ts', status: 'conflicted', isStaged: false, isConflicted: true },
      ]);
    });

    await expect(page.locator('lv-diff-view .conflict-redirect')).toBeVisible();
    const text = await page.locator('lv-diff-view').innerText();
    expect(text).not.toContain('<<<<<<<');

    // The conflict is resolved and committed externally — the file leaves the
    // status entirely. The stale interstitial must close, not claim conflicts
    // forever.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: { getState: () => { setStatus: (s: unknown[]) => void } };
      };
      stores.repositoryStore.getState().setStatus([]);
    });

    await expect(page.locator('lv-diff-view .conflict-redirect')).toHaveCount(0);
    await expect(page.locator('lv-diff-view')).toHaveCount(0);
  });
});

test.describe('Merge Editor - Stash source certainty', () => {
  test('inferred-stash wording does not leak into a later explicit stash flow', async ({
    page,
  }) => {
    // Clean repository state with conflicted files = a state-INFERRED stash.
    await setupOpenRepository(page, {
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });
    await injectCommandMock(page, {
      ...conflictMocks([
        {
          path: 'src/conflict.ts',
          ancestor: { oid: 'ancestor_oid_123' },
          ours: { oid: 'ours_oid_456' },
          theirs: { oid: 'theirs_oid_789' },
        },
      ]),
      unstage_files: null,
      discard_changes: null,
    });

    // The clean-state banner must not overclaim a stash source either.
    await expect(page.locator('.operation-text')).toContainText('Conflicts need resolution');
    await expect(page.locator('.operation-text')).not.toContainText('Stash');

    // Open via the conflicted-file click (state-derived: uncertain source).
    await page.locator('lv-file-status .file-item', { hasText: 'conflict.ts' }).first().click();
    await expect(page.locator('lv-conflict-resolution-dialog[open]')).toBeVisible();

    const abortBtn = page.locator('lv-conflict-resolution-dialog .footer-actions .btn-danger');
    await abortBtn.click();
    const confirmMsg = page.locator('lv-conflict-resolution-dialog .confirm-message');
    await expect(confirmMsg).toContainText('not saved anywhere else');

    // Abort for real to close the dialog.
    await page.locator('lv-conflict-resolution-dialog .confirm-actions .btn-danger').click();
    await expect(page.locator('lv-conflict-resolution-dialog[open]')).not.toBeVisible();

    // Now an EXPLICIT stash conflict (as the stash panel dispatches it) —
    // the earlier uncertainty must not leak into its wording.
    await page.evaluate(() => {
      const shell = document.querySelector('lv-app-shell');
      shell?.dispatchEvent(
        new CustomEvent('open-conflict-dialog', {
          detail: { operationType: 'stash', stashIndex: 0, dropStashOnComplete: false },
          bubbles: true,
          composed: true,
        })
      );
    });
    await expect(page.locator('lv-conflict-resolution-dialog[open]')).toBeVisible();

    await abortBtn.click();
    await expect(confirmMsg).toContainText('remains in the stash list');
  });
});

test.describe('Merge Editor - Error Handling', () => {
  const oneConflictFile = [
    {
      path: 'src/conflict.ts',
      ancestor: { oid: 'ancestor_oid_123' },
      ours: { oid: 'ours_oid_456' },
      theirs: { oid: 'theirs_oid_789' },
    },
  ];

  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });

    await injectCommandMock(page, conflictMocks(oneConflictFile));
  });

  test('resolve_conflict error shows feedback', async ({ page }) => {
    await injectCommandError(page, 'resolve_conflict', 'Permission denied');
    await openConflictResolutionDialog(page);

    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    await expect(useOursBtn).toBeVisible();
    await useOursBtn.click();

    // Click Mark Resolved
    const markResolvedBtn = page.locator('lv-merge-editor .toolbar-actions .btn-primary');
    await markResolvedBtn.click();

    // The dialog should remain open (not close) since resolve failed
    const dialog = page.locator('lv-conflict-resolution-dialog[open]');
    await expect(dialog).toBeVisible();
  });

  test('abort merge calls abort_merge and closes dialog', async ({ page }) => {
    await startCommandCapture(page);
    await openConflictResolutionDialog(page);

    // Click Abort in the footer
    const abortBtn = page.locator(
      'lv-conflict-resolution-dialog .footer-actions .btn-danger'
    );
    await abortBtn.click();

    // Confirm abort in the confirmation dialog
    const confirmBtn = page.locator(
      'lv-conflict-resolution-dialog .confirm-actions .btn-danger'
    );
    await confirmBtn.click();

    await waitForCommand(page, 'abort_merge');

    const commands = await findCommand(page, 'abort_merge');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Verify the conflict resolution dialog closes after aborting merge
    // App-shell removes the dialog from DOM when showConflictDialog becomes false
    await expect(
      page.locator('lv-conflict-resolution-dialog[open]')
    ).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Merge Editor - UI Outcome Verification', () => {
  const twoConflictFiles = [
    {
      path: 'src/conflict.ts',
      ancestor: { oid: 'ancestor_oid_123' },
      ours: { oid: 'ours_oid_456' },
      theirs: { oid: 'theirs_oid_789' },
    },
    {
      path: 'src/another.ts',
      ancestor: { oid: 'ancestor_oid_aaa' },
      ours: { oid: 'ours_oid_bbb' },
      theirs: { oid: 'theirs_oid_ccc' },
    },
  ];

  const oneConflictFile = [
    {
      path: 'src/conflict.ts',
      ancestor: { oid: 'ancestor_oid_123' },
      ours: { oid: 'ours_oid_456' },
      theirs: { oid: 'theirs_oid_789' },
    },
  ];

  test('Use Ours resolves conflicts and output panel reflects no remaining conflicts', async ({
    page,
  }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
          { path: 'src/another.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });
    await injectCommandMock(page, conflictMocks(twoConflictFiles));
    await openConflictResolutionDialog(page);

    // Before clicking Use Ours, the conflict count should indicate conflicts exist
    const conflictCount = page.locator('lv-merge-editor .conflict-count');
    await expect(conflictCount).toBeVisible();
    const initialText = await conflictCount.textContent();
    expect(initialText).not.toContain('No conflicts');

    // Click Use Ours
    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    await useOursBtn.click();

    // After clicking Use Ours, the conflict count should show "No conflicts"
    await expect(conflictCount).toContainText('No conflicts');

    // The output panel should now reflect the ours content (no conflict markers)
    const outputPanel = page.locator('lv-merge-editor .output-panel');
    await expect(outputPanel).toBeVisible();
    // There should be no conflict blocks remaining in the output
    const conflictBlocks = page.locator('lv-merge-editor .output-panel .code-conflict-block');
    const blockCount = await conflictBlocks.count();
    expect(blockCount).toBe(0);
  });

  test('Use Theirs resolves conflicts and output panel reflects no remaining conflicts', async ({
    page,
  }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
          { path: 'src/another.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });
    await injectCommandMock(page, conflictMocks(twoConflictFiles));
    await openConflictResolutionDialog(page);

    // Click Use Theirs
    const useTheirsBtn = page.locator('lv-merge-editor .toolbar-actions .btn-theirs');
    await useTheirsBtn.click();

    // After clicking Use Theirs, the conflict count should show "No conflicts"
    const conflictCount = page.locator('lv-merge-editor .conflict-count');
    await expect(conflictCount).toContainText('No conflicts');

    // The output panel should reflect the theirs content (no conflict markers)
    const outputPanel = page.locator('lv-merge-editor .output-panel');
    await expect(outputPanel).toBeVisible();
    const conflictBlocks = page.locator('lv-merge-editor .output-panel .code-conflict-block');
    const blockCount = await conflictBlocks.count();
    expect(blockCount).toBe(0);
  });

  test('Continue button enables after all conflicts are resolved', async ({ page }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });
    await injectCommandMock(page, conflictMocks(oneConflictFile));
    await openConflictResolutionDialog(page);

    // Continue button should be disabled initially (unresolved conflicts)
    const continueBtn = page.locator(
      'lv-conflict-resolution-dialog .footer-actions .btn-primary'
    );
    await expect(continueBtn).toBeDisabled();

    // Resolve the conflict: Use Ours then Mark Resolved
    const useOursBtn = page.locator('lv-merge-editor .toolbar-actions .btn-ours');
    await useOursBtn.click();

    const markResolvedBtn = page.locator('lv-merge-editor .toolbar-actions .btn-primary');
    await markResolvedBtn.click();

    // Wait for the file to be marked as resolved
    const resolvedFile = page.locator('lv-conflict-resolution-dialog .file-item.resolved');
    await expect(resolvedFile).toBeVisible({ timeout: 3000 });

    // Continue button should now be enabled since all conflicts are resolved
    await expect(continueBtn).toBeEnabled({ timeout: 3000 });
  });

  test('get_conflicts failure shows error feedback in the dialog', async ({ page }) => {
    await setupOpenRepository(page, {
      ...withConflicts(),
      status: {
        staged: [],
        unstaged: [
          { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        ],
      },
    });

    // Set up base mocks first, then inject error for get_conflicts
    await injectCommandMock(page, {
      get_blob_content: 'const value = "base";',
      read_file_content:
        '<<<<<<< HEAD\nconst value = "ours";\n=======\nconst value = "theirs";\n>>>>>>> feature-branch',
      resolve_conflict: null,
      abort_merge: null,
      auto_detect_merge_tool: null,
      is_ai_available: false,
    });
    await injectCommandError(page, 'get_conflicts', 'Failed to get conflicts');

    // Click the Resolve Conflicts button to open the dialog
    const resolveBtn = page.locator('.operation-btn-primary', { hasText: 'Resolve Conflicts' });
    await expect(resolveBtn).toBeVisible();
    await resolveBtn.click();

    // The dialog should open
    const dialog = page.locator('lv-conflict-resolution-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Error feedback should be shown: either a toast or an error indicator inside the dialog
    const errorToast = page.locator('lv-toast-container .toast.error, .error-banner');
    const errorMsg = dialog.locator('.error-message, .error, .loading-error');

    // Use .first() to handle the case where both a toast and an in-dialog error are visible
    await expect(errorToast.or(errorMsg).first()).toBeVisible({ timeout: 5000 });

    // The file list should not have loaded successfully (no file items or an error shown)
    const fileItems = dialog.locator('.file-item');
    const fileCount = await fileItems.count();
    // At least one error indicator should be visible (empty state, toast, or inline error)
    if (fileCount === 0) {
      // Empty state is a valid error response
      expect(fileCount).toBe(0);
    } else {
      // Must show explicit error feedback
      await expect(
        page.locator('.toast, .error-message, .error, .error-banner, lv-merge-editor .error').first()
      ).toBeVisible({ timeout: 5000 });
    }
  });
});
