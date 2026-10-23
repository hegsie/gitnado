import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  injectCommandError,
  findCommand,
  waitForCommand,
} from '../fixtures/test-helpers';

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

// =========================================================================
// Settings Dialog — External Tools (merge/diff tool config writes)
//
// setMergeToolConfig / setDiffTool return a CommandResult rather than throwing,
// so a rejected config write used to leave the control showing a value git
// never accepted, with no feedback at all.
// =========================================================================

const WRITE_ERROR = 'could not lock config file: Permission denied';

function externalToolMocks(): Record<string, unknown> {
  return {
    get_merge_tool_config: { toolName: null, toolCmd: null },
    get_diff_tool: { tool: null, cmd: null, prompt: false },
    get_available_merge_tools: [
      { name: 'meld', displayName: 'Meld', command: 'meld', available: true },
      { name: 'vimdiff', displayName: 'Vimdiff', command: 'vimdiff', available: true },
    ],
    list_diff_tools: [
      { name: 'meld', command: 'meld', available: true },
      { name: 'vimdiff', command: 'vimdiff', available: true },
    ],
    set_merge_tool_config: null,
    set_diff_tool: null,
  };
}

/** The `.setting-row` whose `.setting-name` is exactly `name`. */
function settingRow(page: Page, name: string) {
  return page.locator('gn-settings-dialog .setting-row', {
    has: page.locator('.setting-name', { hasText: new RegExp(`^${name}$`) }),
  });
}

function mergeSelect(page: Page) {
  return settingRow(page, 'Merge Tool').locator('select');
}

function diffSelect(page: Page) {
  return settingRow(page, 'Diff Tool').locator('select');
}

function errorToast(page: Page) {
  return page.locator('gn-toast-container .toast.error .toast-message');
}

/**
 * Park the first `set_merge_tool_config` write until the test releases it as a
 * failure, while every later write succeeds immediately. Lets a slow failure be
 * resolved after a newer save has already landed.
 */
async function gateFirstMergeToolWrite(page: Page): Promise<void> {
  await page.evaluate((msg: string) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    let writes = 0;
    internals.invoke = async (command: string, args?: unknown) => {
      if (command !== 'set_merge_tool_config') return originalInvoke(command, args);
      const captured = (window as unknown as {
        __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
      }).__INVOKED_COMMANDS__;
      if (captured) captured.push({ command, args });
      writes += 1;
      if (writes > 1) return null;
      return new Promise((_resolve, reject) => {
        (window as unknown as { __FAIL_FIRST_MERGE_TOOL_WRITE__?: () => void })
          .__FAIL_FIRST_MERGE_TOOL_WRITE__ = () => reject(new Error(msg));
      });
    };
  }, WRITE_ERROR);
}

