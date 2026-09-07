import type { Page } from '@playwright/test';

/**
 * Shared test helpers for E2E tests.
 * Eliminates repetitive boilerplate for command capture, event waiting, and dialog navigation.
 */

/**
 * Start recording all Tauri invoke calls.
 * Must be called before the actions you want to capture.
 */
export async function startCommandCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const originalInvoke = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke;

    (window as unknown as {
      __INVOKED_COMMANDS__: { command: string; args: unknown }[];
    }).__INVOKED_COMMANDS__ = [];

    (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
      (window as unknown as { __INVOKED_COMMANDS__: { command: string; args: unknown }[] })
        .__INVOKED_COMMANDS__.push({ command, args });
      return originalInvoke(command, args);
    };
  });
}

/**
 * Get all captured commands since startCommandCapture was called.
 */
export async function getCapturedCommands(
  page: Page
): Promise<Array<{ command: string; args?: unknown }>> {
  return page.evaluate(() => {
    return (
      (window as unknown as { __INVOKED_COMMANDS__?: { command: string; args: unknown }[] })
        .__INVOKED_COMMANDS__ || []
    );
  });
}

/**
 * Find captured commands by name.
 */
export async function findCommand(
  page: Page,
  commandName: string
): Promise<Array<{ command: string; args?: unknown }>> {
  const commands = await getCapturedCommands(page);
  return commands.filter((c) => c.command === commandName);
}

/**
 * Wait for a repository-changed event to fire during an action.
 * Returns true if the event was received within timeout, false otherwise.
 */
export async function waitForRepositoryChanged(
  page: Page,
  action: () => Promise<void>,
  timeout = 3000
): Promise<boolean> {
  // Two signals mean "the app refreshed for this repo": `repository-changed`,
  // which sidebar components bubble to their host, and the `repository-refresh`
  // window event app-shell's own handleRefresh() dispatches. Operations driven
  // by an app-shell-owned dialog produce only the second. Accept either.
  const eventPromise = page.evaluate((ms: number) => {
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        document.removeEventListener('repository-changed', done);
        window.removeEventListener('repository-refresh', done);
        resolve(true);
      };
      document.addEventListener('repository-changed', done, { once: true });
      window.addEventListener('repository-refresh', done, { once: true });
      setTimeout(() => resolve(false), ms);
    });
  }, timeout);

  await action();

  return eventPromise;
}

/**
 * Override a specific Tauri command to throw an error.
 * Call this after setupOpenRepository to inject error behavior for specific commands.
 *
 * Pass `code` to reproduce a Rust error the frontend branches on: commands
 * that fail in the backend reject with `{ code, message }`, not an Error, and
 * a plain Error reaches the app as the generic COMMAND_ERROR code.
 */
export async function injectCommandError(
  page: Page,
  command: string,
  message: string,
  code?: string
): Promise<void> {
  await page.evaluate(
    ({ cmd, msg, errCode }) => {
      const originalInvoke = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke;

      (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
        if (command === cmd) {
          // Record the command for waitForCommand/findCommand if capture is active
          const captured = (window as unknown as { __INVOKED_COMMANDS__?: { command: string; args: unknown }[] })
            .__INVOKED_COMMANDS__;
          if (captured) {
            captured.push({ command, args });
          }
          if (errCode) throw { code: errCode, message: msg };
          throw new Error(msg);
        }
        return originalInvoke(command, args);
      };
    },
    { cmd: command, msg: message, errCode: code }
  );
}

/**
 * Override multiple Tauri commands to return custom responses.
 * Useful for mocking specific commands within a test.
 */
export async function injectCommandMock(
  page: Page,
  overrides: Record<string, unknown>
): Promise<void> {
  await page.evaluate((mocks) => {
    const originalInvoke = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke;

    (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
      // plugin-dialog 2.7 implements confirm()/ask() by invoking the `message`
      // command and comparing the resolved button label. Translate legacy
      // boolean confirm/ask mocks to the matching label so specs keep working.
      if (command === 'plugin:dialog|message' && !('plugin:dialog|message' in mocks)) {
        const buttons = (args as { buttons?: unknown } | undefined)?.buttons;
        const yesNo = buttons === 'YesNo';
        const legacyKey = yesNo ? 'plugin:dialog|ask' : 'plugin:dialog|confirm';
        if (legacyKey in mocks) {
          const captured = (window as unknown as { __INVOKED_COMMANDS__?: { command: string; args: unknown }[] })
            .__INVOKED_COMMANDS__;
          if (captured) {
            captured.push({ command, args });
          }
          const affirmative = mocks[legacyKey] !== false;
          return yesNo ? (affirmative ? 'Yes' : 'No') : (affirmative ? 'Ok' : 'Cancel');
        }
      }
      if (command in mocks) {
        // Record the command for waitForCommand/findCommand if capture is active,
        // since we short-circuit and don't call originalInvoke which may have its own recording
        const captured = (window as unknown as { __INVOKED_COMMANDS__?: { command: string; args: unknown }[] })
          .__INVOKED_COMMANDS__;
        if (captured) {
          captured.push({ command, args });
        }
        const val = mocks[command];
        if (val instanceof Error || (typeof val === 'object' && val !== null && '__error__' in val)) {
          throw new Error(
            typeof val === 'object' && val !== null && '__error__' in val
              ? (val as { __error__: string }).__error__
              : (val as Error).message
          );
        }
        return val;
      }
      return originalInvoke(command, args);
    };
  }, overrides);
}

/**
 * Make a command hang forever, so the caller stays in its "in flight" state
 * for the rest of the test. Use this to exercise mid-operation guards — the
 * affordances a component must refuse while a destructive command is running.
 */
