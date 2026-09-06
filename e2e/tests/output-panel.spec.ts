import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';

/**
 * E2E tests for the Output Panel (lv-output-panel).
 *
 * The output panel is a singleton log viewer that shows git command executions.
 * It uses a module-level logEntries array and notifies listeners on changes.
 * Entries have: timestamp, command, output, success.
 *
 * The panel shows:
 * - A header with "Output" title, entry count, and Clear button
 * - Expandable entries with status dot, timestamp, and command text
 * - An empty state message when no commands have been logged
 *
 * The component is integrated into the app shell as a toggleable bottom
 * panel ("Toggle Output Panel" in the command palette), fed by the IPC layer
 * (state-changing commands are logged automatically). The describes below
 * still exercise the component surface via direct DOM injection for
 * fine-grained control of entries; the "In-app integration" describe at the
 * bottom covers the real app flow.
 */

/** Inject lv-output-panel into the page */
async function injectOutputPanel(page: import('@playwright/test').Page): Promise<void> {
  // The IPC layer now logs real commands into the singleton store; reset it
  // so these injection tests keep deterministic entry counts.
  await clearEntries(page);

  await page.evaluate(() => {
    const existing = document.querySelector('lv-output-panel');
    if (existing) existing.remove();

    const panel = document.createElement('lv-output-panel');
    panel.style.cssText = 'display: flex; flex-direction: column; width: 600px; height: 400px;';
    document.body.appendChild(panel);
  });
  // Wait for the component to render by checking for a visible element inside it
  await expect(page.locator('lv-output-panel .header-title')).toBeVisible();
}

/** Add log entries via the module's exported function */
async function addLogEntries(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error - dynamic import resolved by Vite at runtime
    import('/src/components/panels/lv-output-panel.ts').then((mod: Record<string, unknown>) => {
      const logFn = mod.logGitCommand as (cmd: string, output: string, success: boolean) => void;
      logFn('git fetch origin', 'Fetching origin\nFrom github.com:test/repo\n * [new branch]      main -> origin/main', true);
      logFn('git pull origin main', 'Already up to date.', true);
      logFn('git push origin main', 'error: failed to push some refs', false);
    });
  });

  await expect(page.locator('lv-output-panel .entry')).toHaveCount(3);
}

/** Add a single failed entry for error-specific tests */
async function addFailedEntry(
  page: import('@playwright/test').Page,
  command: string,
  output: string
): Promise<void> {
  await page.evaluate(
    ({ cmd, out }) => {
      // @ts-expect-error - dynamic import resolved by Vite at runtime
      import('/src/components/panels/lv-output-panel.ts').then((mod: Record<string, unknown>) => {
        const logFn = mod.logGitCommand as (cmd: string, output: string, success: boolean) => void;
        logFn(cmd, out, false);
      });
    },
    { cmd: command, out: output }
  );
}

/** Clear all entries via the module function */
async function clearEntries(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-expect-error - dynamic import resolved by Vite at runtime
    const mod = await import('/src/components/panels/lv-output-panel.ts');
    const clearFn = mod.clearLogEntries as () => void;
    clearFn();
  });
  await expect(page.locator('lv-output-panel .entry')).toHaveCount(0);
}