/** Fail the parked write and let every queued continuation run. */
async function releaseGatedWrite(page: Page): Promise<void> {
  await page.evaluate(async () => {
    (window as unknown as { __FAIL_FIRST_MERGE_TOOL_WRITE__: () => void })
      .__FAIL_FIRST_MERGE_TOOL_WRITE__();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

test.describe('Settings Dialog — External Tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, externalToolMocks());
  });

  test('saving a merge tool sends set_merge_tool_config and shows no error', async ({ page }) => {
    await openSettings(page);

    const select = mergeSelect(page);
    await expect(select.locator('option[value="meld"]')).toHaveCount(1);
    await select.selectOption('meld');

    await waitForCommand(page, 'set_merge_tool_config');
    const calls = await findCommand(page, 'set_merge_tool_config');
    expect(calls[0].args).toMatchObject({ toolName: 'meld' });

    await expect(select).toHaveValue('meld');
    await expect(errorToast(page)).toHaveCount(0);
  });

  test('a failed merge tool write shows an error toast and leaves the select on None', async ({ page }) => {
    await injectCommandError(page, 'set_merge_tool_config', WRITE_ERROR);
    await openSettings(page);

    const select = mergeSelect(page);
    await expect(select.locator('option[value="meld"]')).toHaveCount(1);
    await select.selectOption('meld');

    await expect(errorToast(page)).toContainText('Failed to save merge tool');
    await expect(errorToast(page)).toContainText('Permission denied');
    await expect(select).toHaveValue('');
  });

  test('a slow failed merge tool write does not roll back a newer save that landed', async ({ page }) => {
    await openSettings(page);
    const select = mergeSelect(page);
    await expect(select.locator('option[value="meld"]')).toHaveCount(1);

    await gateFirstMergeToolWrite(page);

    // First save hangs...
    await select.selectOption('meld');
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __FAIL_FIRST_MERGE_TOOL_WRITE__?: () => void })
          .__FAIL_FIRST_MERGE_TOOL_WRITE__,
    );

    // ...while the user picks another tool, which saves straight away.
    await select.selectOption('vimdiff');
    await expect(select).toHaveValue('vimdiff');

    await releaseGatedWrite(page);

    await expect(select, 'the newer saved tool survives').toHaveValue('vimdiff');
    await expect(errorToast(page)).toHaveCount(0);
  });

  test('a failed custom diff tool command shows an error toast', async ({ page }) => {
    await injectCommandError(page, 'set_diff_tool', WRITE_ERROR);
    await openSettings(page);

    const select = diffSelect(page);
    await expect(select.locator('option[value="__custom__"]')).toHaveCount(1);
    await select.selectOption('__custom__');

    const cmdInput = settingRow(page, 'Diff Tool Command').locator('input');
    await expect(cmdInput).toBeVisible();
    await cmdInput.fill('/usr/bin/meld $LOCAL $REMOTE');
    await cmdInput.blur();

    await expect(errorToast(page)).toContainText('Failed to save diff tool command');
    await expect(cmdInput).toHaveValue('');
  });
});

// =========================================================================
// Settings — clearing the external merge/diff tool ("None")
//
// Choosing "None" must actually unset merge.tool / diff.tool in the
// repository config, or git (and the app's own launch-tool flows) keep using
// the old tool and reopening Settings silently reverts the user's choice.
// =========================================================================

const NONE_REPO_PATH = '/tmp/test-repo';

const NONE_TOOL_MOCKS = {
  get_merge_tool_config: { toolName: 'meld', toolCmd: null },
  get_available_merge_tools: [{ name: 'meld', displayName: 'Meld', available: true }],
  get_diff_tool: { tool: 'vscode', cmd: null, prompt: false },
  list_diff_tools: [{ name: 'vscode', command: 'code', available: true }],
  set_merge_tool_config: null,
  set_diff_tool: null,
  unset_git_config: null,
};

/**
 * Serve the merge/diff tool config from mutable state so `unset_git_config`
 * behaves like the backend: `git config --unset` writes the repository-local
 * file only, so a tool configured globally survives the unset while the get_*
 * commands keep reporting the effective value.
 */
async function installToolConfigState(
  page: Page,
  scopes: { merge: 'local' | 'global'; diff: 'local' | 'global' },
): Promise<void> {
  await page.evaluate((s) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    const state: { merge: string | null; diff: string | null } = {
      merge: 'meld',
      diff: 'vscode',
    };

    internals.invoke = async (command: string, args?: unknown) => {
      if (command === 'get_merge_tool_config') {
        return { toolName: state.merge, toolCmd: null };
      }
      if (command === 'get_diff_tool') {
        return { tool: state.diff, cmd: null, prompt: false };
      }
      const result = await originalInvoke(command, args);
      if (command === 'unset_git_config') {
        const key = (args as { key?: string } | undefined)?.key;
        if (key === 'merge.tool' && s.merge === 'local') state.merge = null;
        if (key === 'diff.tool' && s.diff === 'local') state.diff = null;
      }
      return result;
    };
  }, scopes);
}

function toolSelect(page: Page, label: 'Merge Tool' | 'Diff Tool'): Locator {
  return page.locator(`gn-settings-dialog .setting-row:has-text("${label}") select`).first();
}

