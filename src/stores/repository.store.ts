import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';
import type { Repository, Branch, Remote, Tag, Stash, StatusEntry } from '../types/git.types.ts';

export interface RecentRepository {
  path: string;
  name: string;
  lastOpened: number;
}

export interface OpenRepository {
  repository: Repository;
  branches: Branch[];
  currentBranch: Branch | null;
  remotes: Remote[];
  tags: Tag[];
  stashes: Stash[];
  status: StatusEntry[];
  stagedFiles: StatusEntry[];
  unstagedFiles: StatusEntry[];
}

// Persisted state for open repositories (just paths, not full data)
export interface PersistedOpenRepo {
  path: string;
  name: string;
}

export interface RepositoryState {
  // Open repositories (tabs)
  openRepositories: OpenRepository[];
  activeIndex: number;

  // Persisted open repos (restored on startup)
  persistedOpenRepos: PersistedOpenRepo[];
  // Path of the tab that was active when the app last persisted — restored
  // by restorePersistedRepositories so a restart lands on the same tab
  persistedActivePath: string | null;

  // Loading state
  isLoading: boolean;
  error: string | null;

  // Recent repositories (persisted)
  recentRepositories: RecentRepository[];

  // Actions - Repository management
  /**
   * Open a repo as a tab. By default it becomes the active tab; pass
   * `{ activate: false }` when opening several repos in a batch (workspace
   * open) so each add doesn't fire the activation side effects (index
   * builds, integration checks) — activate the final one explicitly.
   */
  addRepository: (repo: Repository, options?: { activate?: boolean }) => void;
  removeRepository: (path: string) => void;
  /** Remove a repo from the persisted list only (e.g. it failed to restore) */
  prunePersistedRepo: (path: string) => void;
  setActiveIndex: (index: number) => void;
  setActiveByPath: (path: string) => void;

  // Actions - Update repo data
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Update any open repo's data by path — works for background tabs too */
  updateRepoData: (path: string, data: Partial<Omit<OpenRepository, 'repository'>>) => void;
  // Convenience setters for the ACTIVE repo
  setBranches: (branches: Branch[]) => void;
  setCurrentBranch: (branch: Branch | null) => void;
  setRemotes: (remotes: Remote[]) => void;
  setTags: (tags: Tag[]) => void;
  setStashes: (stashes: Stash[]) => void;
  setStatus: (status: StatusEntry[]) => void;
  updateActiveRepository: (repo: Repository) => void;

  // Actions - Recent repositories
  addRecentRepository: (path: string, name: string) => void;
  removeRecentRepository: (path: string) => void;
  clearRecentRepositories: () => void;

  // Getters
  getActiveRepository: () => OpenRepository | null;
  getPersistedOpenRepos: () => PersistedOpenRepo[];
  reset: () => void;
}

const MAX_RECENT = 10;

const initialState = {
  openRepositories: [] as OpenRepository[],
  activeIndex: -1,
  persistedOpenRepos: [] as PersistedOpenRepo[],
  persistedActivePath: null as string | null,
  isLoading: false,
  error: null,
  recentRepositories: [] as RecentRepository[],
};

const createEmptyRepoData = (repo: Repository): OpenRepository => ({
  repository: repo,
  branches: [],
  currentBranch: null,
  remotes: [],
  tags: [],
  stashes: [],
  status: [],
  stagedFiles: [],
  unstagedFiles: [],
});

/** Checks if activeIndex is valid for the openRepositories array */
function isActiveIndexValid(state: Pick<RepositoryState, 'activeIndex' | 'openRepositories'>): boolean {
  return state.activeIndex >= 0 && state.activeIndex < state.openRepositories.length;
}