// --------------------------------------------------------------------------
// Empty State
// --------------------------------------------------------------------------
test.describe('Output Panel - Empty State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await clearEntries(page);
    await injectOutputPanel(page);
  });

  test('should show header with "Output" title', async ({ page }) => {
    await expect(page.locator('lv-output-panel .header-title')).toContainText('Output');
  });

  test('should show "No output yet" when no entries exist', async ({ page }) => {
    await expect(page.locator('lv-output-panel .empty')).toHaveText('No output yet');
  });

  test('should not show Clear button when no entries exist', async ({ page }) => {
    await expect(page.locator('lv-output-panel .clear-btn')).toHaveCount(0);
  });

  test('should not show entry count in header when no entries exist', async ({ page }) => {
    await expect(page.locator('lv-output-panel .entry-count')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// With Entries
// --------------------------------------------------------------------------
test.describe('Output Panel - With Entries', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await clearEntries(page);
    await injectOutputPanel(page);
    await addLogEntries(page);
  });

  test('should show entries after commands are logged', async ({ page }) => {
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(3);
  });

  test('should show entry count in header', async ({ page }) => {
    await expect(page.locator('lv-output-panel .entry-count')).toHaveText('(3)');
  });

  test('each entry should show a timestamp in HH:MM:SS format', async ({ page }) => {
    const timestamps = page.locator('lv-output-panel .entry-timestamp');
    await expect(timestamps).toHaveCount(3);

    for (let i = 0; i < 3; i++) {
      const text = await timestamps.nth(i).textContent();
      expect(text?.trim()).toMatch(/\d{2}:\d{2}:\d{2}/);
    }
  });

  test('each entry should show the command text', async ({ page }) => {
    const commands = page.locator('lv-output-panel .entry-command');
    await expect(commands).toHaveCount(3);

    // Entries are added most recent first (unshift)
    await expect(commands.nth(0)).toHaveText('git push origin main');
    await expect(commands.nth(1)).toHaveText('git pull origin main');
    await expect(commands.nth(2)).toHaveText('git fetch origin');
  });

  test('each entry should show a status dot (success or failure)', async ({ page }) => {
    const statusDots = page.locator('lv-output-panel .status-dot');
    await expect(statusDots).toHaveCount(3);

    // First entry (push) failed
    await expect(page.locator('lv-output-panel .entry').nth(0).locator('.status-dot.failure')).toBeVisible();
    // Second entry (pull) succeeded
    await expect(page.locator('lv-output-panel .entry').nth(1).locator('.status-dot.success')).toBeVisible();
    // Third entry (fetch) succeeded
    await expect(page.locator('lv-output-panel .entry').nth(2).locator('.status-dot.success')).toBeVisible();
  });

  test('failed command should have failure class on command text', async ({ page }) => {
    await expect(
      page.locator('lv-output-panel .entry').nth(0).locator('.entry-command.failure')
    ).toBeVisible();
  });

  test('should show Clear button when entries exist', async ({ page }) => {
    const clearBtn = page.locator('lv-output-panel .clear-btn');
    await expect(clearBtn).toBeVisible();
    await expect(clearBtn).toContainText('Clear');
  });
});

