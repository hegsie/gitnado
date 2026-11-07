import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * E2E tests for MCP client mode: external MCP servers as AI context sources
 * (roadmap 4.2, issue #613).
 */

const jira = {
  id: 'srv1',
  name: 'Jira',
  transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
  enabled: true,
  contextTool: 'get_issue',
  contextArgs: '{"key":"{issueKey}"}',
  hasToken: true,
};

const base = {
  get_mcp_status: { running: false, port: 3001, url: null, lastError: null },
  get_mcp_config: { enabled: false, port: 3001, allowedOrigins: [], authToken: 'tok' },
};

async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

const section = (page: Page) => page.locator('gn-mcp-external-servers');

test.describe('External MCP servers', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('adds an issue-tracker server as an AI context source', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      ...base,
      list_external_mcp_servers: [],
      save_external_mcp_server: jira,
    });
    await openSettings(page);

    await section(page).locator('.add-server-btn').click();
    await section(page).locator('.name-input').fill('Jira');
    await section(page).locator('.url-input').fill('https://mcp.example.com/mcp');
    await section(page).locator('.token-input').fill('jira-token');
    await section(page).locator('.tool-input').fill('get_issue');
    await section(page).locator('.args-template').fill('{"key":"{issueKey}"}');
    await section(page).locator('.save-btn').click();

    await expect(page.locator('.toast.success')).toContainText('Saved Jira');
    const [save] = await findCommand(page, 'save_external_mcp_server');
    expect(save.args).toMatchObject({
      server: { name: 'Jira', transport: { type: 'http', url: 'https://mcp.example.com/mcp' }, contextTool: 'get_issue' },
      token: 'jira-token',
    });
  });

  test('tests a server and previews the context it would add', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      ...base,
      list_external_mcp_servers: [jira],
      list_external_mcp_tools: [{ name: 'get_issue', description: 'Look up an issue' }],
      preview_external_mcp_context: { server: 'Jira', text: 'PROJ-7: Fix the login redirect' },
    });
    await openSettings(page);

    await section(page).locator('.test-btn').click();
    await expect(section(page).locator('.tools')).toContainText('get_issue');
    await section(page).locator('.preview-btn').click();
    await expect(section(page).locator('.preview')).toContainText('PROJ-7: Fix the login redirect');
    await waitForCommand(page, 'preview_external_mcp_context');
    expect((await findCommand(page, 'preview_external_mcp_context'))[0].args).toEqual({
      id: 'srv1',
      repoPath: '/tmp/test-repo',
    });
  });

  test('a connection failure is reported', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { ...base, list_external_mcp_servers: [jira] });
    await injectCommandError(page, 'list_external_mcp_tools', 'The server refused the connection (HTTP 401)');
    await openSettings(page);

    await section(page).locator('.test-btn').click();

    await expect(page.locator('.toast.error')).toContainText('HTTP 401');
  });

  test('offline mode refuses to contact the server', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { ...base, list_external_mcp_servers: [jira] });
    await page.evaluate(() => {
      const stores = (window as unknown as { __GITNADO_STORES__: { settingsStore: { setState: (s: unknown) => void } } })
        .__GITNADO_STORES__;
      stores.settingsStore.setState({ offlineMode: true });
    });
    await openSettings(page);

    await section(page).locator('.test-btn').click();

    await expect(page.locator('.toast.error')).toContainText('Offline mode is on');
    expect(await findCommand(page, 'list_external_mcp_tools')).toHaveLength(0);
  });
});
