/**
 * Integration tests for app-shell pull / stash / copy-sha / conflict-dialog
 * handlers.
 *
 * These create a REAL AppShell instance, set its internal state, call its REAL
 * handler methods, and verify the actual Tauri commands + user-visible toasts.
 * They cover the verified fixes:
 *   - handlePull inspects the CommandResult (success, MERGE_CONFLICT,
 *     REBASE_CONFLICT, generic error) instead of assuming success.
 *   - handleCreateStash reports success/failure via toast.
 *   - handleCopySha shows a success toast.
 *   - handleOpenConflictDialogEvent refreshes the repository.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// A mounted shell tears its backend listeners down in disconnectedCallback,
// and @tauri-apps/api reaches for this to do it. Without the stub every
// unmount raises an unhandled rejection that has nothing to do with the test.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import type { OpenRepository } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';
import { uiStore } from '../stores/ui.store.ts';

// Import the real component
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';

// Side-effect import so showPrompt finds the singleton already in the DOM.
import '../components/dialogs/lv-prompt-dialog.ts';
import type { LvPromptDialog } from '../components/dialogs/lv-prompt-dialog.ts';

/**
 * The stash shortcut/palette path now asks for an optional stash message, so
 * these tests install a stub that answers it immediately. '' is "OK with
 * nothing typed", which keeps git's default naming and the exact behaviour
 * asserted below.
 */
function setupMockPrompt(value: string | null): void {
  let dialog = document.querySelector<LvPromptDialog>('lv-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('lv-prompt-dialog') as LvPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => value;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('lv-prompt-dialog');
  if (dialog) dialog.remove();
}

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const mockRepository: Repository = {
  path: REPO_PATH,
  name: 'test-repo',
  isValid: true,
  isBare: false,
  headRef: 'refs/heads/main',
  detachedHeadOid: null,
  state: 'clean',
  isShallow: false,
  isPartialClone: false,
  cloneFilter: null,
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

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'open_repository':
        return mockOpenRepository;
      default:
        return null;
    }
  };
}

function createAppShell(): AppShell {
  const el = document.createElement('lv-app-shell') as AppShell;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).activeRepository = mockOpenRepository;
  return el;
}

const mountedShells: AppShell[] = [];

/**
 * A CONNECTED shell, for the handlers that reach it through an event.
 *
 * Fetch, pull and push run in remote-operations.service — the one runner both
 * this surface and the context dashboard's buttons call — which asks for the
 * refresh and for the conflict dialog with events rather than by reaching into
 * a component it cannot see. app-shell registers those listeners in
 * `connectedCallback`, so a detached element receives neither. Mounting is
 * also what the app really does.
 *
 * The invoke history and the toasts are cleared after mounting so the shell's
 * own start-up chatter cannot be mistaken for the handler's work.
 */
