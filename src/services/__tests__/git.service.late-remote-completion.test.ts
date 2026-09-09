/**
 * git.service — late remote-operation completions
 *
 * `tokio::time::timeout` only DROPS the future it wraps; the `spawn_blocking`
 * task doing the pull/push keeps running. The backend now reports those late
 * landings with `late: true` and the repository they actually changed, because
 * the caller that would normally refresh returned an error minutes earlier.
 * These tests pin what the UI does with such an event.
 */

import { expect } from '@open-wc/testing';

/** Handlers registered through `listen`, by event name. */
const listeners = new Map<string, (e: { event: string; id: number; payload: unknown }) => void>();
const callbacks = new Map<number, (payload: unknown) => void>();
let nextId = 1;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: (cb: (payload: unknown) => void) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'plugin:event|listen') {
      const event = args?.event as string;
      const handler = callbacks.get(args?.handler as number);
      if (handler) {
        listeners.set(
          event,
          handler as (e: { event: string; id: number; payload: unknown }) => void,
        );
      }
      return Promise.resolve(nextId++);
    }
    return Promise.resolve(null);
  },
};

// AppShell's disconnectedCallback tears the service listener back down, and
// the real unlisten goes through this plugin object. Without it every unmount
// threw an unhandled rejection; with it, teardown really removes the handler —
// so the suite re-arms the service after each test rather than passing by
// accident on a listener that was never removed.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (event: string) => {
    listeners.delete(event);
  },
};

/** Deliver a backend event exactly as the Tauri event plugin would. */
function emit(event: string, payload: unknown): void {
  listeners.get(event)?.({ event, id: 1, payload });
}

// Imported dynamically, NOT statically: a static import is hoisted above the
// mock installed above, and the service builds its Tauri bindings against
// whatever `window` holds at module evaluation.
type UiStoreModule = typeof import('../../stores/ui.store.ts');
let uiStore: UiStoreModule['uiStore'];
type GitServiceModule = typeof import('../git.service.ts');
let gitService: GitServiceModule;
type DialogStoreModule = typeof import('../../stores/dialog.store.ts');
let dialogs: DialogStoreModule['dialogs'];

/**
 * The tag AppShell is registered under (`@customElement` in app-shell.ts).
 *
 * Spelled out here and asserted against the real registry in the first test:
 * git.service reaches the shell with `document.querySelector`, so a mismatch
 * between what it queries and what the app registers is invisible to types and
 * silently drops every late conflict.
 */
const APP_SHELL_TAG = 'lv-app-shell';

/** The repository every event below names. */
const REPO_PATH = '/repos/alpha';

/** The private conflict-dialog state the real AppShell drives. */
interface ShellConflictState {
  conflictDialogConfig?: { repoPath?: string; operationType?: string };
}

function shellState(shell: HTMLElement): ShellConflictState {
  return shell as unknown as ShellConflictState;
}

/** The newest toast carrying `message`, so an unrelated toast cannot mask it. */
function toastForMessage(
  toasts: Array<{ type: string; message: string }>,
  message: string,
): { type: string; message: string } | undefined {
  return [...toasts].reverse().find((t) => t.message === message);
}

/**
 * A real, connected AppShell pinned to REPO_PATH.
 *
 * Pinned because `openConflictDialogPinned` refuses to open a dialog for a
 * repository whose tab is closed — the state a late completion would otherwise
 * arrive in here — and that refusal is not what these tests are about.
 */
