/**
 * Workspace Store
 * Only activeWorkspaceId is persisted to localStorage.
 * Workspace data is always loaded from Rust backend.
 */

import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';
import type { Workspace } from '../types/git.types.ts';

export interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setWorkspaces: (workspaces: Workspace[]) => void;
  addOrUpdateWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (workspaceId: string) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const defaultState = {
  workspaces: [] as Workspace[],
  activeWorkspaceId: null as string | null,
  isLoading: false,
  error: null as string | null,
};

export const workspaceStore = createStore<WorkspaceState>()(
  persist(
    (set) => ({
      ...defaultState,

      setWorkspaces: (workspaces) => set({ workspaces }),

      addOrUpdateWorkspace: (workspace) =>
        set((state) => {
          const idx = state.workspaces.findIndex((w) => w.id === workspace.id);
          if (idx >= 0) {
            const updated = [...state.workspaces];
            updated[idx] = workspace;
            return { workspaces: updated };
          }
          return { workspaces: [...state.workspaces, workspace] };
        }),

      removeWorkspace: (workspaceId) =>
        set((state) => ({
          workspaces: state.workspaces.filter((w) => w.id !== workspaceId),
          activeWorkspaceId:
            state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
        })),

      setActiveWorkspaceId: (activeWorkspaceId) => set({ activeWorkspaceId }),

      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error }),

      reset: () => set(defaultState),
    }),
    {
      name: 'gitnado-workspaces',
      version: 1,
      partialize: (state) => ({ activeWorkspaceId: state.activeWorkspaceId }),
    }
  )
);
