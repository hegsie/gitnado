/**
 * Feedback for the command palette's "open file in editor" action.
 *
 * The handler wrapped gitService.openInConfiguredEditor in a try/catch, but
 * invokeCommand never throws — it resolves to {success:false} — so the catch
 * was dead code and neither result.success nor the payload's own OpenResult
 * success flag was inspected. A file deleted since the palette listed it, an
 * editor command that cannot be spawned, or no editor at all closed the
 * palette and produced no feedback whatsoever.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};
/** Commands that should reject, and with what. */
const failures: Record<string, { code?: string; message: string }> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    if (failures[command]) return Promise.reject(failures[command]);
    const handler = mockResponses[command];
    return Promise.resolve(handler ? handler(args || {}) : null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';

function mockRepo(path: string, name: string): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('app-shell command palette: open file in editor', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    for (const k of Object.keys(failures)) delete failures[k];
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  function shellOnRepo(): AppShell {
    const el = document.createElement('gn-app-shell') as AppShell;
    (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };
    return el;
  }

  async function openFile(el: AppShell, path: string): Promise<void> {
    await (el as any).handleOpenFileFromPalette(
      new CustomEvent('open-file', {
        detail: { path, repositoryPath: '/repo/one' },
      }),
    );
  }

  function errorToasts(): Array<{ message: string; type: string }> {
    return uiStore
      .getState()
      .toasts.filter((t) => t.type === 'error') as Array<{ message: string; type: string }>;
  }

  it('a successful open in the configured editor produces no error toast', async () => {
    mockResponses['open_in_configured_editor'] = () => ({
      success: true,
      message: 'Opened in code',
    });

    const el = shellOnRepo();
    await openFile(el, 'src/main.rs');

    const call = invokeCallArgs.find((c) => c.command === 'open_in_configured_editor');
    expect(call, 'the editor command should be invoked').to.exist;
    expect(call!.args.path).to.equal('/repo/one');
    expect(call!.args.filePath).to.equal('src/main.rs');
    expect(errorToasts()).to.have.lengthOf(0);
  });

  it('a rejected open_in_configured_editor surfaces the backend reason', async () => {
    failures['open_in_configured_editor'] = {
      code: 'INVALID_PATH',
      message: 'Invalid path: src/gone.rs',
    };

    const el = shellOnRepo();
    await openFile(el, 'src/gone.rs');

    const errors = errorToasts();
    expect(errors, 'a missing file must not fail silently').to.have.lengthOf(1);
    expect(errors[0].message).to.contain('src/gone.rs');
  });

  it('an editor that fails to spawn is reported, not swallowed', async () => {
    failures['open_in_configured_editor'] = {
      code: 'COMMAND_ERROR',
      message: "Failed to open editor 'nope': No such file or directory",
    };

    const el = shellOnRepo();
    await openFile(el, 'src/main.rs');

    const errors = errorToasts();
    expect(errors, 'an unlaunchable editor must not fail silently').to.have.lengthOf(1);
    expect(errors[0].message).to.contain("Failed to open editor 'nope'");
  });

  it('a payload that reports failure is reported even though the command resolved', async () => {
    mockResponses['open_in_configured_editor'] = () => ({
      success: false,
      message: 'No editor configured',
    });

    const el = shellOnRepo();
    await openFile(el, 'src/main.rs');

    const errors = errorToasts();
    expect(errors, 'OpenResult.success === false must be reported').to.have.lengthOf(1);
    expect(errors[0].message).to.contain('No editor configured');
  });

  it('with no repository open nothing is invoked and nothing is toasted', async () => {
    const el = shellOnRepo();
    (el as any).activeRepository = null;

    await openFile(el, 'src/main.rs');

    expect(invokeCallArgs).to.have.lengthOf(0);
    expect(uiStore.getState().toasts).to.have.lengthOf(0);
  });
});
