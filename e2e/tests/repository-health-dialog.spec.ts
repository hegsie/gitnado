import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCapture,
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
  openViaCommandPalette,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

async function openHealthDialog(page: import('@playwright/test').Page): Promise<void> {
  await openViaCommandPalette(page, 'health');
  await page.locator('gn-repository-health-dialog').waitFor({ state: 'visible', timeout: 3000 });
}

// The Tauri command get_repository_stats returns { count, loose, sizeKb }
// The Tauri command get_pack_info returns { packCount, packSizeKb }
// The maintenance commands (run_gc, run_fsck, run_prune) return MaintenanceResult { success, message }

test.describe('Repository Health Dialog - Statistics', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 150,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 3,
        packSizeKb: 4096,
      },
      run_gc: { success: true, message: 'Garbage collection completed' },
      run_fsck: { success: true, message: 'No issues found' },
      run_prune: { success: true, message: 'Pruned unreachable objects' },
    });
  });

  test('should open repository health dialog from command palette', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    await expect(healthDialog).toBeVisible();
  });

  test('should display repository statistics', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    const stats = healthDialog.locator('.stat-card');
    await expect(stats.first()).toBeVisible();
    const statCount = await stats.count();
    expect(statCount).toBeGreaterThan(0);
  });

  test('should show total objects count', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    await expect(healthDialog.getByText(/Total Objects/i).first()).toBeVisible();
  });

  test('should show repository size', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // formatSize(5120) = "5.0 MB"
    await expect(healthDialog.getByText(/MB|KB|GB/i).first()).toBeVisible();
  });

  test('should show loose objects count', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    await expect(healthDialog.getByText(/Loose/i).first()).toBeVisible();
  });

  test('should show pack files count', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    await expect(healthDialog.getByText(/Pack/i).first()).toBeVisible();
  });
});

test.describe('Repository Health Dialog - Maintenance Actions', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_gc: { success: true, message: 'Garbage collection completed' },
      run_fsck: { success: true, message: 'No issues found' },
      run_prune: { success: true, message: 'Pruned unreachable objects' },
    });
  });

  test('should have Garbage Collection button', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i });
    await expect(gcButton.first()).toBeVisible();
  });

  test('should have Aggressive GC button', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const aggressiveButton = healthDialog.locator('.action-btn', { hasText: /Aggressive GC/i });
    await expect(aggressiveButton.first()).toBeVisible();
  });

  test('should have File System Check button', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const fsckButton = healthDialog.locator('.action-btn', { hasText: /File System Check/i });
    await expect(fsckButton.first()).toBeVisible();
  });

  test('should have Prune button', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const pruneButton = healthDialog.locator('.action-btn', { hasText: /Prune/i });
    await expect(pruneButton.first()).toBeVisible();
  });

  test('clicking GC should invoke run_gc command', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    await startCommandCapture(page);

    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i }).first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    await waitForCommand(page, 'run_gc');

    const gcCommands = await findCommand(page, 'run_gc');
    expect(gcCommands.length).toBeGreaterThan(0);

    // Verify the health dialog remains visible after GC operation
    await expect(healthDialog).toBeVisible();
  });
});

test.describe('Repository Health Dialog - Recommendations', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
    });
  });

  test('should show recommendations when issues detected', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // With loose > 500 and packCount > 10, recommendations are shown
    const recommendations = healthDialog.locator('.recommendation');
    await expect(recommendations.first()).toBeVisible();
    const recCount = await recommendations.count();
    expect(recCount).toBeGreaterThan(0);
  });

  test('should show warning styling for high loose objects', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // The loose objects stat-value gets the "warning" class when > 500
    const warningElements = healthDialog.locator('.stat-value.warning');
    await expect(warningElements.first()).toBeVisible();
    const warningCount = await warningElements.count();
    expect(warningCount).toBeGreaterThan(0);
  });
});

