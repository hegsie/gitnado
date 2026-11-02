import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks, initializeRepositoryStore } from '../fixtures/tauri-mock';
import {
  autoConfirmDialogs,
  findCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * Stacked pull requests: "Sync PRs" on a stack opens or updates one request
 * per level, each based on the branch below it, with a stack table in each.
 * Provider mocks go in before the repository opens because detection is
 * cached per repository (see pull-request-sidebar.spec.ts).
 */

const branch = (name: string, isHead = false, upstream: string | null = `origin/${name}`) => ({
  name, shorthand: name, isHead, isRemote: false, upstream, targetOid: `${name}-oid`, isStale: false,
});
const BRANCHES = [branch('main', true), branch('feat-a'), branch('feat-b')];
const entry = (name: string, parent: string, depth: number) => ({
  name, parent, depth, ahead: 1, behind: 0, isHead: false, parentMissing: false,
});
const STACKS = [{ base: 'main', branches: [entry('feat-a', 'main', 1), entry('feat-b', 'feat-a', 2)] }];

const pr = (number: number, headRef: string, baseRef: string) => ({
  number, title: `PR ${number}`, state: 'open',
  user: { login: 'octocat', id: 1, avatarUrl: '', name: 'Octo Cat', email: null },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', mergedAt: null,
  headRef, headSha: 'x', baseRef, draft: false, mergeable: true,
  htmlUrl: `https://github.com/octo/gitnado/pull/${number}`, additions: 0, deletions: 0, changedFiles: 0,
});

async function openStackOnGitHub(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await setupTauriMocks(page, { branches: BRANCHES });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await startCommandCaptureWithMocks(page, {
    detect_github_repo: { owner: 'octo', repo: 'gitnado', remoteName: 'origin' },
    get_keyring_token: 'gh-token',
    get_stacks: STACKS,
    get_commit: { summary: 'Add feature B' },
    list_pull_requests: [pr(11, 'feat-a', 'main')],
    create_pull_request: pr(12, 'feat-b', 'feat-a'),
    get_pull_request: { ...pr(11, 'feat-a', 'main'), body: 'Author notes' },
    update_pull_request: null,
    ...overrides,
  });
  await autoConfirmDialogs(page);
  await initializeRepositoryStore(page, { branches: BRANCHES });
}

const syncButton = (page: Page) => page.locator('gn-branch-list .sync-prs-btn');

test.describe('Stacked pull requests', () => {
  test('opens the missing PR on its parent and writes the stack table into every PR', async ({ page }) => {
    await openStackOnGitHub(page);
    await expect(syncButton(page)).toHaveText('Sync PRs');
    await syncButton(page).click();

    await expect(page.locator('.toast', { hasText: 'Stack pull requests: created 1 pull request, updated 1 pull request' })).toBeVisible();

    const created = await findCommand(page, 'create_pull_request');
    expect(created).toHaveLength(1);
    expect(created[0].args).toMatchObject({
      owner: 'octo', repo: 'gitnado',
      input: { head: 'feat-b', base: 'feat-a', title: 'Add feature B' },
    });

    const updates = await findCommand(page, 'update_pull_request');
    expect(updates.map((u) => (u.args as { number: number }).number).sort()).toEqual([11, 12]);
    const body11 = (updates.find((u) => (u.args as { number: number }).number === 11)!.args as { input: { body: string } }).input.body;
    expect(body11.startsWith('Author notes')).toBe(true);
    expect(body11).toContain('[#12](https://github.com/octo/gitnado/pull/12) `feat-b`');
    expect(body11).toContain('`feat-a` ← this one');

    const confirm = await findCommand(page, 'plugin:dialog|message');
    expect(JSON.stringify(confirm[0].args)).toContain('feat-b: open a pull request into feat-a');
  });

  test('retargets a PR whose base no longer matches the stack', async ({ page }) => {
    await openStackOnGitHub(page, {
      list_pull_requests: [pr(11, 'feat-a', 'main'), pr(12, 'feat-b', 'main')],
    });
    await syncButton(page).click();
    await expect(page.locator('.toast', { hasText: 'retargeted 1 pull request' })).toBeVisible();
    const updates = await findCommand(page, 'update_pull_request');
    const retarget = updates.find((u) => (u.args as { number: number }).number === 12)!;
    expect((retarget.args as { input: { base?: string } }).input.base).toBe('feat-a');
    expect(await findCommand(page, 'create_pull_request')).toHaveLength(0);
  });

  test('reports a per-branch failure', async ({ page }) => {
    await openStackOnGitHub(page);
    await injectCommandError(page, 'create_pull_request', 'Validation Failed: head branch not found');
    await syncButton(page).click();
    await expect(page.locator('.toast', { hasText: 'failed: feat-b: Validation Failed: head branch not found' })).toBeVisible();
  });

  test('asks for an account when none is connected', async ({ page }) => {
    await openStackOnGitHub(page);
    await injectCommandMock(page, { get_keyring_token: null });
    await syncButton(page).click();
    await expect(page.locator('.toast', { hasText: 'Connect a GitHub account to sync pull requests' })).toBeVisible();
    await waitForCommand(page, 'get_keyring_token');
    expect(await findCommand(page, 'list_pull_requests')).toHaveLength(0);
  });
});
