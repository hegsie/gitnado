/**
 * Integration tests for the two entry points that reach `git describe`.
 *
 * The command and its service wrapper existed for a long time with nothing in
 * the UI calling them. These tests hold the wiring: the commit context menu
 * aims the dialog at the clicked commit, and the palette entry aims it at
 * HEAD — and both require a repository to be open.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import type { OpenRepository } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';
import { uiStore } from '../stores/ui.store.ts';
import '../app-shell.ts';

const REPO_PATH = '/test/repo';

const mockRepository: Repository = {
  path: REPO_PATH,
  name: 'test-repo',
  isValid: true,
  isBare: false,
  headRef: 'refs/heads/main',
  state: 'clean',
  isShallow: false,
  isPartialClone: false,
  cloneFilter: null,
  detachedHeadOid: null,
};

const mockOpenRepository: OpenRepository = {
  repository: mockRepository,
  branches: [],
  currentBranch: null,
  remotes: [],
  tags: [],
  stashes: [],
  status: [],
  stagedFiles: [],
  unstagedFiles: [],
};

interface PaletteCommand {
  id: string;
  label: string;
  action: () => void;
}

/** Calls recorded from the stubbed describe dialog. */
let openCalls: Array<{ commitish?: string; summary?: string }> = [];

/**
 * A real AppShell with the describe dialog stubbed. The dialog is reached
 * through a @query accessor, which resolves to nothing on an unrendered
 * shell — an own property shadows it with something the test can observe.
 */
function createAppShell(withRepo = true): AppShell {
  const el = document.createElement('gn-app-shell') as AppShell;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shell = el as any;
  shell.activeRepository = withRepo ? mockOpenRepository : null;
  Object.defineProperty(shell, 'describeDialog', {
    configurable: true,
    value: {
      open: (commitish?: string, summary?: string) => {
        openCalls.push({ commitish, summary });
      },
    },
  });
  return el;
}

function getCommand(el: AppShell, id: string): PaletteCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands: PaletteCommand[] = (el as any).getPaletteCommands();
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) throw new Error(`palette command "${id}" not found`);
  return cmd;
}

describe('app-shell describe entry points (integration)', () => {
  beforeEach(() => {
    openCalls = [];
    uiStore.setState({ toasts: [] });
  });

  it('opens the describe dialog on the commit the context menu was opened for', () => {
    const el = createAppShell();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shell = el as any;
    shell.contextMenu = {
      visible: true,
      x: 10,
      y: 20,
      commit: { oid: 'abc123def456', summary: 'Add feature' },
    };

    shell.handleDescribeFromContext();

    expect(openCalls).to.deep.equal([{ commitish: 'abc123def456', summary: 'Add feature' }]);
    // The menu must close behind the dialog, like its siblings.
    expect(shell.contextMenu.visible).to.be.false;
  });

  it('opens the describe dialog on HEAD from the command palette', () => {
    const el = createAppShell();

    getCommand(el, 'describe').action();

    expect(openCalls).to.deep.equal([{ commitish: undefined, summary: undefined }]);
  });

  it('warns instead of opening describe when no repository is open', () => {
    const el = createAppShell(false);

    getCommand(el, 'describe').action();

    expect(openCalls).to.have.length(0);
    expect(uiStore.getState().toasts.length).to.be.greaterThan(0);
  });
});