export const repositoryStore = createStore<RepositoryState>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Repository management
      addRepository: (repo, options) => {
        const name = repo.name || repo.path.split('/').pop() || repo.path;
        const activate = options?.activate ?? true;

        set((state) => {
          const existingIndex = state.openRepositories.findIndex(
            (r) => r.repository.path === repo.path
          );

          if (existingIndex >= 0) {
            return activate ? { activeIndex: existingIndex } : state;
          }

          const newRepos = [...state.openRepositories, createEmptyRepoData(repo)];
          const newPersistedRepos = state.persistedOpenRepos.some((r) => r.path === repo.path)
            ? state.persistedOpenRepos
            : [...state.persistedOpenRepos, { path: repo.path, name }];

          return {
            openRepositories: newRepos,
            activeIndex: activate ? newRepos.length - 1 : state.activeIndex,
            persistedOpenRepos: newPersistedRepos,
            error: null,
          };
        });

        // Add to recent
        get().addRecentRepository(repo.path, name);
      },

      removeRepository: (path) => {
        set((state) => {
          const index = state.openRepositories.findIndex(
            (r) => r.repository.path === path
          );
          if (index < 0) return state;

          const newRepos = state.openRepositories.filter(
            (r) => r.repository.path !== path
          );
          const newPersistedRepos = state.persistedOpenRepos.filter(
            (r) => r.path !== path
          );
          let newActiveIndex = state.activeIndex;

          if (newRepos.length === 0) {
            newActiveIndex = -1;
          } else if (state.activeIndex === index) {
            // The active tab was closed. Prefer the tab that "shifted in" from
            // the right (matches browser/VS Code behaviour); fall back to the
            // tab on the left when the closed tab was the last one.
            newActiveIndex = Math.min(state.activeIndex, newRepos.length - 1);
          } else if (state.activeIndex > index) {
            // A tab to the left of active was closed; everything shifts down.
            newActiveIndex = state.activeIndex - 1;
          }

          return {
            openRepositories: newRepos,
            persistedOpenRepos: newPersistedRepos,
            activeIndex: newActiveIndex,
          };
        });
      },

      prunePersistedRepo: (path) => {
        set((state) => ({
          persistedOpenRepos: state.persistedOpenRepos.filter((r) => r.path !== path),
        }));
      },

      setActiveIndex: (index) => {
        set((state) => {
          if (index < 0 || index >= state.openRepositories.length) {
            return state;
          }
          return { activeIndex: index };
        });
      },

      setActiveByPath: (path) => {
        set((state) => {
          const index = state.openRepositories.findIndex(
            (r) => r.repository.path === path
          );
          if (index < 0) return state;
          return { activeIndex: index };
        });
      },

      // Loading/error state
      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error, isLoading: false }),

      // Update repo data. All setters funnel through updateRepoData so any
      // open repo (active or background) can be updated by path without
      // touching activeIndex.
      updateRepoData: (path, data) => {
        set((state) => {
          const index = state.openRepositories.findIndex(
            (r) => r.repository.path === path
          );
          if (index < 0) return state;
          const newRepos = [...state.openRepositories];
          newRepos[index] = { ...newRepos[index], ...data };
          return { openRepositories: newRepos };
        });
      },

      setBranches: (branches) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) get().updateRepoData(path, { branches });
      },

      setCurrentBranch: (currentBranch) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) get().updateRepoData(path, { currentBranch });
      },

      setRemotes: (remotes) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) get().updateRepoData(path, { remotes });
      },

      setTags: (tags) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) get().updateRepoData(path, { tags });
      },

      setStashes: (stashes) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) get().updateRepoData(path, { stashes });
      },

      setStatus: (status) => {
        const path = get().getActiveRepository()?.repository.path;
        if (path) {
          get().updateRepoData(path, {
            status,
            stagedFiles: status.filter((s) => s.isStaged),
            unstagedFiles: status.filter((s) => !s.isStaged),
          });
        }
      },

      updateActiveRepository: (repo) => {
        set((state) => {
          if (!isActiveIndexValid(state)) return state;
          const newRepos = [...state.openRepositories];
          newRepos[state.activeIndex] = {
            ...newRepos[state.activeIndex],
            repository: repo,
          };
          return { openRepositories: newRepos };
        });
      },

      // Recent repositories
      addRecentRepository: (path, name) => {
        set((state) => {
          const filtered = state.recentRepositories.filter((r) => r.path !== path);
          const newRecent: RecentRepository = {
            path,
            name,
            lastOpened: Date.now(),
          };
          return {
            recentRepositories: [newRecent, ...filtered].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentRepository: (path) => {
        set((state) => ({
          recentRepositories: state.recentRepositories.filter((r) => r.path !== path),
        }));
      },

      clearRecentRepositories: () => {
        set({ recentRepositories: [] });
      },

      // Getters
      getActiveRepository: () => {
        const state = get();
        if (state.activeIndex < 0 || state.activeIndex >= state.openRepositories.length) {
          return null;
        }
        return state.openRepositories[state.activeIndex];
      },

      getPersistedOpenRepos: () => {
        return get().persistedOpenRepos;
      },

      reset: () => set(initialState),
    }),
    {
      name: 'gitnado-repositories',
      partialize: (state) => ({
        recentRepositories: state.recentRepositories,
        persistedOpenRepos: state.persistedOpenRepos,
        activeIndex: state.activeIndex,
        // Derive the active PATH at persist time: activeIndex alone can't be
        // restored (openRepositories is rebuilt async at startup, so the
        // rehydrate hook clamps the index). Keep the previous value while no
        // repo is active (e.g. during the startup window before restore).
        persistedActivePath:
          state.openRepositories[state.activeIndex]?.repository.path ??
          state.persistedActivePath,
      }),
      onRehydrateStorage: () => (state) => {
        // Clamp activeIndex to valid range — openRepositories starts empty
        // and is rebuilt async by restorePersistedRepositories()
        if (state && state.activeIndex >= state.openRepositories.length) {
          state.activeIndex = state.openRepositories.length > 0 ? 0 : -1;
        }
      },
    }
  )
);