async function mountAppShell(): Promise<AppShell> {
  const el = createAppShell();
  document.body.appendChild(el);
  mountedShells.push(el);
  await el.updateComplete;
  clearHistory();
  uiStore.setState({ toasts: [] });
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell pull/stash/copy handlers (integration)', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
    uiStore.setState({ toasts: [] });
    setupMockPrompt('');
  });

  afterEach(() => {
    cleanupMockPrompt();
    for (const shell of mountedShells.splice(0)) shell.remove();
  });

  describe('handlePull', () => {
    it('refreshes the repository on success', async () => {
      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePull();

      expect(findCommands('pull').length).to.equal(1);
      // handleRefresh -> open_repository
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
      expect(dialogs.isOpen('conflict')).to.be.false;
    });

    it('opens the merge conflict dialog on MERGE_CONFLICT', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'pull') throw { code: 'MERGE_CONFLICT', message: 'Merge conflict' };
        if (command === 'open_repository') return mockOpenRepository;
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePull();

      expect(dialogs.isOpen('conflict')).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictOperationType).to.equal('merge');
      // Still refreshes so the working tree reflects the conflicted state
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
    });

    it('opens the rebase conflict dialog on REBASE_CONFLICT', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'pull') throw { code: 'REBASE_CONFLICT', message: 'Rebase conflict' };
        if (command === 'open_repository') return mockOpenRepository;
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePull();

      expect(dialogs.isOpen('conflict')).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictOperationType).to.equal('rebase');
    });

    it('shows an error toast on generic failure and does not open the dialog', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'pull') throw { code: 'NETWORK', message: 'Could not reach remote' };
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePull();

      expect(dialogs.isOpen('conflict')).to.be.false;
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /Could not reach remote/.test(t.message))).to.be.true;
    });
  });

  describe('handleFetch', () => {
    it('completes and refreshes on success', async () => {
      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleFetch();

      expect(findCommands('fetch').length).to.equal(1);
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.false;
    });

    it('shows an error toast and does not refresh on failure', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'fetch') throw { code: 'NETWORK', message: 'Could not reach remote' };
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleFetch();

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /Could not reach remote/.test(t.message))).to.be.true;
      expect(findCommands('open_repository').length).to.equal(0);
    });
  });

  describe('handlePush', () => {
    it('completes and refreshes on success', async () => {
      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePush();

      expect(findCommands('push').length).to.equal(1);
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.false;
    });

    it('shows an error toast and does not refresh on failure', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'push') throw { code: 'REJECTED', message: 'Updates were rejected' };
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePush();

      // A rejected push now routes through the suggestion service, which
      // replaces the bare "Updates were rejected" with the recovery the app
      // already implements — previously unreachable from the only push surface.
      const toasts = uiStore.getState().toasts;
      const err = toasts.find((t) => t.type === 'error');
      expect(err, 'the failure is still reported').to.not.be.undefined;
      expect(err!.message).to.match(/pull before pushing/i);
      expect(err!.action?.label, 'with a one-click recovery').to.equal('Pull Now');
      expect(findCommands('open_repository').length).to.equal(0);
    });

    it('a failure with no known recovery still shows the server\'s own words', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'push') {
          throw { code: 'COMMAND_ERROR', message: 'refs/heads/main: protected branch hook declined' };
        }
        return null;
      };

      const el = await mountAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handlePush();

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'error' && /protected branch hook declined/.test(t.message)),
        'the reason the server gave is not swallowed',
      ).to.be.true;
    });
  });

  describe('handleCreateStash', () => {
    it('shows a success toast and refreshes on success', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'create_stash') {
          return { index: 0, message: 'WIP', oid: 'abc123' };
        }
        if (command === 'open_repository') return mockOpenRepository;
        return null;
      };

      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleCreateStash();

      expect(findCommands('create_stash').length).to.equal(1);
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /Stash created/i.test(t.message))).to.be.true;
    });

    it('shows an informational (not error) toast and does not refresh when the tree is clean', async () => {
      // Backend returns null when there is nothing to stash — a benign no-op,
      // mirroring `git stash push` ("No local changes to save", exit 0).
      mockInvoke = async (command: string) => {
        if (command === 'create_stash') return null;
        if (command === 'open_repository') return mockOpenRepository;
        return null;
      };

      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleCreateStash();

      expect(findCommands('create_stash').length).to.equal(1);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.false;
      expect(toasts.some((t) => t.type === 'info' && /No local changes to save/i.test(t.message))).to.be.true;
      // Clean tree: no state change, so no refresh.
      expect(findCommands('open_repository').length).to.equal(0);
    });

    it('shows an error toast and does not refresh on failure', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'create_stash') throw { code: 'STASH_ERROR', message: 'Nothing to stash' };
        return null;
      };

      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleCreateStash();

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /Nothing to stash/.test(t.message))).to.be.true;
      expect(findCommands('open_repository').length).to.equal(0);
    });
  });

  describe('handleCopySha', () => {
    it('shows a success toast with the copied sha', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleCopySha(new CustomEvent('copy-sha', { detail: { sha: 'abc1234' } }));

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /abc1234/.test(t.message))).to.be.true;
    });
  });

  describe('handleShowBlame (show-blame from file-history/right-panel)', () => {
    it('opens the blame view and closes any open diff', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('diff');
      shell.diffFile = { path: 'src/x.ts', status: 'modified', isStaged: false, isConflicted: false };

      shell.handleShowBlame(
        new CustomEvent('show-blame', { detail: { filePath: 'src/x.ts', commitOid: 'abc123' } })
      );

      expect(dialogs.isOpen('blame')).to.be.true;
      expect(shell.blameFile).to.equal('src/x.ts');
      expect(shell.blameCommitOid).to.equal('abc123');
      expect(dialogs.isOpen('diff')).to.be.false;
      expect(shell.diffFile).to.be.null;
    });
  });

  describe('handleShowFileHistory (show-file-history from the right panel)', () => {
    it('opens the history pane and closes an open working-tree diff', () => {
      // The right panel stays clickable while a diff covers the center pane,
      // and the center pane renders the diff ahead of file history — so
      // leaving the diff up means the History click shows the user nothing.
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('diff');
      shell.diffFile = { path: 'src/x.ts', status: 'modified', isStaged: false, isConflicted: false };

      shell.handleShowFileHistory(
        new CustomEvent('show-file-history', { detail: { filePath: 'src/x.ts' } })
      );

      expect(dialogs.isOpen('fileHistory')).to.be.true;
      expect(shell.fileHistoryPath).to.equal('src/x.ts');
      expect(dialogs.isOpen('diff'), 'the diff no longer covers the history pane').to.be.false;
      expect(shell.diffFile).to.be.null;
    });

    it('closes a commit-file diff and an open blame view too', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('diff');
      shell.diffFile = null;
      shell.diffCommitFile = { commitOid: 'abc123', filePath: 'src/x.ts' };
      dialogs.open('blame');
      shell.blameFile = 'src/y.ts';
      shell.blameCommitOid = 'abc123';

      shell.handleShowFileHistory(
        new CustomEvent('show-file-history', { detail: { filePath: 'src/z.ts' } })
      );

      expect(dialogs.isOpen('fileHistory')).to.be.true;
      expect(shell.fileHistoryPath).to.equal('src/z.ts');
      expect(dialogs.isOpen('diff')).to.be.false;
      expect(shell.diffCommitFile).to.be.null;
      // Blame also outranks file history in the center pane
      expect(dialogs.isOpen('blame')).to.be.false;
      expect(shell.blameFile).to.be.null;
      expect(shell.blameCommitOid).to.be.null;
    });

    it('leaves the other panes alone when nothing else is open', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;

      shell.handleShowFileHistory(
        new CustomEvent('show-file-history', { detail: { filePath: 'src/a.ts' } })
      );

      expect(dialogs.isOpen('fileHistory')).to.be.true;
      expect(shell.fileHistoryPath).to.equal('src/a.ts');
      expect(dialogs.isOpen('diff')).to.be.false;
      expect(dialogs.isOpen('blame')).to.be.false;
      expect(uiStore.getState().toasts.length, 'nothing was lost, so nothing is said').to.equal(0);
    });
  });

  describe('picking another file while file history is open (inverse navigation)', () => {
    it('handleFileSelected clears the history pane so closing the diff does not uncover it', () => {
      // Open history for one file, then click a different file in Changes.
      // The diff outranks history in the center pane, so a stale
      // open file-history pane is invisible right up until the diff closes — and
      // then the old file's history appears unbidden.
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('fileHistory', { filePath: 'src/old.ts' });

      shell.handleFileSelected(
        new CustomEvent('file-selected', {
          detail: {
            file: { path: 'src/new.ts', status: 'modified', isStaged: false, isConflicted: false },
          },
        })
      );

      expect(dialogs.isOpen('diff')).to.be.true;
      expect(dialogs.isOpen('fileHistory'), 'the unrelated history pane is gone').to.be.false;
      expect(shell.fileHistoryPath).to.be.null;

      // Closing the diff must leave the center pane empty, not reveal history.
      shell.handleCloseDiff();
      expect(dialogs.isOpen('diff')).to.be.false;
      expect(dialogs.isOpen('fileHistory')).to.be.false;
    });

    it('handleCommitFileSelected clears the history pane too', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('fileHistory', { filePath: 'src/old.ts' });

      shell.handleCommitFileSelected(
        new CustomEvent('commit-file-selected', {
          detail: { commitOid: 'abc123', filePath: 'src/new.ts' },
        })
      );

      expect(dialogs.isOpen('diff')).to.be.true;
      expect(shell.diffCommitFile).to.deep.equal({ commitOid: 'abc123', filePath: 'src/new.ts' });
      expect(dialogs.isOpen('fileHistory'), 'the unrelated history pane is gone').to.be.false;
      expect(shell.fileHistoryPath).to.be.null;
    });

    it('a conflicted file opens the merge editor and leaves history untouched', () => {
      // The conflicted branch returns before any pane swap — it opens a
      // dialog rather than replacing the center pane, so there is nothing
      // for the history pane to hide under.
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('fileHistory', { filePath: 'src/old.ts' });
      let openedPath: string | null = null;
      shell.openConflictDialogFromState = (path: string) => {
        openedPath = path;
      };

      shell.handleFileSelected(
        new CustomEvent('file-selected', {
          detail: {
            file: { path: 'src/conflict.ts', status: 'conflicted', isStaged: false, isConflicted: true },
          },
        })
      );

      expect(openedPath).to.equal('src/conflict.ts');
      expect(dialogs.isOpen('diff'), 'no diff was opened').to.be.false;
      expect(dialogs.isOpen('fileHistory')).to.be.true;
      expect(shell.fileHistoryPath).to.equal('src/old.ts');
    });
  });

  describe('handleCloseDiff (file-cleared from diff-view)', () => {
    it('closes the diff overlay and clears diff state', () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      dialogs.open('diff');
      shell.diffFile = { path: 'src/x.ts', status: 'modified', isStaged: false, isConflicted: false };
      shell.diffCommitFile = null;

      shell.handleCloseDiff();

      expect(dialogs.isOpen('diff')).to.be.false;
      expect(shell.diffFile).to.be.null;
      expect(shell.diffCommitFile).to.be.null;
    });
  });

  describe('handleOpenConflictDialogEvent', () => {
    it('opens the dialog and refreshes the repository', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenConflictDialogEvent(
        new CustomEvent('open-conflict-dialog', { detail: { operationType: 'rebase' } })
      );

      // Let the async handleRefresh run
      await new Promise((r) => setTimeout(r, 0));

      expect(dialogs.isOpen('conflict')).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictOperationType).to.equal('rebase');
      expect(findCommands('open_repository').length).to.be.greaterThan(0);
    });

    it('passes stash operationType through to the dialog', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenConflictDialogEvent(
        new CustomEvent('open-conflict-dialog', { detail: { operationType: 'stash' } })
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(dialogs.isOpen('conflict')).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictOperationType).to.equal('stash');
    });

    it('threads stashIndex / dropStashOnComplete from the event detail', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenConflictDialogEvent(
        new CustomEvent('open-conflict-dialog', {
          detail: { operationType: 'stash', stashIndex: 4, dropStashOnComplete: false },
        })
      );
      await new Promise((r) => setTimeout(r, 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      expect(shell.conflictStashIndex).to.equal(4);
      expect(shell.conflictDropStashOnComplete).to.be.false;
      expect(shell.conflictSquashMerge).to.be.false;
    });

    it('threads squash from the event detail (git-flow squash finish)', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenConflictDialogEvent(
        new CustomEvent('open-conflict-dialog', {
          detail: { operationType: 'merge', squash: true },
        })
      );
      await new Promise((r) => setTimeout(r, 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictSquashMerge).to.be.true;
    });

    it('defaults stash/squash detail to index 0, drop true, squash false', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleOpenConflictDialogEvent(
        new CustomEvent('open-conflict-dialog', { detail: { operationType: 'rebase' } })
      );
      await new Promise((r) => setTimeout(r, 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      expect(shell.conflictStashIndex).to.equal(0);
      expect(shell.conflictDropStashOnComplete).to.be.true;
      expect(shell.conflictSquashMerge).to.be.false;
    });

    it('resets a stale squash flag when a plain merge conflict opens the dialog', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = el as any;
      // Simulate a prior git-flow squash finish having set the flag.
      shell.conflictSquashMerge = true;
      shell.handleMergeConflictEvent();
      await new Promise((r) => setTimeout(r, 0));

      expect(shell.conflictSquashMerge).to.be.false;
    });
  });

  describe('handleAutoStashToast', () => {
    it('opens the stash conflict dialog when the stash pop conflicts', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleAutoStashToast(
        { stashed: true, stashApplied: false, stashConflict: true, success: true, message: 'conflict' },
        'feature/x'
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(dialogs.isOpen('conflict')).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).conflictOperationType).to.equal('stash');
      // Warns the user AND opens the dialog.
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'warning' && /stash conflicts/i.test(t.message))).to.be.true;
    });

    it('surfaces the backend message, warning when staged status was not preserved', async () => {
      const el = createAppShell();
      const caveat =
        'Switched to feature/x and re-applied stashed changes (staged status was not preserved)';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleAutoStashToast(
        { stashed: true, stashApplied: true, stashConflict: false, success: true, message: caveat },
        'feature/x'
      );
      await new Promise((r) => setTimeout(r, 0));

      const toasts = uiStore.getState().toasts;
      // The caveat must reach the user as a warning, not be masked by a
      // hardcoded "changes re-applied" info toast.
      expect(toasts.some((t) => t.type === 'warning' && t.message === caveat)).to.be.true;
    });

    it('does not open the dialog when the stash re-applies cleanly', async () => {
      const el = createAppShell();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleAutoStashToast(
        { stashed: true, stashApplied: true, stashConflict: false, success: true, message: 'ok' },
        'feature/x'
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(dialogs.isOpen('conflict')).to.be.false;
    });
  });
});