async function mountShell(): Promise<{
  shell: HTMLElement;
  conflicts: Array<{ repositoryPath?: string; operationType?: string }>;
  cleanup: () => void;
}> {
  const shell = document.createElement(APP_SHELL_TAG);
  (shell as unknown as { activeRepository: unknown }).activeRepository = {
    repository: { path: REPO_PATH, name: 'alpha', isValid: true, isBare: false },
    branches: [],
    currentBranch: null,
    remotes: [],
    tags: [],
    stashes: [],
    status: [],
    stagedFiles: [],
    unstagedFiles: [],
  };
  const conflicts: Array<{ repositoryPath?: string; operationType?: string }> = [];
  shell.addEventListener('merge-conflict', (e: Event) => {
    conflicts.push((e as CustomEvent).detail);
  });
  document.body.appendChild(shell);
  await (shell as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return { shell, conflicts, cleanup: () => shell.remove() };
}

describe('git.service late remote-operation completions', () => {
  let refreshes: string[] = [];
  const onRefresh = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { repoPath?: string } | undefined;
    refreshes.push(detail?.repoPath ?? '');
  };

  before(async () => {
    gitService = await import('../git.service.ts');
    ({ uiStore } = await import('../../stores/ui.store.ts'));
    ({ dialogs } = await import('../../stores/dialog.store.ts'));
    // The REAL component, not a stand-in: the conflict route hangs off a
    // querySelector for its tag, so mounting anything else would let a wrong
    // selector — or a shell that never listens — pass unnoticed.
    await import('../../app-shell.ts');
    expect(
      customElements.get(APP_SHELL_TAG),
      'app-shell.ts must register the tag git.service queries',
    ).to.not.equal(undefined);
    await gitService.setupRemoteOperationListeners();
    expect([...listeners.keys()], 'the service attached its backend listener').to.include(
      'remote-operation-completed',
    );
  });

  beforeEach(async () => {
    // Re-armed because unmounting a shell calls cleanupRemoteOperationListeners.
    await gitService.setupRemoteOperationListeners();
    refreshes = [];
    uiStore.setState({ toasts: [] });
    window.addEventListener('repository-refresh', onRefresh);
  });

  afterEach(() => {
    window.removeEventListener('repository-refresh', onRefresh);
    uiStore.setState({ toasts: [] });
  });

  const newestToast = (): { type: string; message: string } | undefined => {
    const toasts = uiStore.getState().toasts;
    return toasts[toasts.length - 1];
  };

  it('refreshes the repository a late pull completion names', () => {
    const message = 'Pull finished after it was reported as timed out: Merge completed';
    emit('remote-operation-completed', {
      operation: 'pull',
      remote: 'origin',
      repoPath: REPO_PATH,
      success: true,
      message,
      late: true,
    });

    expect(refreshes, 'the repo the pull actually changed must be refreshed').to.deep.equal([REPO_PATH]);
    expect(newestToast()).to.include({ type: 'warning', message });
  });

  it('reports a late failure as an error and still refreshes', () => {
    // A late rebase that failed can leave the repo in REBASE state; the UI has
    // to see it even though the operation reports failure.
    const message = 'Pull failed after it was reported as timed out: Rebase conflict';
    emit('remote-operation-completed', {
      operation: 'pull',
      remote: 'origin',
      repoPath: REPO_PATH,
      success: false,
      message,
      late: true,
    });

    expect(refreshes).to.deep.equal([REPO_PATH]);
    expect(newestToast()).to.include({ type: 'error', message });
  });

  it('routes a late pull that ended in conflicts into the conflict dialog', async () => {
    // MERGE_HEAD is on disk: the user needs the dialog's Complete/Abort, which
    // a red toast plus a plain refresh does not offer. AppShell listens for
    // `merge-conflict` on ITSELF, so the dispatch has to reach that element.
    const { shell, conflicts, cleanup } = await mountShell();

    try {
      const message = 'Pull failed after it was reported as timed out: Merge conflict';
      emit('remote-operation-completed', {
        operation: 'pull',
        remote: 'origin',
        repoPath: REPO_PATH,
        success: false,
        message,
        errorCode: 'MERGE_CONFLICT',
        late: true,
      });

      expect(conflicts, 'the conflict dialog must be opened for the right repo').to.deep.equal([
        { repositoryPath: REPO_PATH, operationType: 'merge' },
      ]);
      // ...and the real handler must have acted on it, not just received it.
      expect(dialogs.isOpen('conflict'), 'the dialog is open').to.equal(true);
      expect(shellState(shell).conflictDialogConfig?.repoPath).to.equal(REPO_PATH);
      expect(shellState(shell).conflictDialogConfig?.operationType).to.equal('merge');
      // Not an error: the pull landed and now needs resolving.
      expect(toastForMessage(uiStore.getState().toasts, message)?.type).to.equal('warning');
    } finally {
      cleanup();
    }
  });

  it('opens a late rebase conflict as a rebase, not a merge', async () => {
    const { shell, conflicts, cleanup } = await mountShell();

    try {
      emit('remote-operation-completed', {
        operation: 'pull',
        remote: 'origin',
        repoPath: REPO_PATH,
        success: false,
        message: 'Pull failed after it was reported as timed out: Rebase conflict',
        errorCode: 'REBASE_CONFLICT',
        late: true,
      });

      expect(conflicts).to.deep.equal([
        { repositoryPath: REPO_PATH, operationType: 'rebase' },
      ]);
      // Continuing a rebase is not committing a merge; the dialog has to know.
      expect(shellState(shell).conflictDialogConfig?.operationType).to.equal('rebase');
    } finally {
      cleanup();
    }
  });

  it('still refreshes a late failure that is not a conflict', async () => {
    const { conflicts, cleanup } = await mountShell();

    try {
      emit('remote-operation-completed', {
        operation: 'pull',
        remote: 'origin',
        repoPath: REPO_PATH,
        success: false,
        message: 'Pull failed after it was reported as timed out: Authentication required',
        errorCode: 'AUTH_REQUIRED',
        late: true,
      });

      expect(conflicts, 'only a conflict opens the conflict dialog').to.deep.equal([]);
      expect(dialogs.isOpen('conflict')).to.equal(false);
      expect(refreshes).to.deep.equal([REPO_PATH]);
      expect(newestToast()?.type).to.equal('error');
    } finally {
      cleanup();
    }
  });

  it('leaves an ordinary completion alone', () => {
    // The caller that issued the push already refreshes; a second refresh from
    // here would be the overreach.
    emit('remote-operation-completed', {
      operation: 'push',
      remote: 'origin',
      repoPath: REPO_PATH,
      success: true,
      message: 'Pushed to origin/main',
    });

    expect(refreshes, 'a normal completion must not trigger an extra refresh').to.deep.equal([]);
    expect(newestToast()).to.include({ type: 'success', message: 'Pushed to origin/main' });
  });

  it('still announces a late completion that names no repository', () => {
    const message = 'Push finished after it was reported as timed out: Pushed to origin/main';
    emit('remote-operation-completed', {
      operation: 'push',
      remote: 'origin',
      repoPath: '',
      success: true,
      message,
      late: true,
    });

    expect(refreshes, 'nothing to pin the refresh to').to.deep.equal([]);
    expect(newestToast()).to.include({ type: 'warning', message });
  });
});
