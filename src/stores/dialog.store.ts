import { createStore } from 'zustand/vanilla';
import type { GitflowFinishContext } from '../components/dialogs/lv-conflict-resolution-dialog.ts';
import type { SearchDialogMode } from '../components/dialogs/lv-search-dialog.ts';

/**
 * Which overlay app-shell has on screen, and its open-time payload.
 *
 * app-shell used to carry one `show*` boolean per dialog — thirty-one of them,
 * plus loose payload fields beside each. Nothing enumerated them, so every
 * rule that had to apply to "all dialogs" (close them when the last repository
 * tab goes away, most of all) was written by REFLECTING over Lit's
 * `elementProperties` and pattern-matching `/^show[A-Z]/` at runtime, with a
 * hand-maintained exclusion list of the ones that are not repo-scoped. That
 * worked, but it meant the set of dialogs existed nowhere a reader could see
 * it, and a dialog's repo-scoping was decided by a string match on its field
 * name.
 *
 * The registry below IS that set. It is the single place a dialog is declared,
 * so the sweep is a plain loop over it (see `closeRepoScoped`) instead of a
 * reflective scan, and `repoScoped` is a declared property of the dialog
 * rather than an inference from how it was named.
 */
export interface DialogDescriptor {
  /**
   * True when the dialog renders INSIDE app-shell's
   * `${this.activeRepository ? ...}` block, so closing the last repository tab
   * destroys its element while its open flag would otherwise stay set — and
   * the next repository opened reconstructs it as a full-screen overlay
   * springing up unbidden. Those must be closed with the last tab.
   *
   * False for the handful that render outside that block: their element is
   * never destroyed, they are all reachable with zero repositories open (the
   * welcome screen offers the profile manager; the palette's SSH, profiles and
   * provider entries are deliberately not repo-guarded), and closing them
   * would only kill a session the user deliberately started — skipping the
   * `@close` binding that unwinds their navigation state along the way.
   *
   * `true` is the safe default, and the default a newly added dialog should
   * take unless it is genuinely usable with no repository open.
   */
  repoScoped: boolean;
}

/**
 * Every dialog and full-screen view app-shell owns.
 *
 * `diff`, `blame` and `fileHistory` are panes rather than modals, but they are
 * gated on the same kind of flag, render inside the repository block, and were
 * swept by the same rule — so they are declared here too rather than being a
 * second, invisible category.
 */
export const DIALOG_REGISTRY = {
  // --- Repo-independent: usable with no repository open. ---
  settings: { repoScoped: false },
  shortcuts: { repoScoped: false },
  commandPalette: { repoScoped: false },
  workspaceManager: { repoScoped: false },
  ssh: { repoScoped: false },
  profileManager: { repoScoped: false },
  /** Fires from checkUnifiedProfilesMigration on startup, before any repo. */
  migration: { repoScoped: false },
  /**
   * Offered from the welcome screen's Scan action and from a folder dropped on
   * the window. Renders outside the repository block and is the main way in
   * with nothing open, so it must survive the last tab closing.
   */
  repositoryScan: { repoScoped: false },
  // Account connection is repo-independent; only the PR/issue/pipeline tabs
  // inside these dialogs guard themselves on a repository.
  gitHub: { repoScoped: false },
  gitLab: { repoScoped: false },
  bitbucket: { repoScoped: false },
  azureDevOps: { repoScoped: false },
  oidc: { repoScoped: false },

  // --- Repo-scoped: must not outlive the repository they were opened for. ---
  diff: { repoScoped: true },
  blame: { repoScoped: true },
  fileHistory: { repoScoped: true },
  /**
   * A pane, not a modal, but it renders inside the repository block like the
   * three above — which is why its View-menu and palette toggles are
   * repository-scoped. Left repo-independent, its flag survived closing the
   * last tab and the panel sprang open over the next repository opened.
   */
  outputPanel: { repoScoped: true },
  conflict: { repoScoped: true },
  reflog: { repoScoped: true },
  search: { repoScoped: true },
  remotes: { repoScoped: true },
  clean: { repoScoped: true },
  repositoryHealth: { repoScoped: true },
  bisect: { repoScoped: true },
  submodules: { repoScoped: true },
  worktrees: { repoScoped: true },
  lfs: { repoScoped: true },
  gpg: { repoScoped: true },
  config: { repoScoped: true },
  credentials: { repoScoped: true },
  hooks: { repoScoped: true },
  gitignore: { repoScoped: true },
} as const satisfies Record<string, DialogDescriptor>;

export type DialogId = keyof typeof DIALOG_REGISTRY;

/**
 * The conflict dialog's inputs, SNAPSHOTTED at open time.
 *
 * The dialog must keep operating on the repository and operation it was opened
 * for even if the user switches repo tabs (Ctrl+Tab still works behind the
 * full-screen dialog) or another conflicting operation fires while it is up —
 * live-binding app-shell's loose staging fields would let a second conflict
 * source retarget an in-flight resolution's repo/operation, aiming its
 * abort/resolve/stage commands at the wrong repository.
 */
export interface ConflictDialogContext {
  repoPath: string;
  operationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash';
  initialFilePath: string | null;
  stashSourceCertain: boolean;
  stashIndex: number;
  stashOid: string | null;
  dropStashOnComplete: boolean;
  squashMerge: boolean;
  gitflowFinish: GitflowFinishContext | null;
}