test.describe('Repository Health Dialog - Healthy State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 500,
        loose: 50,
        sizeKb: 1024,
      },
      get_pack_info: {
        packCount: 2,
        packSizeKb: 800,
      },
    });
  });

  test('should show healthy message when no issues', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // Component shows "Repository is healthy - no maintenance needed"
    await expect(healthDialog.getByText(/healthy/i).first()).toBeVisible();
  });
});

test.describe('Repository Health Dialog - Footer', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 500,
        loose: 50,
        sizeKb: 1024,
      },
      get_pack_info: {
        packCount: 2,
        packSizeKb: 800,
      },
    });
  });

  test('should have Done button to close dialog', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const doneButton = healthDialog.locator('button.primary', { hasText: /Done/i });
    await expect(doneButton).toBeVisible();
  });

  test('clicking Done should close dialog', async ({ page }) => {
    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const doneButton = healthDialog.locator('button.primary', { hasText: /Done/i });
    await doneButton.click();

    await expect(healthDialog).not.toBeVisible();
  });
});

// ============================================================================
// Maintenance Action E2E - Command Verification
// ============================================================================

test.describe('Repository Health Dialog - GC E2E', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);
  });

  test('run GC should invoke run_gc and show success feedback', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_gc: { success: true, message: 'Garbage collection completed' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i }).first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    await waitForCommand(page, 'run_gc');

    const gcCommands = await findCommand(page, 'run_gc');
    expect(gcCommands.length).toBe(1);

    // Verify success feedback is visible after GC completes (toast with class "success")
    const successIndicator = page.locator('.toast.success').first();
    await expect(successIndicator).toBeVisible({ timeout: 5000 });

    // Verify the health dialog remains open after GC
    await expect(healthDialog).toBeVisible();
  });

  test('GC failure should show error feedback', async ({ page }) => {
    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_gc: { __error__: 'Garbage collection failed: repository locked' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i }).first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    const errorIndicator = page.locator('.toast.error').first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });
  });

  test('stats should display concrete values from mock data', async ({ page }) => {
    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 150,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 3,
        packSizeKb: 2048,
      },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // 1250.toLocaleString() produces "1,250"
    await expect(healthDialog.getByText(/1[,.]?250/).first()).toBeVisible();
  });

  test('prune should invoke run_prune command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_repository_stats: {
        count: 500,
        loose: 50,
        sizeKb: 1024,
      },
      get_pack_info: {
        packCount: 2,
        packSizeKb: 800,
      },
      run_prune: { success: true, message: 'Pruned unreachable objects' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const pruneButton = healthDialog.locator('.action-btn', { hasText: /Prune/i }).first();
    await expect(pruneButton).toBeVisible();
    await pruneButton.click();

    await waitForCommand(page, 'run_prune');

    const pruneCommands = await findCommand(page, 'run_prune');
    expect(pruneCommands.length).toBeGreaterThan(0);

    // Verify the health dialog remains open after prune operation
    await expect(healthDialog).toBeVisible();
  });
});

