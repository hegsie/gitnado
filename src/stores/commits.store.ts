import { createStore } from 'zustand/vanilla';
import type { Commit } from '../types/git.types.ts';
import type { GraphLayout, GraphSelection } from '../types/graph.types.ts';

export interface RepoCommitsSlice {
  commits: Commit[];
  commitMap: Map<string, Commit>;
  isLoading: boolean;
  hasMore: boolean;
  graphLayout: GraphLayout | null;
  selection: GraphSelection;
  generation: number;
}

export interface CommitsState {
  // Active repository context and per-repository cache
  activeRepoPath: string | null;
  commitsByRepo: Record<string, RepoCommitsSlice>;
  generation: number;

  // Commits (for active repository)
  commits: Commit[];
  commitMap: Map<string, Commit>;
  isLoading: boolean;
  hasMore: boolean;

  // Graph layout
  graphLayout: GraphLayout | null;

  // Selection
  selection: GraphSelection;

  // Multi-tab & generation actions
  setActiveRepo: (repoPath: string | null) => void;
  nextGeneration: (repoPath?: string) => number;
  isGenerationValid: (generation: number, repoPath?: string) => boolean;
  evictRepo: (repoPath: string) => void;

  // Actions
  setCommits: (commits: Commit[], repoPath?: string) => void;
  appendCommits: (commits: Commit[], repoPath?: string) => void;
  setLoading: (loading: boolean, repoPath?: string) => void;
  setHasMore: (hasMore: boolean, repoPath?: string) => void;
  setGraphLayout: (layout: GraphLayout | null, repoPath?: string) => void;
  selectCommit: (oid: string | null) => void;
  hoverCommit: (oid: string | null) => void;
  setRangeSelection: (start: string | null, end: string | null) => void;
  getCommit: (oid: string, repoPath?: string) => Commit | undefined;
  reset: () => void;
}

const initialSelection: GraphSelection = {
  selectedOid: null,
  hoveredOid: null,
  rangeStart: null,
  rangeEnd: null,
};

function createEmptySlice(): RepoCommitsSlice {
  return {
    commits: [],
    commitMap: new Map<string, Commit>(),
    isLoading: false,
    hasMore: true,
    graphLayout: null,
    selection: { ...initialSelection },
    generation: 0,
  };
}

const initialState = {
  activeRepoPath: null as string | null,
  commitsByRepo: {} as Record<string, RepoCommitsSlice>,
  generation: 0,
  commits: [] as Commit[],
  commitMap: new Map<string, Commit>(),
  isLoading: false,
  hasMore: true,
  graphLayout: null as GraphLayout | null,
  selection: initialSelection,
};