export interface FileHistoryContext {
  filePath: string;
}

export interface SearchDialogContext {
  mode: SearchDialogMode;
}

export interface ProfileManagerContext {
  /** Which view the manager opens to. 'accounts' comes from "Manage Accounts". */
  initialView: '' | 'accounts';
}

/**
 * Open-time payloads, by dialog.
 *
 * Only dialogs listed here take a context; `open()` refuses one for any other
 * id. The diff and blame panes keep their payload fields on app-shell: those
 * are re-derived from every status refresh rather than being fixed at open
 * time, so they are not open-time context.
 */
export interface DialogContexts {
  conflict: ConflictDialogContext;
  fileHistory: FileHistoryContext;
  search: SearchDialogContext;
  profileManager: ProfileManagerContext;
}

export type DialogContextOf<Id extends DialogId> = Id extends keyof DialogContexts
  ? DialogContexts[Id]
  : never;

export interface DialogState {
  /** Open dialogs, by id. Absent key means closed. */
  openDialogs: Readonly<Partial<Record<DialogId, true>>>;
  /** Open-time payloads, cleared with their dialog. */
  contexts: Readonly<Partial<DialogContexts>>;

  isOpen(id: DialogId): boolean;
  /** Open `id`, replacing any previous context with `context`. */
  open<Id extends DialogId>(id: Id, context?: DialogContextOf<Id>): void;
  /** Close `id` and drop its context. Closing a closed dialog is a no-op. */
  close(id: DialogId): void;
  /** `open`/`close` chosen by a boolean — for the `open` flag of a toggle. */
  setOpen(id: DialogId, open: boolean): void;
  /** Replace the context of an ALREADY OPEN (or about to open) dialog. */
  setContext<Id extends keyof DialogContexts>(id: Id, context: DialogContexts[Id]): void;
  context<Id extends DialogId>(id: Id): DialogContextOf<Id> | null;
  /**
   * Close every dialog declared `repoScoped`. The whole reason the registry
   * exists: this used to reflect over Lit's reactive properties and match
   * field names against `/^show[A-Z]/`.
   */
  closeRepoScoped(): void;
  /** Close everything and drop every context. */
  reset(): void;
}

export const dialogStore = createStore<DialogState>((set, get) => ({
  openDialogs: {},
  contexts: {},

  isOpen: (id) => get().openDialogs[id] === true,

  open: (id, context) => {
    set((state) => ({
      openDialogs: { ...state.openDialogs, [id]: true },
      contexts:
        context === undefined
          ? state.contexts
          : { ...state.contexts, [id]: context },
    }));
  },

  close: (id) => {
    set((state) => {
      if (state.openDialogs[id] !== true && !(id in state.contexts)) return state;
      const openDialogs = { ...state.openDialogs };
      delete openDialogs[id];
      const contexts = { ...state.contexts } as Record<string, unknown>;
      delete contexts[id];
      return { openDialogs, contexts: contexts as Partial<DialogContexts> };
    });
  },

  setOpen: (id, open) => {
    if (open) get().open(id);
    else get().close(id);
  },

  setContext: (id, context) => {
    set((state) => ({ contexts: { ...state.contexts, [id]: context } }));
  },

  context: (id) =>
    ((get().contexts as Record<string, unknown>)[id] ?? null) as
      | DialogContextOf<typeof id>
      | null,

  closeRepoScoped: () => {
    set((state) => {
      const openDialogs = { ...state.openDialogs };
      const contexts = { ...state.contexts } as Record<string, unknown>;
      let changed = false;
      for (const id of Object.keys(DIALOG_REGISTRY) as DialogId[]) {
        if (!DIALOG_REGISTRY[id].repoScoped) continue;
        if (openDialogs[id] === true) {
          delete openDialogs[id];
          changed = true;
        }
        if (id in contexts) {
          delete contexts[id];
          changed = true;
        }
      }
      if (!changed) return state;
      return { openDialogs, contexts: contexts as Partial<DialogContexts> };
    });
  },

  reset: () => set({ openDialogs: {}, contexts: {} }),
}));

/**
 * Call-site facade.
 *
 * `dialogs.isOpen('clean')` at the ~150 app-shell call sites that used to read
 * `this.showClean`, without spelling `dialogStore.getState()` at every one.
 * The store itself stays the subscribable object.
 */
export const dialogs = {
  isOpen: (id: DialogId): boolean => dialogStore.getState().isOpen(id),
  open: <Id extends DialogId>(id: Id, context?: DialogContextOf<Id>): void =>
    dialogStore.getState().open(id, context),
  close: (id: DialogId): void => dialogStore.getState().close(id),
  setOpen: (id: DialogId, open: boolean): void => dialogStore.getState().setOpen(id, open),
  setContext: <Id extends keyof DialogContexts>(id: Id, context: DialogContexts[Id]): void =>
    dialogStore.getState().setContext(id, context),
  context: <Id extends DialogId>(id: Id): DialogContextOf<Id> | null =>
    dialogStore.getState().context(id),
  closeRepoScoped: (): void => dialogStore.getState().closeRepoScoped(),
  reset: (): void => dialogStore.getState().reset(),
};