export async function injectCommandHang(page: Page, command: string): Promise<void> {
  await page.evaluate((cmd) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;

    internals.invoke = (c: string, args?: unknown) => {
      if (c === cmd) {
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) {
          captured.push({ command: c, args });
        }
        return new Promise<unknown>(() => {});
      }
      return originalInvoke(c, args);
    };
  }, command);
}

/**
 * Wait for a specific Tauri command to be invoked.
 * Useful when you need to wait for an async action to trigger a backend call.
 */
export async function waitForCommand(
  page: Page,
  commandName: string,
  timeout = 5000
): Promise<void> {
  await page.waitForFunction(
    (cmd) =>
      (window as unknown as { __INVOKED_COMMANDS__?: { command: string }[] })
        .__INVOKED_COMMANDS__?.some((c) => c.command === cmd),
    commandName,
    { timeout }
  );
}

/**
 * Auto-confirm all native dialog prompts (confirm/ask).
 */
export async function autoConfirmDialogs(page: Page): Promise<void> {
  await injectCommandMock(page, {
    'plugin:dialog|confirm': true,
    'plugin:dialog|ask': true,
    // plugin-dialog 2.x routes confirm() through `message` and resolves true
    // only when the command returns the OK button label. Without this, every
    // showConfirm() in the app reads as "declined" under test.
    'plugin:dialog|message': 'Ok',
  });
}

/**
 * Open a dialog via the command palette.
 */
export async function openViaCommandPalette(page: Page, commandName: string): Promise<void> {
  await page.keyboard.press('Meta+p');
  await page.locator('lv-command-palette[open]').waitFor({ state: 'visible' });
  await page.locator('lv-command-palette[open] .search-input').fill(commandName);
  await page.locator('lv-command-palette[open] .command').first().waitFor({ state: 'visible' });
  await page.keyboard.press('Enter');
}

/**
 * Start command capture with mock overrides combined.
 * Captures all commands AND overrides specific ones.
 */
export async function startCommandCaptureWithMocks(
  page: Page,
  overrides: Record<string, unknown>
): Promise<void> {
  await page.evaluate((mocks) => {
    const originalInvoke = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke;

    (window as unknown as {
      __INVOKED_COMMANDS__: { command: string; args: unknown }[];
    }).__INVOKED_COMMANDS__ = [];

    (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__.invoke = async (command: string, args?: unknown) => {
      (window as unknown as { __INVOKED_COMMANDS__: { command: string; args: unknown }[] })
        .__INVOKED_COMMANDS__.push({ command, args });

      // plugin-dialog 2.7 implements confirm()/ask() by invoking the `message`
      // command and comparing the resolved button label. Translate legacy
      // boolean confirm/ask mocks to the matching label so specs keep working.
      if (command === 'plugin:dialog|message' && !('plugin:dialog|message' in mocks)) {
        const buttons = (args as { buttons?: unknown } | undefined)?.buttons;
        const yesNo = buttons === 'YesNo';
        const legacyKey = yesNo ? 'plugin:dialog|ask' : 'plugin:dialog|confirm';
        if (legacyKey in mocks) {
          const affirmative = mocks[legacyKey] !== false;
          return yesNo ? (affirmative ? 'Yes' : 'No') : (affirmative ? 'Ok' : 'Cancel');
        }
      }

      if (command in mocks) {
        const val = mocks[command];
        if (typeof val === 'object' && val !== null && '__error__' in val) {
          throw new Error((val as { __error__: string }).__error__);
        }
        return val;
      }
      return originalInvoke(command, args);
    };
  }, overrides);
}

/**
 * Deliver a backend Tauri event to every listener the app registered.
 *
 * Backend-driven flows (e.g. a model download that fails minutes after the
 * command returned) can only be exercised by emitting the event the Rust side
 * would emit. Requires the mock installed by `setupTauriMocks`.
 */
export async function emitBackendEvent(
  page: Page,
  event: string,
  payload: unknown
): Promise<void> {
  await page.evaluate(
    ({ event: name, payload: data }) => {
      const emit = (window as unknown as {
        __EMIT_TAURI_EVENT__?: (event: string, payload: unknown) => void;
      }).__EMIT_TAURI_EVENT__;
      if (!emit) throw new Error('Tauri event mock is not installed');
      emit(name, data);
    },
    { event, payload }
  );
}

/**
 * Open one of app-shell's dialogs/views through the dialog store.
 *
 * A few specs need a pane on screen that has no reachable UI affordance in a
 * mocked run (file history and blame are opened from a context menu that needs
 * a real commit selection). They used to set app-shell's `show*` properties
 * directly; those live in the dialog store now, so this goes through the store
 * the app itself uses. Prefer a real user gesture where one exists.
 */
export async function openAppDialog(
  page: Page,
  id: string,
  context?: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    ({ id: dialogId, context: ctx }) => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        dialogStore: {
          getState: () => { open: (id: string, context?: unknown) => void };
        };
      };
      if (!stores?.dialogStore) throw new Error('dialog store is not exposed');
      stores.dialogStore.getState().open(dialogId, ctx);
    },
    { id, context }
  );
}

/** Whether one of app-shell's dialogs/views is currently open. */
export async function isAppDialogOpen(page: Page, id: string): Promise<boolean> {
  return page.evaluate((dialogId) => {
    const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
      dialogStore: { getState: () => { isOpen: (id: string) => boolean } };
    };
    if (!stores?.dialogStore) throw new Error('dialog store is not exposed');
    return stores.dialogStore.getState().isOpen(dialogId);
  }, id);
}
