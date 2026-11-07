import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  emitBackendEvent,
  waitForRepositoryChanged,
} from '../fixtures/test-helpers';

/**
 * E2E tests for MCP write tools behind a consent gate (roadmap 4.2, issue #610).
 *
 * The backend emits `mcp-consent-request` when an agent asks to write and
 * waits for `respond_mcp_consent`; applied writes arrive as `mcp-write-applied`.
 */

const request = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  tool: 'commit',
  repoPath: '/tmp/test-repo',
  branch: 'agent/fix-login',
  summary: 'Commit 2 staged files on agent/fix-login',
  details: ['Message: Fix login redirect', '  src/login.ts', '  src/router.ts'],
  requestedAt: 0,
  timeoutSecs: 120,
  ...extra,
});

const consent = (page: Page) => page.locator('gn-mcp-consent-dialog');

async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

test.describe('MCP write tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('an agent write request is shown and can be approved', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [], respond_mcp_consent: null });

    await emitBackendEvent(page, 'mcp-consent-request', request(1));

    await expect(consent(page).locator('.summary')).toHaveText('Commit 2 staged files on agent/fix-login');
    await expect(consent(page).locator('.details')).toContainText('src/router.ts');
    await consent(page).locator('.approve-btn').click();

    await waitForCommand(page, 'respond_mcp_consent');
    expect((await findCommand(page, 'respond_mcp_consent'))[0].args).toEqual({
      id: 1,
      approve: true,
    });
    await expect(consent(page).locator('.summary')).toHaveCount(0);
  });

  test('approving with "always allow" saves a branch pattern', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [], respond_mcp_consent: null });
    await emitBackendEvent(page, 'mcp-consent-request', request(2));

    await consent(page).locator('.remember-check').check();
    await consent(page).locator('.pattern-input').fill('agent/*');
    await consent(page).locator('.approve-btn').click();

    await waitForCommand(page, 'respond_mcp_consent');
    expect((await findCommand(page, 'respond_mcp_consent'))[0].args).toEqual({
      id: 2,
      approve: true,
      alwaysAllowPattern: 'agent/*',
    });
  });

  test('denying tells the user and answers the agent', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [], respond_mcp_consent: null });
    await emitBackendEvent(page, 'mcp-consent-request', request(3));

    await consent(page).locator('.deny-btn').click();

    await expect(page.locator('.toast')).toContainText('Declined: Commit 2 staged files');
    expect((await findCommand(page, 'respond_mcp_consent'))[0].args).toMatchObject({ id: 3, approve: false });
  });

  test('an expired request is removed with a warning', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [] });
    await emitBackendEvent(page, 'mcp-consent-request', request(4));
    await expect(consent(page).locator('.summary')).toBeVisible();

    await emitBackendEvent(page, 'mcp-consent-resolved', { id: 4, approved: false, expired: true });

    await expect(consent(page).locator('.summary')).toHaveCount(0);
    await expect(page.locator('.toast.warning')).toContainText('expired');
  });

  test('a failed answer is reported', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [] });
    await injectCommandError(page, 'respond_mcp_consent', 'This request is no longer waiting for an answer');
    await emitBackendEvent(page, 'mcp-consent-request', request(5));

    await consent(page).locator('.approve-btn').click();

    await expect(page.locator('.toast.error')).toContainText('no longer waiting');
  });

  test('an applied write is announced and refreshes the repository', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_pending_mcp_consents: [] });

    const refreshed = await waitForRepositoryChanged(page, async () => {
      await emitBackendEvent(page, 'mcp-write-applied', {
        tool: 'create_branch',
        repoPath: '/tmp/test-repo',
        summary: 'Create branch agent/x from HEAD',
        byPolicy: true,
      });
    });

    expect(refreshed).toBe(true);
    await expect(page.locator('.toast')).toContainText('Agent: Create branch agent/x from HEAD (always allowed)');
  });

  test('write tools are turned on from Settings', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_mcp_status: { running: true, port: 3001, url: 'http://127.0.0.1:3001', lastError: null },
      get_mcp_config: { enabled: true, port: 3001, allowedOrigins: [], authToken: 'tok' },
      get_mcp_write_settings: {
        enabled: false,
        policies: [],
      },
      set_mcp_write_settings: null,
      get_pending_mcp_consents: [],
    });
    await openSettings(page);

    const section = page.locator('gn-mcp-write-settings');
    await expect(section).toContainText('Let agents make changes');
    await section.locator('gn-toggle').click();

    await waitForCommand(page, 'set_mcp_write_settings');
    expect((await findCommand(page, 'set_mcp_write_settings'))[0].args).toEqual({
      settings: { enabled: true, policies: [] },
    });
    await expect(section).toContainText('every change asks you first');
  });
});