export const commitsStore = createStore<CommitsState>((set, get) => ({
  ...initialState,

  setActiveRepo: (repoPath) =>
    set((state) => {
      if (state.activeRepoPath === repoPath) return state;
      const updatedByRepo = { ...state.commitsByRepo };
      if (state.activeRepoPath) {
        updatedByRepo[state.activeRepoPath] = {
          commits: state.commits,
          commitMap: state.commitMap,
          isLoading: state.isLoading,
          hasMore: state.hasMore,
          graphLayout: state.graphLayout,
          selection: state.selection,
          generation: state.generation,
        };
      }
      const nextSlice = (repoPath && updatedByRepo[repoPath]) || createEmptySlice();
      if (repoPath && !updatedByRepo[repoPath]) {
        updatedByRepo[repoPath] = nextSlice;
      }
      return {
        activeRepoPath: repoPath,
        commitsByRepo: updatedByRepo,
        commits: nextSlice.commits,
        commitMap: nextSlice.commitMap,
        isLoading: nextSlice.isLoading,
        hasMore: nextSlice.hasMore,
        graphLayout: nextSlice.graphLayout,
        selection: nextSlice.selection,
        generation: nextSlice.generation,
      };
    }),

  nextGeneration: (repoPath) => {
    let nextGen = 0;
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      if (targetRepo && targetRepo !== state.activeRepoPath) {
        const slice = state.commitsByRepo[targetRepo] ?? createEmptySlice();
        nextGen = slice.generation + 1;
        return {
          commitsByRepo: {
            ...state.commitsByRepo,
            [targetRepo]: { ...slice, generation: nextGen },
          },
        };
      }
      nextGen = state.generation + 1;
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              generation: nextGen,
            },
          }
        : state.commitsByRepo;
      return { generation: nextGen, commitsByRepo };
    });
    return nextGen;
  },

  isGenerationValid: (generation, repoPath) => {
    const state = get();
    const targetRepo = repoPath ?? state.activeRepoPath;
    if (targetRepo && targetRepo !== state.activeRepoPath) {
      const slice = state.commitsByRepo[targetRepo];
      return slice ? slice.generation === generation : false;
    }
    return state.generation === generation;
  },

  evictRepo: (repoPath) =>
    set((state) => {
      if (!(repoPath in state.commitsByRepo)) return state;
      const nextByRepo = { ...state.commitsByRepo };
      delete nextByRepo[repoPath];
      if (state.activeRepoPath === repoPath) {
        const empty = createEmptySlice();
        return {
          activeRepoPath: null,
          commitsByRepo: nextByRepo,
          ...empty,
        };
      }
      return { commitsByRepo: nextByRepo };
    }),

  setCommits: (commits, repoPath) => {
    const commitMap = new Map(commits.map((c) => [c.oid, c]));
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              commits,
              commitMap,
              hasMore: true,
            },
          }
        : state.commitsByRepo;

      if (targetRepo && targetRepo !== state.activeRepoPath) {
        return { commitsByRepo };
      }
      return { commits, commitMap, hasMore: true, commitsByRepo };
    });
  },

  appendCommits: (newCommits, repoPath) =>
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      if (targetRepo && targetRepo !== state.activeRepoPath) {
        const slice = state.commitsByRepo[targetRepo] ?? createEmptySlice();
        const commits = [...slice.commits, ...newCommits];
        const commitMap = new Map(commits.map((c) => [c.oid, c]));
        return {
          commitsByRepo: {
            ...state.commitsByRepo,
            [targetRepo]: { ...slice, commits, commitMap },
          },
        };
      }
      const commits = [...state.commits, ...newCommits];
      const commitMap = new Map(commits.map((c) => [c.oid, c]));
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              commits,
              commitMap,
            },
          }
        : state.commitsByRepo;
      return { commits, commitMap, commitsByRepo };
    }),

  setLoading: (isLoading, repoPath) =>
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              isLoading,
            },
          }
        : state.commitsByRepo;
      if (targetRepo && targetRepo !== state.activeRepoPath) {
        return { commitsByRepo };
      }
      return { isLoading, commitsByRepo };
    }),

  setHasMore: (hasMore, repoPath) =>
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              hasMore,
            },
          }
        : state.commitsByRepo;
      if (targetRepo && targetRepo !== state.activeRepoPath) {
        return { commitsByRepo };
      }
      return { hasMore, commitsByRepo };
    }),

  setGraphLayout: (graphLayout, repoPath) =>
    set((state) => {
      const targetRepo = repoPath ?? state.activeRepoPath;
      const commitsByRepo = targetRepo
        ? {
            ...state.commitsByRepo,
            [targetRepo]: {
              ...(state.commitsByRepo[targetRepo] ?? createEmptySlice()),
              graphLayout,
            },
          }
        : state.commitsByRepo;
      if (targetRepo && targetRepo !== state.activeRepoPath) {
        return { commitsByRepo };
      }
      return { graphLayout, commitsByRepo };
    }),

  selectCommit: (oid) =>
    set((state) => {
      const selection = { ...state.selection, selectedOid: oid };
      const commitsByRepo = state.activeRepoPath
        ? {
            ...state.commitsByRepo,
            [state.activeRepoPath]: {
              ...(state.commitsByRepo[state.activeRepoPath] ?? createEmptySlice()),
              selection,
            },
          }
        : state.commitsByRepo;
      return { selection, commitsByRepo };
    }),

  hoverCommit: (oid) =>
    set((state) => {
      const selection = { ...state.selection, hoveredOid: oid };
      const commitsByRepo = state.activeRepoPath
        ? {
            ...state.commitsByRepo,
            [state.activeRepoPath]: {
              ...(state.commitsByRepo[state.activeRepoPath] ?? createEmptySlice()),
              selection,
            },
          }
        : state.commitsByRepo;
      return { selection, commitsByRepo };
    }),

  setRangeSelection: (start, end) =>
    set((state) => {
      const selection = { ...state.selection, rangeStart: start, rangeEnd: end };
      const commitsByRepo = state.activeRepoPath
        ? {
            ...state.commitsByRepo,
            [state.activeRepoPath]: {
              ...(state.commitsByRepo[state.activeRepoPath] ?? createEmptySlice()),
              selection,
            },
          }
        : state.commitsByRepo;
      return { selection, commitsByRepo };
    }),

  getCommit: (oid, repoPath) => {
    const state = get();
    if (repoPath && repoPath !== state.activeRepoPath) {
      return state.commitsByRepo[repoPath]?.commitMap.get(oid);
    }
    return state.commitMap.get(oid);
  },

  reset: () =>
    set({
      ...initialState,
      commitMap: new Map<string, Commit>(),
      commitsByRepo: {},
      selection: { ...initialSelection },
    }),
}));

