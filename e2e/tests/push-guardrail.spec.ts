import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import {
  emitBackendEvent,
  findCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * Agent guardrails (#609): a push of an agent branch is scanned for secrets
 * first; Settings → Agent Guardrails decides whether a finding warns or blocks.
 */

const branch = (name: string, isHead = false) => ({
  name, shorthand: name, isHead, isRemote: false, upstream: null, targetOid: `${name}-oid`, isStale: false,
});

const LEAK = {
  branch: 'agent/fix-login',
  commits: 2,
  findings: [{ category: 'secret', severity: 'error', message: 'Possible AWS Access Key ID detected', filePath: 'config/aws.env' }],
  riskLevel: 'high',
  truncated: false,
};

async function openOn(page: Page, head: string): Promise<void> {
  await setupOpenRepository(page, { branches: [branch('main', head === 'main'), branch(head, true)].filter((b, i, all) => all.findIndex((x) => x.name === b.name) === i) });
  await startCommandCaptureWithMocks(page, { push: null, scan_outgoing_changes: LEAK });
}

async function chooseGuardrail(page: Page, app: AppPage, mode: 'off' | 'warn' | 'block'): Promise<void> {
  await app.openSettings();
  await app.settingsDialog.locator('#push-guardrail-select').selectOption(mode);
  await page.keyboard.press('Escape');
  await expect(app.settingsDialog.locator('#push-guardrail-select')).toBeHidden();
}

const push = (page: Page) => emitBackendEvent(page, 'app-menu-action', 'push');

test.describe('Push guardrail', () => {
  test('warns by default on an agent branch and pushes once confirmed', async ({ page }) => {
    await openOn(page, 'agent/fix-login');
    await injectCommandMock(page, { 'plugin:dialog|message': 'Ok' });
    await push(page);

    await waitForCommand(page, 'push');
    const scan = await findCommand(page, 'scan_outgoing_changes');
    expect(scan[0].args).toMatchObject({ branch: 'agent/fix-login' });
    const confirm = await findCommand(page, 'plugin:dialog|message');
    expect(JSON.stringify(confirm[0].args)).toContain('Possible AWS Access Key ID detected (config/aws.env)');
  });

  test('a declined warning keeps the commits local', async ({ page }) => {
    await openOn(page, 'agent/fix-login');
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });
    await push(page);
    await waitForCommand(page, 'plugin:dialog|message');
    await expect.poll(async () => (await findCommand(page, 'scan_outgoing_changes')).length).toBe(1);
    expect(await findCommand(page, 'push')).toHaveLength(0);
  });

  test('Block (set in Settings) refuses the push and says why', async ({ page }) => {
    const app = new AppPage(page);
    await openOn(page, 'agent/fix-login');
    await chooseGuardrail(page, app, 'block');
    await push(page);

    await expect(page.locator('.toast.error', { hasText: 'Push blocked: 1 possible secret in agent/fix-login' })).toBeVisible();
    expect(await findCommand(page, 'push')).toHaveLength(0);
  });

  test('a person\'s own branch is not scanned under the default agent-only scope', async ({ page }) => {
    await openOn(page, 'main');
    await push(page);
    await waitForCommand(page, 'push');
    expect(await findCommand(page, 'scan_outgoing_changes')).toHaveLength(0);
  });

  test('Off (set in Settings) pushes without scanning', async ({ page }) => {
    const app = new AppPage(page);
    await openOn(page, 'agent/fix-login');
    await chooseGuardrail(page, app, 'off');
    await push(page);
    await waitForCommand(page, 'push');
    expect(await findCommand(page, 'scan_outgoing_changes')).toHaveLength(0);
  });

  test('a scan failure under Block is reported and nothing is pushed', async ({ page }) => {
    const app = new AppPage(page);
    await openOn(page, 'agent/fix-login');
    await chooseGuardrail(page, app, 'block');
    await injectCommandError(page, 'scan_outgoing_changes', 'git exited 128');
    await push(page);
    await expect(page.locator('.toast.error', { hasText: 'the guardrail could not scan agent/fix-login (git exited 128)' })).toBeVisible();
    expect(await findCommand(page, 'push')).toHaveLength(0);
  });
});
