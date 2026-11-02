import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * E2E tests for per-client MCP tokens and one-click setup (roadmap 4.2, #612).
 */

const base = {
  get_mcp_status: { running: true, port: 3001, url: 'http://127.0.0.1:3001', lastError: null },
  get_mcp_config: { enabled: true, port: 3001, allowedOrigins: [], authToken: 'tok' },
  get_mcp_write_settings: { enabled: false, policies: [] },
  get_mcp_stdio_command: { program: '/opt/Gitnado/gitnado', args: ['--mcp-stdio'] },
  get_pending_mcp_consents: [],
};

async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

const clients = (page: Page) => page.locator('gn-mcp-clients');

test.describe('MCP client tokens', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('adding a client shows its token once with setup snippets', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      ...base,
      list_mcp_clients: [],
      create_mcp_client: {
        client: { id: 'c1', name: 'Claude Code', createdAt: 0, lastUsedAt: null },
        token: 'gnc_e2e_token',
      },
    });
    await openSettings(page);

    await clients(page).locator('.client-name-input').fill('Claude Code');
    await clients(page).locator('.add-client-btn').click();

    await expect(clients(page).locator('.snippet')).toContainText(
      "claude mcp add --transport http gitnado http://127.0.0.1:3001/mcp --header 'Authorization: Bearer gnc_e2e_token'",
    );
    expect((await findCommand(page, 'create_mcp_client'))[0].args).toEqual({ name: 'Claude Code' });

    await clients(page).locator('.tab[data-kind="cursor"]').click();
    await expect(clients(page).locator('.snippet')).toContainText('"Authorization": "Bearer gnc_e2e_token"');
    await clients(page).locator('.tab[data-kind="stdio"]').click();
    await expect(clients(page).locator('.snippet')).toContainText('/opt/Gitnado/gitnado');

    await clients(page).locator('.done-btn').click();
    await expect(clients(page).locator('.new-token')).toHaveCount(0);
  });

  test('a client can be revoked', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      ...base,
      list_mcp_clients: [{ id: 'c7', name: 'Cursor', createdAt: 0, lastUsedAt: null }],
      revoke_mcp_client: null,
      'plugin:dialog|message': 'Ok',
    });
    await openSettings(page);
    await expect(clients(page).locator('.client')).toContainText('Cursor');

    await clients(page).locator('.revoke-btn').click();

    await waitForCommand(page, 'revoke_mcp_client');
    expect((await findCommand(page, 'revoke_mcp_client'))[0].args).toEqual({ id: 'c7' });
    await expect(page.locator('.toast.success')).toContainText('Revoked Cursor');
  });

  test('a failure to add a client is reported', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { ...base, list_mcp_clients: [] });
    await injectCommandError(page, 'create_mcp_client', 'Failed to save MCP clients: read-only file system');
    await openSettings(page);

    await clients(page).locator('.client-name-input').fill('VS Code');
    await clients(page).locator('.add-client-btn').click();

    await expect(page.locator('.toast.error')).toContainText('read-only file system');
    await expect(clients(page).locator('.new-token')).toHaveCount(0);
  });
});