test.describe('Repository Health Dialog - Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);

    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
    });
  });

  test('should show error when run_gc fails', async ({ page }) => {
    await injectCommandError(page, 'run_gc', 'Garbage collection failed: repository is locked');

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i }).first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    await expect(page.locator('.toast.error').first()).toBeVisible({ timeout: 5000 });
  });

  test('should show error when run_fsck fails', async ({ page }) => {
    await injectCommandError(page, 'run_fsck', 'File system check failed: corrupt objects detected');

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const fsckButton = healthDialog.locator('.action-btn', { hasText: /File System Check/i }).first();
    await expect(fsckButton).toBeVisible();
    await fsckButton.click();

    await expect(page.locator('.toast.error').first()).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================================
// Extended Tests - Additional Coverage
// ============================================================================

test.describe('Repository Health - Extended Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    // GC and prune destroy unreachable objects, so both are confirm-gated.
    await autoConfirmDialogs(page);
  });

  test('declining the GC confirm does not run gc', async ({ page }) => {
    // This dialog reaches the same irreversible run_gc as the command palette,
    // so it must be gated the same way rather than being the unguarded route.
    await startCommandCaptureWithMocks(page, {
      get_repository_stats: { count: 1250, loose: 600, sizeKb: 5120 },
      get_pack_info: { packCount: 15, packSizeKb: 4096 },
      run_gc: { success: true, message: 'Garbage collection completed' },
    });

    await openHealthDialog(page);

    // Decline: plugin-dialog treats any non-OK label as cancel.
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });

    const healthDialog = page.locator('gn-repository-health-dialog');
    const gcButton = healthDialog
      .locator('.action-btn', { hasText: /Garbage Collection/i })
      .first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    await expect(healthDialog).toBeVisible();
    expect(await findCommand(page, 'run_gc')).toHaveLength(0);
  });

  test('clicking Aggressive GC should invoke run_gc command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_gc: { success: true, message: 'Aggressive garbage collection completed' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const aggressiveButton = healthDialog.locator('.action-btn', { hasText: /Aggressive GC/i }).first();
    await expect(aggressiveButton).toBeVisible();
    await aggressiveButton.click();

    await waitForCommand(page, 'run_gc');

    const gcCommands = await findCommand(page, 'run_gc');
    expect(gcCommands.length).toBeGreaterThan(0);

    // Verify the args indicate aggressive mode
    const args = gcCommands[0].args as Record<string, unknown>;
    const argsStr = JSON.stringify(args);
    expect(argsStr).toMatch(/aggressive|true/i);

    // Verify the health dialog remains open after operation
    await expect(healthDialog).toBeVisible();
  });

  test('clicking File System Check should invoke run_fsck command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_fsck: { success: true, message: 'No issues found' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');
    const fsckButton = healthDialog.locator('.action-btn', { hasText: /File System Check/i }).first();
    await expect(fsckButton).toBeVisible();
    await fsckButton.click();

    await waitForCommand(page, 'run_fsck');

    const fsckCommands = await findCommand(page, 'run_fsck');
    expect(fsckCommands.length).toBe(1);

    // Verify success feedback toast is shown
    const successToast = page.locator('.toast.success').first();
    await expect(successToast).toBeVisible({ timeout: 5000 });

    // Verify the health dialog remains open
    await expect(healthDialog).toBeVisible();
  });

  test('stats should refresh after running maintenance action', async ({ page }) => {
    // Start with high loose objects count
    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1250,
        loose: 600,
        sizeKb: 5120,
      },
      get_pack_info: {
        packCount: 15,
        packSizeKb: 4096,
      },
      run_gc: { success: true, message: 'Garbage collection completed' },
    });

    await openHealthDialog(page);

    const healthDialog = page.locator('gn-repository-health-dialog');

    // Verify initial stats are displayed with high loose objects
    await expect(healthDialog.locator('.stat-value.warning').first()).toBeVisible();

    // Now inject updated stats that simulate post-GC state (fewer loose objects)
    await injectCommandMock(page, {
      get_repository_stats: {
        count: 1100,
        loose: 20,
        sizeKb: 4800,
      },
      get_pack_info: {
        packCount: 4,
        packSizeKb: 4600,
      },
    });

    // Start capturing commands to verify stats refresh
    await startCommandCaptureWithMocks(page, {
      run_gc: { success: true, message: 'Garbage collection completed' },
      get_repository_stats: {
        count: 1100,
        loose: 20,
        sizeKb: 4800,
      },
      get_pack_info: {
        packCount: 4,
        packSizeKb: 4600,
      },
    });

    // Click GC to trigger maintenance
    const gcButton = healthDialog.locator('.action-btn', { hasText: /Garbage Collection/i }).first();
    await expect(gcButton).toBeVisible();
    await gcButton.click();

    // Wait for the GC command and subsequent stats refresh
    await waitForCommand(page, 'run_gc');
    await waitForCommand(page, 'get_repository_stats');

    // Verify get_repository_stats was called to refresh stats after GC
    const statsCommands = await findCommand(page, 'get_repository_stats');
    expect(statsCommands.length).toBeGreaterThan(0);

    // The dialog should still be open showing updated stats
    await expect(healthDialog).toBeVisible();
  });
});
