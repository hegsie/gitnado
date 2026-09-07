export { repositoryStore, type RepositoryState, type OpenRepository, type RecentRepository } from './repository.store.ts';
export { commitsStore, type CommitsState } from './commits.store.ts';
export { uiStore, type UIState, type PanelId, type Toast } from './ui.store.ts';
export { settingsStore, type SettingsState, type Theme, type FontSize } from './settings.store.ts';
export { workflowStore, type WorkflowState, getProfileById, getDefaultProfile, hasProfiles } from './workflow.store.ts';
export { unifiedProfileStore, type UnifiedProfileState } from './unified-profile.store.ts';
export { workspaceStore, type WorkspaceState } from './workspace.store.ts';

// Re-import stores for test exposure
import { repositoryStore as repoStore } from './repository.store.ts';
import { commitsStore as cStore } from './commits.store.ts';
import { uiStore as uStore } from './ui.store.ts';
import { settingsStore as sStore } from './settings.store.ts';
import { unifiedProfileStore as upStore } from './unified-profile.store.ts';

// Expose stores on window for E2E testing (only in dev mode)
if (import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__GITNADO_STORES__ = {
    repositoryStore: repoStore,
    commitsStore: cStore,
    uiStore: uStore,
    settingsStore: sStore,
    unifiedProfileStore: upStore,
  };
}
