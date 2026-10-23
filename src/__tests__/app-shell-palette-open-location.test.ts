/**
 * Command palette entries that open the ACTIVE repository elsewhere:
 * "Open in Terminal", "Reveal in File Manager" and "Open in Editor".
 *
 * The backend commands (open_terminal / open_file_manager /
 * open_in_configured_editor) existed and were registered, but nothing in the
 * UI called them. These tests pin the palette wiring: the right command, the
 * active repository's path, the repository guard, and — since success is just
 * "the OS opened something" — that every failure path reaches the user as an
 * error toast carrying the backend's own message.
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

interface PaletteCommandLike {
  id: string;
  label: string;
  action: () => void;
}

describe('app-shell command palette: open the repository elsewhere', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    for (const k of Object.keys(failures)) delete failures[k];
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    mockResponses['open_in_configured_editor'] = () => ({
      success: true,
      message: 'Opened in code',
    });
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  function shellOnRepo(path: string | null = '/repo/active'): AppShell {
    const el = document.createElement('gn-app-shell') as AppShell;
    (el as any).activeRepository = path ? { repository: mockRepo(path, 'active') } : null;
    return el;
  }

  function paletteCommand(el: AppShell, id: string): PaletteCommandLike {
    const commands = (el as any).getPaletteCommands() as PaletteCommandLike[];
    const command = commands.find((c) => c.id === id);
    expect(command, `palette command "${id}"`).to.exist;
    return command!;
  }

  /** Let the command's awaited service call settle. */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  function errorToasts(): Array<{ message: string; type: string }> {
    return uiStore.getState().toasts.filter((t) => t.type === 'error') as Array<{
      message: string;
      type: string;
    }>;
  }

  it('exposes all three commands with stable labels', () => {
    const el = shellOnRepo();

    expect(paletteCommand(el, 'open-in-terminal').label).to.equal('Open in Terminal');
    expect(paletteCommand(el, 'reveal-in-file-manager').label).to.equal('Reveal in File Manager');
    expect(paletteCommand(el, 'open-in-editor').label).to.equal('Open in Editor');
  });

  it('Open in Terminal invokes open_terminal for the active repository', async () => {
    const el = shellOnRepo();

    paletteCommand(el, 'open-in-terminal').action();
    await settle();

    const call = invokeCallArgs.find((c) => c.command === 'open_terminal');
    expect(call, 'open_terminal should be invoked').to.exist;
    expect(call!.args.path).to.equal('/repo/active');
    expect(errorToasts()).to.have.lengthOf(0);
  });

  it('Reveal in File Manager invokes open_file_manager for the active repository', async () => {
    const el = shellOnRepo();

    paletteCommand(el, 'reveal-in-file-manager').action();
    await settle();

    const call = invokeCallArgs.find((c) => c.command === 'open_file_manager');
    expect(call, 'open_file_manager should be invoked').to.exist;
    expect(call!.args.path).to.equal('/repo/active');
    expect(errorToasts()).to.have.lengthOf(0);
  });

  it('Open in Editor targets the repository root through the configured editor', async () => {
    const el = shellOnRepo();

    paletteCommand(el, 'open-in-editor').action();
    await settle();

    const call = invokeCallArgs.find((c) => c.command === 'open_in_configured_editor');
    expect(call, 'open_in_configured_editor should be invoked').to.exist;
    expect(call!.args.path).to.equal('/repo/active');
    expect(call!.args.filePath).to.equal('/repo/active');
    expect(errorToasts()).to.have.lengthOf(0);
  });

  it('a missing terminal emulator is reported with the backend message', async () => {
    failures['open_terminal'] = {
      code: 'OPERATION_FAILED',
      message: 'Operation failed: No terminal emulator found',
    };
    const el = shellOnRepo();

    paletteCommand(el, 'open-in-terminal').action();
    await settle();

    const errors = errorToasts();
    expect(errors, 'a failed terminal launch must not be silent').to.have.lengthOf(1);
    expect(errors[0].message).to.contain('No terminal emulator found');
  });

  it('a file manager failure is reported with the backend message', async () => {
    failures['open_file_manager'] = {
      code: 'INVALID_PATH',
      message: 'Invalid path: /repo/active',
    };
    const el = shellOnRepo();

    paletteCommand(el, 'reveal-in-file-manager').action();
    await settle();

    const errors = errorToasts();
    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.contain('Invalid path: /repo/active');
  });

  it('an editor that resolves with success:false is still reported', async () => {
    mockResponses['open_in_configured_editor'] = () => ({
      success: false,
      message: 'No editor configured',
    });
    const el = shellOnRepo();

    paletteCommand(el, 'open-in-editor').action();
    await settle();

    const errors = errorToasts();
    expect(errors, 'OpenResult.success === false must be reported').to.have.lengthOf(1);
    expect(errors[0].message).to.contain('No editor configured');
  });

  it('with no repository open nothing is invoked and the guard warns', async () => {
    const el = shellOnRepo(null);

    paletteCommand(el, 'open-in-terminal').action();
    paletteCommand(el, 'reveal-in-file-manager').action();
    paletteCommand(el, 'open-in-editor').action();
    await settle();

    const opens = invokeCallArgs.filter((c) =>
      ['open_terminal', 'open_file_manager', 'open_in_configured_editor'].includes(c.command),
    );
    expect(opens).to.have.lengthOf(0);
    const warnings = uiStore.getState().toasts.filter((t) => t.type === 'warning');
    expect(warnings).to.have.lengthOf(3);
    expect(warnings[0].message).to.contain('open a repository');
  });
});