// --------------------------------------------------------------------------
// Entry Expand / Collapse
// --------------------------------------------------------------------------
test.describe('Output Panel - Entry Expansion', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await clearEntries(page);
    await injectOutputPanel(page);
    await addLogEntries(page);
  });

  test('clicking an entry header should expand it to show output', async ({ page }) => {
    // Click the first entry header (the push failure, which has output)
    await page.locator('lv-output-panel .entry-header').first().click();

    await expect(page.locator('lv-output-panel .entry-output')).toBeVisible();
  });

  test('expanded entry should show the correct output text', async ({ page }) => {
    // Expand the first entry (push failure)
    await page.locator('lv-output-panel .entry-header').first().click();

    await expect(page.locator('lv-output-panel .entry-output').first()).toHaveText(
      'error: failed to push some refs'
    );
  });

  test('expanding a success entry should show its output', async ({ page }) => {
    // Click the third entry header (fetch, which succeeded)
    await page.locator('lv-output-panel .entry-header').nth(2).click();

    await expect(page.locator('lv-output-panel .entry-output')).toContainText('Fetching origin');
    await expect(page.locator('lv-output-panel .entry-output')).toContainText(
      'main -> origin/main'
    );
  });

  test('clicking the entry header again should collapse the output', async ({ page }) => {
    const firstHeader = page.locator('lv-output-panel .entry-header').first();

    // Expand
    await firstHeader.click();
    await expect(page.locator('lv-output-panel .entry-output')).toBeVisible();

    // Collapse
    await firstHeader.click();
    await expect(page.locator('lv-output-panel .entry-output')).toHaveCount(0);
  });

  test('expand icon should rotate when entry is expanded', async ({ page }) => {
    // Expand
    await page.locator('lv-output-panel .entry-header').first().click();

    await expect(
      page.locator('lv-output-panel .entry').first().locator('.expand-icon.expanded')
    ).toBeVisible();
  });

  test('expand icon should not be rotated when entry is collapsed', async ({ page }) => {
    const firstHeader = page.locator('lv-output-panel .entry-header').first();

    // Expand then collapse
    await firstHeader.click();
    await expect(
      page.locator('lv-output-panel .entry').first().locator('.expand-icon.expanded')
    ).toBeVisible();

    await firstHeader.click();
    await expect(
      page.locator('lv-output-panel .entry').first().locator('.expand-icon.expanded')
    ).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Clear Functionality
// --------------------------------------------------------------------------
test.describe('Output Panel - Clear', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await clearEntries(page);
    await injectOutputPanel(page);
    await addLogEntries(page);
  });

  test('clicking Clear should remove all entries', async ({ page }) => {
    await page.locator('lv-output-panel .clear-btn').click();

    await expect(page.locator('lv-output-panel .entry')).toHaveCount(0);
  });

  test('should show empty state after clearing', async ({ page }) => {
    await page.locator('lv-output-panel .clear-btn').click();

    await expect(page.locator('lv-output-panel .empty')).toHaveText('No output yet');
  });

  test('Clear button should disappear after clearing', async ({ page }) => {
    await page.locator('lv-output-panel .clear-btn').click();

    await expect(page.locator('lv-output-panel .clear-btn')).toHaveCount(0);
  });

  test('entry count should disappear after clearing', async ({ page }) => {
    await page.locator('lv-output-panel .clear-btn').click();

    await expect(page.locator('lv-output-panel .entry-count')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Error Entry Display
// --------------------------------------------------------------------------
test.describe('Output Panel - Error Entry Display', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await clearEntries(page);
    await injectOutputPanel(page);
  });

  test('failed command should display with failure status dot', async ({ page }) => {
    await addFailedEntry(page, 'git merge feature', 'CONFLICT (content): Merge conflict in file.ts\nAutomatic merge failed; fix conflicts and then commit the result.');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    await expect(page.locator('lv-output-panel .status-dot.failure')).toBeVisible();
    await expect(page.locator('lv-output-panel .status-dot.success')).toHaveCount(0);
  });

  test('failed command text should have failure class', async ({ page }) => {
    await addFailedEntry(page, 'git rebase main', 'error: could not apply abc1234');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    await expect(page.locator('lv-output-panel .entry-command.failure')).toBeVisible();
    await expect(page.locator('lv-output-panel .entry-command.failure')).toHaveText('git rebase main');
  });

  test('expanding a failed entry should show the error output', async ({ page }) => {
    const errorOutput = 'CONFLICT (content): Merge conflict in file.ts\nAutomatic merge failed; fix conflicts and then commit the result.';
    await addFailedEntry(page, 'git merge feature', errorOutput);
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    // Expand the entry
    await page.locator('lv-output-panel .entry-header').click();

    await expect(page.locator('lv-output-panel .entry-output')).toBeVisible();
    await expect(page.locator('lv-output-panel .entry-output')).toContainText('CONFLICT (content)');
    await expect(page.locator('lv-output-panel .entry-output')).toContainText('Automatic merge failed');
  });

  test('multiple failed entries should all show failure styling', async ({ page }) => {
    await addFailedEntry(page, 'git push origin main', 'rejected: non-fast-forward');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    await addFailedEntry(page, 'git pull --rebase', 'error: cannot pull with rebase');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(2);

    await expect(page.locator('lv-output-panel .status-dot.failure')).toHaveCount(2);
    await expect(page.locator('lv-output-panel .entry-command.failure')).toHaveCount(2);
  });

  test('failed entry with empty output should explain the empty row', async ({ page }) => {
    await addFailedEntry(page, 'git checkout nonexistent', '');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    await page.locator('lv-output-panel .entry-header').click();

    // An expanded row is never an unexplained empty box: with nothing captured
    // the panel says so rather than rendering blank.
    await expect(page.locator('lv-output-panel .entry-output.empty-output')).toContainText(
      'Failed with no output'
    );

    // And the expand icon still toggles
    await expect(
      page.locator('lv-output-panel .entry').first().locator('.expand-icon.expanded')
    ).toBeVisible();
  });

  test('failed output is styled distinctly from a successful one', async ({ page }) => {
    await addFailedEntry(page, 'git push origin main', 'error: failed to push some refs');
    await expect(page.locator('lv-output-panel .entry')).toHaveCount(1);

    await page.locator('lv-output-panel .entry-header').click();

    await expect(page.locator('lv-output-panel .entry-output.failure')).toContainText(
      'error: failed to push some refs'
    );
  });
});

// --------------------------------------------------------------------------
// In-app integration (real flow: palette toggle + IPC-fed entries)
// --------------------------------------------------------------------------
test.describe('Output Panel - In-app integration', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('palette toggle shows the panel, git commands appear, close hides it', async ({ page }) => {
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    // Panel hidden by default
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toHaveCount(0);

    await app.executeCommand('Toggle Output Panel');
    await expect(appPanel).toBeVisible();

    // Run a state-changing git command through the real palette flow — the
    // IPC layer logs it into the panel
    await app.executeCommand('Create stash');
    // Stashes are nameable now: the palette entry opens the themed prompt
    // before it reaches the backend.
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('panel probe');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    // The panel shows a READABLE GIT COMMAND, not the IPC name.
    await expect(
      appPanel.locator('.entry-command', { hasText: 'git stash push' }).first()
    ).toContainText('git stash push --include-untracked -m "panel probe"');
    // The IPC name is still there, as secondary detail.
    await expect(appPanel.locator('.entry-ipc').first()).toHaveText('create_stash');

    // Close button hides the panel again
    await appPanel.locator('.close-btn').click();
    await expect(appPanel).toHaveCount(0);
  });

  test('a libgit2-backed operation is marked as an equivalent, with a legend', async ({
    page,
  }) => {
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();

    await app.executeCommand('Create stash');
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('equivalence probe');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    // git2 did the work — the panel must not imply the CLI ran.
    await expect(appPanel.locator('.synth-mark').first()).toBeVisible();
    await expect(appPanel.locator('.entry-command.synthesized').first()).toBeVisible();
    await expect(appPanel.locator('.legend')).toContainText('libgit2');

    // Timing is shown so a slow operation is visible as one.
    await expect(appPanel.locator('.entry-duration').first()).toHaveText(/\d/);
  });


  test('an operation that shells out shows ONE row — the real invocation', async ({
    page,
  }) => {
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    // Model a CLI-backed operation: the backend reports the REAL `git` run on
    // `git-command-executed` while the IPC command is still in flight. The
    // real line carries a flag the synthesised one cannot know about, exactly
    // as a commit signed because of `commit.gpgsign` carries `-S`.
    await page.evaluate((repoPath) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command === 'create_stash') {
          (
            window as unknown as {
              __EMIT_TAURI_EVENT__: (event: string, payload: unknown) => void;
            }
          ).__EMIT_TAURI_EVENT__('git-command-executed', {
            command:
              'git stash push --include-untracked --keep-index -m "cli probe"',
            output: 'Saved working directory and index state',
            success: true,
            durationMs: 120,
            repoPath,
          });
        }
        return originalInvoke(command, args);
      };
    }, '/tmp/test-repo');

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();
    await clearEntries(page);

    await app.executeCommand('Create stash');
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('cli probe');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    // ONE row for one operation — not the real line plus a weaker synthesised
    // twin that omits `--keep-index`.
    const stashRows = appPanel.locator('.entry-command', { hasText: 'git stash push' });
    await expect(stashRows).toHaveCount(1);
    await expect(stashRows.first()).toHaveText(
      'git stash push --include-untracked --keep-index -m "cli probe"'
    );

    // The surviving row is the executed one, so nothing marks it an equivalent.
    await expect(appPanel.locator('.synth-mark')).toHaveCount(0);
    await expect(appPanel.locator('.legend')).toHaveCount(0);
  });

  /**
   * Model the backend of a repository with `commit.gpgsign = true`: the merge
   * itself runs through libgit2, and the merge commit is then made with
   * `git commit -S -m <msg>` (commit_merge_signed in merge.rs) — a DIFFERENT
   * git subcommand from the `git merge` the frontend synthesises — reported on
   * `git-command-executed` while the `merge` IPC call is still in flight.
   */
  async function mergeCommitsThroughSignedCli(
    page: import('@playwright/test').Page,
    outcome: { success: true } | { success: false; error: string }
  ): Promise<void> {
    await page.evaluate(
      ({ repoPath, outcome }) => {
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__;
        const originalInvoke = internals.invoke;
        internals.invoke = async (command: string, args?: unknown) => {
          if (command !== 'merge') return originalInvoke(command, args);
          const sourceRef = (args as { sourceRef?: string } | undefined)?.sourceRef ?? '';
          (
            window as unknown as {
              __EMIT_TAURI_EVENT__: (event: string, payload: unknown) => void;
            }
          ).__EMIT_TAURI_EVENT__('git-command-executed', {
            command: `git commit -S -m "Merge branch '${sourceRef}'"`,
            output: outcome.success
              ? `[main 1a2b3c4] Merge branch '${sourceRef}'`
              : outcome.error,
            success: outcome.success,
            durationMs: 240,
            repoPath,
          });
          if (!outcome.success) {
            throw { code: 'OPERATION_FAILED', message: `Failed to run git commit: ${outcome.error}` };
          }
          return originalInvoke(command, args);
        };
      },
      { repoPath: '/tmp/test-repo', outcome }
    );
  }

  /** Branch list → right-click `name` → "Merge into current branch". */
  async function mergeFromBranchList(
    page: import('@playwright/test').Page,
    name: string
  ): Promise<void> {
    const { LeftPanelPage } = await import('../pages/panels.page');
    const leftPanel = new LeftPanelPage(page);
    await leftPanel.openBranchContextMenu(name);
    const mergeMenuItem = page.locator('.context-menu-item', { hasText: 'Merge into current branch' });
    await expect(mergeMenuItem).toBeVisible();
    await mergeMenuItem.click();
  }

  test('a merge signed because of commit.gpgsign shows ONE row — the real git commit -S', async ({
    page,
  }) => {
    const { AppPage } = await import('../pages/app.page');
    const { autoConfirmDialogs } = await import('../fixtures/test-helpers');
    const app = new AppPage(page);

    await autoConfirmDialogs(page);
    await mergeCommitsThroughSignedCli(page, { success: true });

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();
    await clearEntries(page);

    await mergeFromBranchList(page, 'feature/test');
    await expect(page.locator('.toast', { hasText: 'Merged feature/test' })).toBeVisible();

    // ONE row for one click: the real `git commit -S`, whose subcommand differs
    // from the synthesised `git merge` — not both.
    const realRow = appPanel.locator('.entry-command', { hasText: 'git commit -S' });
    await expect(realRow).toHaveCount(1);
    await expect(realRow.first()).toHaveText(`git commit -S -m "Merge branch 'feature/test'"`);
    await expect(appPanel.locator('.entry-command', { hasText: 'git merge' })).toHaveCount(0);

    // The surviving row is the executed one, so nothing marks it an equivalent.
    await expect(appPanel.locator('.synth-mark')).toHaveCount(0);
    await expect(appPanel.locator('.legend')).toHaveCount(0);
    await expect(appPanel.locator('.status-dot.success')).toHaveCount(1);
  });

  test('a signed merge with no GPG key shows ONE red row, not two', async ({ page }) => {
    const { AppPage } = await import('../pages/app.page');
    const { autoConfirmDialogs } = await import('../fixtures/test-helpers');
    const app = new AppPage(page);

    await autoConfirmDialogs(page);
    await mergeCommitsThroughSignedCli(page, {
      success: false,
      error: 'error: gpg failed to sign the data',
    });

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();
    await clearEntries(page);

    await mergeFromBranchList(page, 'feature/test');
    // The user is told the merge failed...
    await expect(page.locator('.toast', { hasText: 'Merge failed' })).toBeVisible();

    // ...and the panel shows the failure ONCE: the real `git commit -S` row
    // carrying the error, with no second red `≈ git merge` twin beside it.
    await expect(appPanel.locator('.entry')).toHaveCount(1);
    const failedEntry = appPanel
      .locator('.entry')
      .filter({ has: page.locator('.status-dot.failure') })
      .first();
    await expect(failedEntry.locator('.entry-command.failure')).toHaveText(
      `git commit -S -m "Merge branch 'feature/test'"`
    );
    await expect(appPanel.locator('.entry-command', { hasText: 'git merge' })).toHaveCount(0);
    await expect(appPanel.locator('.synth-mark')).toHaveCount(0);

    await failedEntry.locator('.entry-header').click();
    await expect(failedEntry.locator('.entry-output.failure')).toContainText(
      'gpg failed to sign the data'
    );
  });

  test('app plumbing never shows up as a command in the panel', async ({ page }) => {
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();
    await clearEntries(page);

    // Fire the plumbing through the REAL IPC wrapper, exactly as the app does:
    // `sync_app_menu` at startup and on every tab open/close and shortcut
    // rebind, the browse/scan commands from "Add repository", and the search
    // index maintenance that follows a refresh. None is a git operation the
    // user ran, and none has a git line, so each used to leave a bare IPC-name
    // row in every repository's panel on every launch.
    const plumbing = [
      'sync_app_menu',
      'classify_repository_path',
      'scan_for_repositories',
      'cancel_repository_scan',
      'refresh_search_index',
      'build_search_index',
      'drop_search_index',
    ];
    await page.evaluate(async (commands: string[]) => {
      // @ts-expect-error - dynamic import resolved by Vite at runtime
      const mod = await import('/src/services/tauri-api.ts');
      const invokeCommand = mod.invokeCommand as (
        command: string,
        args?: unknown
      ) => Promise<unknown>;
      for (const command of commands) {
        await invokeCommand(command, { path: '/tmp/test-repo' });
      }
    }, plumbing);

    // A real operation still logs, so the assertions below are not vacuous.
    await app.executeCommand('Create stash');
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('plumbing probe');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    await expect(
      appPanel.locator('.entry-command', { hasText: 'git stash push' })
    ).toHaveCount(1);

    // ...and none of the plumbing left a row of its own.
    for (const command of plumbing) {
      await expect(
        appPanel.locator('.entry-command', { hasText: command }),
        command
      ).toHaveCount(0);
    }
  });

  test('a failing operation shows its git line and its error output', async ({ page }) => {
    const { injectCommandError } = await import('../fixtures/test-helpers');
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    await injectCommandError(
      page,
      'create_stash',
      'error: cannot stash: your index contains uncommitted changes',
      'STASH_FAILED'
    );

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();

    await app.executeCommand('Create stash');
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('doomed');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    // The failure is marked, and the git line is still readable
    const failedEntry = appPanel.locator('.entry').filter({ has: page.locator('.status-dot.failure') }).first();
    await expect(failedEntry.locator('.entry-command.failure')).toContainText(
      'git stash push --include-untracked -m doomed'
    );

    // Expanding it shows the backend's error output, styled as an error
    await failedEntry.locator('.entry-header').click();
    await expect(failedEntry.locator('.entry-output.failure')).toContainText(
      'your index contains uncommitted changes'
    );
  });

  test('a credentialed URL in an error is redacted before it reaches the panel', async ({
    page,
  }) => {
    const { injectCommandError } = await import('../fixtures/test-helpers');
    const { AppPage } = await import('../pages/app.page');
    const app = new AppPage(page);

    await injectCommandError(
      page,
      'create_stash',
      'failed talking to https://someone:ghp_0123456789abcdefghij@github.com/o/r.git',
      'AUTH'
    );

    await app.executeCommand('Toggle Output Panel');
    const appPanel = page.locator('lv-app-shell lv-output-panel');
    await expect(appPanel).toBeVisible();

    await app.executeCommand('Create stash');
    const promptInput = page.locator('lv-prompt-dialog .prompt-input');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('leak probe');
    await page.locator('lv-prompt-dialog .btn-primary').click();

    const failedEntry = appPanel.locator('.entry').filter({ has: page.locator('.status-dot.failure') }).first();
    await failedEntry.locator('.entry-header').click();

    const output = failedEntry.locator('.entry-output');
    // The token is gone; the host survives so the entry still says where.
    await expect(output).toContainText('***@github.com/o/r.git');
    await expect(output).not.toContainText('ghp_');
  });
});