async function unsetArgs(page: Page): Promise<Array<{ key?: string; path?: string }>> {
  const cmds = await findCommand(page, 'unset_git_config');
  return cmds.map((c) => c.args as { key?: string; path?: string });
}

test.describe('Settings - clearing the external merge/diff tool', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, NONE_TOOL_MOCKS);
  });

  test('shows the configured tools as selected when Settings opens', async ({ page }) => {
    await openSettings(page);

    // The <select>'s .value binding commits before the <option>s rendered in the
    // same Lit update, so without a re-sync a configured tool renders as "None".
    await expect(toolSelect(page, 'Merge Tool')).toHaveValue('meld');
    await expect(toolSelect(page, 'Diff Tool')).toHaveValue('vscode');
  });

  test('clearing the merge tool from Settings unsets merge.tool', async ({ page }) => {
    await installToolConfigState(page, { merge: 'local', diff: 'local' });
    await openSettings(page);
    const select = toolSelect(page, 'Merge Tool');
    await expect(select).toHaveValue('meld');

    await select.selectOption('');

    await expect
      .poll(() => unsetArgs(page))
      .toContainEqual(expect.objectContaining({ key: 'merge.tool', path: NONE_REPO_PATH }));
    await expect(select).toHaveValue('');
  });

  test('clearing the diff tool from Settings unsets diff.tool', async ({ page }) => {
    await installToolConfigState(page, { merge: 'local', diff: 'local' });
    await openSettings(page);
    const select = toolSelect(page, 'Diff Tool');
    await expect(select).toHaveValue('vscode');

    await select.selectOption('');

    await expect
      .poll(() => unsetArgs(page))
      .toContainEqual(expect.objectContaining({ key: 'diff.tool', path: NONE_REPO_PATH }));
    await expect(select).toHaveValue('');
  });

  test('surfaces an error and keeps the tool selected when the unset fails', async ({ page }) => {
    await installToolConfigState(page, { merge: 'local', diff: 'local' });
    await injectCommandError(page, 'unset_git_config', 'error: could not unset merge.tool');
    await openSettings(page);
    const select = toolSelect(page, 'Merge Tool');
    await expect(select).toHaveValue('meld');

    await select.selectOption('');

    await expect(page.locator('.toast.error, .error-banner').first()).toBeVisible();
    // The config still names Meld, so the select must not sit on "None".
    await expect(select).toHaveValue('meld');
  });

  test('keeps the tool selected when merge.tool is configured outside the repository', async ({
    page,
  }) => {
    await installToolConfigState(page, { merge: 'global', diff: 'local' });
    await openSettings(page);
    const select = toolSelect(page, 'Merge Tool');
    await expect(select).toHaveValue('meld');

    await select.selectOption('');

    // The local unset is attempted, but merge.tool survives it, so the UI must
    // say so rather than showing "None" while git still launches Meld.
    await expect
      .poll(() => unsetArgs(page))
      .toContainEqual(expect.objectContaining({ key: 'merge.tool', path: NONE_REPO_PATH }));
    await expect(page.locator('.toast.error, .error-banner').first()).toBeVisible();
    await expect(select).toHaveValue('meld');
  });

  test('clearing the merge tool touches merge.tool only', async ({ page }) => {
    await installToolConfigState(page, { merge: 'local', diff: 'local' });
    await openSettings(page);
    const select = toolSelect(page, 'Merge Tool');
    await expect(select).toHaveValue('meld');
    await select.selectOption('');

    await expect.poll(() => unsetArgs(page)).toHaveLength(1);
    // The custom mergetool.<name>.cmd is left in place: it is inert while no
    // tool is selected and the user may re-select that tool later.
    expect(await unsetArgs(page)).toEqual([
      { path: NONE_REPO_PATH, key: 'merge.tool', global: undefined },
    ]);
    // The diff tool is untouched and stays on its configured value.
    await expect(toolSelect(page, 'Diff Tool')).toHaveValue('vscode');
  });
});
