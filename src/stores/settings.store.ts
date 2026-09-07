/**
 * Settings Store
 * Persisted user preferences and application settings
 */

import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type GraphColorScheme = 'default' | 'pastel' | 'vibrant' | 'monochrome' | 'high-contrast';

export interface SettingsState {
  // Appearance
  theme: Theme;
  fontSize: FontSize;
  fontFamily: string;
  density: Density;

  // Git defaults
  defaultBranchName: string;
  defaultRemoteName: string;
  defaultClonePath: string;

  // Graph settings
  showAvatars: boolean;
  showCommitSize: boolean;
  graphRowHeight: number;
  graphColorScheme: GraphColorScheme;
  // False once the user picks a scheme themselves. While true the scheme
  // follows the OS: high contrast / forced colours select the high-contrast
  // palette, and turning them off puts it back to the default palette.
  graphColorSchemeAuto: boolean;
  // Whether the OS currently reports forced colours or a preference for more
  // contrast. Derived from matchMedia at startup and on every change, never a
  // user setting.
  systemHighContrast: boolean;

  // Diff settings
  diffContextLines: number;
  wordWrap: boolean;
  showWhitespace: boolean;

  // Behavior
  autoFetchInterval: number; // 0 = disabled, in minutes
  fetchOnFocus: boolean; // Fetch when window regains focus
  confirmBeforeDiscard: boolean;
  openLastRepository: boolean;
  autoStashOnCheckout: boolean; // Automatically stash/pop when switching branches

  // Branch settings
  staleBranchDays: number; // Days without commits before a branch is considered stale (0 = disabled)

  // Network settings
  networkOperationTimeout: number; // Seconds before network operations time out (0 = disabled)

  // Security & Privacy
  offlineMode: boolean;           // Block all network operations
  confirmNetworkOps: boolean;     // Prompt before fetch/push/pull
  remoteAllowlist: string[];      // If non-empty, only these domains are allowed

  // System tray & notifications
  minimizeToTray: boolean;
  showNativeNotifications: boolean;

  // Actions
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontFamily: (family: string) => void;
  setDensity: (density: Density) => void;
  setGraphColorScheme: (scheme: GraphColorScheme) => void;
  applySystemContrast: (highContrast: boolean) => void;
  setDefaultBranchName: (name: string) => void;
  setDefaultRemoteName: (name: string) => void;
  setDefaultClonePath: (path: string) => void;
  setShowAvatars: (show: boolean) => void;
  setShowCommitSize: (show: boolean) => void;
  setGraphRowHeight: (height: number) => void;
  setDiffContextLines: (lines: number) => void;
  setWordWrap: (wrap: boolean) => void;
  setShowWhitespace: (show: boolean) => void;
  setAutoFetchInterval: (minutes: number) => void;
  setFetchOnFocus: (enabled: boolean) => void;
  setConfirmBeforeDiscard: (confirm: boolean) => void;
  setOpenLastRepository: (open: boolean) => void;
  setAutoStashOnCheckout: (enabled: boolean) => void;
  setStaleBranchDays: (days: number) => void;
  setNetworkOperationTimeout: (timeout: number) => void;
  setOfflineMode: (enabled: boolean) => void;
  setConfirmNetworkOps: (enabled: boolean) => void;
  setRemoteAllowlist: (domains: string[]) => void;
  setMinimizeToTray: (enabled: boolean) => void;
  setShowNativeNotifications: (enabled: boolean) => void;
  resetToDefaults: () => void;
}

const defaultSettings = {
  theme: 'dark' as Theme,
  fontSize: 'medium' as FontSize,
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  density: 'comfortable' as Density,
  defaultBranchName: 'main',
  defaultRemoteName: 'origin',
  defaultClonePath: '',
  showAvatars: true,
  showCommitSize: true,
  graphRowHeight: 40,
  graphColorScheme: 'default' as GraphColorScheme,
  graphColorSchemeAuto: true,
  diffContextLines: 3,
  // Defaults OFF: until it was wired up nothing read this, and the diff view's
  // own copy — the only word wrap anyone has ever seen — defaulted to off.
  wordWrap: false,
  showWhitespace: false,
  autoFetchInterval: 0,
  fetchOnFocus: false,
  confirmBeforeDiscard: true,
  openLastRepository: true,
  // Defaults ON: until the setting was wired up it was never read and every
  // checkout auto-stashed, so `false` here would silently change behaviour for
  // every existing user — turning a seamless branch switch into a refusal.
  autoStashOnCheckout: true,
  staleBranchDays: 90,
  networkOperationTimeout: 300,
  offlineMode: false,
  confirmNetworkOps: false,
  remoteAllowlist: [] as string[],
  minimizeToTray: false,
  showNativeNotifications: true,
};

const LEGACY_DIFF_WORD_WRAP_KEY = 'gitnado-diff-word-wrap';

/**
 * The diff view used to keep word wrap in its own localStorage key, and its
 * toolbar button was the only control that did anything — `wordWrap` here was
 * read by nothing. That key holds the user's only real choice on the matter,
 * so adopt it once, then drop it.
 */
function adoptLegacyDiffWordWrap(state: SettingsState): void {
  let legacy: string | null;
  try {
    legacy = localStorage.getItem(LEGACY_DIFF_WORD_WRAP_KEY);
    if (legacy === null) return;
    localStorage.removeItem(LEGACY_DIFF_WORD_WRAP_KEY);
  } catch {
    return; // Storage unavailable — nothing to carry over.
  }
  state.setWordWrap(legacy === 'true');
}

/**
 * Persisted-state migration. Exported so the version-to-version rules can be
 * tested directly instead of through localStorage.
 */
export function migrateSettings(persisted: unknown, fromVersion: number): SettingsState {
  const state = { ...((persisted ?? {}) as Partial<SettingsState>) };
  if (fromVersion < 2) {
    state.autoStashOnCheckout = true;
  }
  if (fromVersion < 3) {
    state.wordWrap = false;
  }
  if (fromVersion < 4) {
    // The whole settings object is persisted the moment anything at all
    // changes, so the presence of `graphColorScheme` says nothing about whether
    // the user chose it. A value other than the default is the only evidence of
    // a deliberate choice: pin those, and leave everyone else — including every
    // user who never touched the setting — on the new automatic behaviour.
    state.graphColorSchemeAuto = (state.graphColorScheme ?? 'default') === 'default';
  }
  return state as SettingsState;
}

export const settingsStore = createStore<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      // Re-derived from matchMedia on every startup, so whatever was persisted
      // for it is irrelevant.
      systemHighContrast: false,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      setFontSize: (fontSize) => {
        set({ fontSize });
        applyFontSize(fontSize);
      },

      setFontFamily: (fontFamily) => set({ fontFamily }),

      setDensity: (density) => {
        set({ density });
        applyDensity(density);
      },

      // Choosing a scheme in Settings pins it: the OS high-contrast watcher
      // must never overwrite a deliberate choice.
      setGraphColorScheme: (graphColorScheme) => {
        set({ graphColorScheme, graphColorSchemeAuto: false });
        applyGraphColorScheme(graphColorScheme);
      },

      applySystemContrast: (systemHighContrast) => {
        set({ systemHighContrast });
        const state = get();
        if (!state.graphColorSchemeAuto) return;
        const next: GraphColorScheme = systemHighContrast
          ? 'high-contrast'
          : defaultSettings.graphColorScheme;
        if (next !== state.graphColorScheme) {
          set({ graphColorScheme: next });
        }
        // Applied even when the scheme is unchanged: this also runs at startup,
        // where the palette variables have not been written to the document yet.
        applyGraphColorScheme(next);
      },

      setDefaultBranchName: (defaultBranchName) => set({ defaultBranchName }),

      setDefaultRemoteName: (defaultRemoteName) => set({ defaultRemoteName }),

      setDefaultClonePath: (defaultClonePath) => set({ defaultClonePath }),

      setShowAvatars: (showAvatars) => set({ showAvatars }),

      setShowCommitSize: (showCommitSize) => set({ showCommitSize }),

      setGraphRowHeight: (graphRowHeight) => set({ graphRowHeight }),

      setDiffContextLines: (diffContextLines) => set({ diffContextLines }),

      setWordWrap: (wordWrap) => set({ wordWrap }),

      setShowWhitespace: (showWhitespace) => set({ showWhitespace }),

      setAutoFetchInterval: (autoFetchInterval) => set({ autoFetchInterval }),

      setFetchOnFocus: (fetchOnFocus) => set({ fetchOnFocus }),

      setConfirmBeforeDiscard: (confirmBeforeDiscard) => set({ confirmBeforeDiscard }),

      setOpenLastRepository: (openLastRepository) => set({ openLastRepository }),

      setAutoStashOnCheckout: (autoStashOnCheckout) => set({ autoStashOnCheckout }),

      setStaleBranchDays: (staleBranchDays) => set({ staleBranchDays }),

      setNetworkOperationTimeout: (networkOperationTimeout) => set({ networkOperationTimeout }),

      setOfflineMode: (offlineMode) => set({ offlineMode }),
      setConfirmNetworkOps: (confirmNetworkOps) => set({ confirmNetworkOps }),
      setRemoteAllowlist: (remoteAllowlist) => set({ remoteAllowlist }),

      setMinimizeToTray: (minimizeToTray) => set({ minimizeToTray }),

      setShowNativeNotifications: (showNativeNotifications) => set({ showNativeNotifications }),

      resetToDefaults: () => {
        // The OS contrast reading is not a preference, so a reset re-reads it
        // rather than clearing it — and re-applies the auto scheme from it.
        const { systemHighContrast } = get();
        set({ ...defaultSettings, systemHighContrast });
        applyTheme(defaultSettings.theme);
        applyFontSize(defaultSettings.fontSize);
        applyDensity(defaultSettings.density);
        applyGraphColorScheme(defaultSettings.graphColorScheme);
        get().applySystemContrast(systemHighContrast);
      },
    }),
    {
      name: 'gitnado-settings',
      version: 4,
      // Changing a default only affects installs with no persisted state.
      // zustand's default merge is a shallow `{...defaults, ...persisted}`, and
      // the whole settings object is persisted the moment the user changes
      // anything at all — so every existing user carried the old
      // `autoStashOnCheckout: false` over the new default and still got a
      // refused checkout. That `false` was never a user choice: the setting was
      // not read by anything until it was wired up, so every one of those users
      // has only ever experienced auto-stashing. `wordWrap` has exactly the same
      // story: it was persisted but never read, so a persisted value is not a
      // user choice either and is dropped in favour of the diff view's own key.
      migrate: migrateSettings,
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme);
          applyFontSize(state.fontSize);
          applyDensity(state.density);
          applyGraphColorScheme(state.graphColorScheme);
          adoptLegacyDiffWordWrap(state);
        }
      },
    }
  )
);

/**
 * Apply theme to document
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/**
 * Apply font size to document
 */
function applyFontSize(size: FontSize): void {
  const root = document.documentElement;
  const sizes = {
    small: '12px',
    medium: '14px',
    large: '16px',
  };
  root.style.setProperty('--base-font-size', sizes[size]);
}

/**
 * Apply density settings to document
 */
function applyDensity(density: Density): void {
  const root = document.documentElement;
  const settings = {
    compact: {
      rowHeight: '28px',
      spacing: '4px',
      padding: '4px 8px',
      graphRowHeight: '28',
    },
    comfortable: {
      rowHeight: '36px',
      spacing: '8px',
      padding: '8px 12px',
      graphRowHeight: '36',
    },
    spacious: {
      rowHeight: '44px',
      spacing: '12px',
      padding: '12px 16px',
      graphRowHeight: '44',
    },
  };
  const s = settings[density];
  root.style.setProperty('--density-row-height', s.rowHeight);
  root.style.setProperty('--density-spacing', s.spacing);
  root.style.setProperty('--density-padding', s.padding);
  root.style.setProperty('--density-graph-row-height', s.graphRowHeight);
  root.setAttribute('data-density', density);
}

/**
 * Graph color scheme presets
 */
const graphColorSchemes: Record<GraphColorScheme, string[]> = {
  default: [
    '#4fc3f7', '#81c784', '#ef5350', '#ffb74d',
    '#ce93d8', '#4dd0e1', '#ff8a65', '#aed581',
  ],
  pastel: [
    '#b3e5fc', '#c8e6c9', '#ffcdd2', '#ffe0b2',
    '#e1bee7', '#b2ebf2', '#ffccbc', '#dcedc8',
  ],
  vibrant: [
    '#00bcd4', '#4caf50', '#f44336', '#ff9800',
    '#9c27b0', '#00acc1', '#ff5722', '#8bc34a',
  ],
  monochrome: [
    '#90caf9', '#a5d6a7', '#ef9a9a', '#ffe082',
    '#ce93d8', '#80deea', '#ffab91', '#c5e1a5',
  ],
  'high-contrast': [
    '#00e5ff', '#00e676', '#ff1744', '#ffea00',
    '#d500f9', '#18ffff', '#ff3d00', '#76ff03',
  ],
};

/**
 * Apply graph color scheme to CSS variables
 */
function applyGraphColorScheme(scheme: GraphColorScheme): void {
  const root = document.documentElement;
  const colors = graphColorSchemes[scheme];
  colors.forEach((color, i) => {
    root.style.setProperty(`--color-branch-${i + 1}`, color);
  });
  root.setAttribute('data-graph-scheme', scheme);
}

/**
 * Get available graph color schemes for UI
 */
export function getGraphColorSchemes(): { id: GraphColorScheme; name: string; colors: string[] }[] {
  return [
    { id: 'default', name: 'Default', colors: graphColorSchemes.default },
    { id: 'pastel', name: 'Pastel', colors: graphColorSchemes.pastel },
    { id: 'vibrant', name: 'Vibrant', colors: graphColorSchemes.vibrant },
    { id: 'monochrome', name: 'Monochrome', colors: graphColorSchemes.monochrome },
    { id: 'high-contrast', name: 'High Contrast', colors: graphColorSchemes['high-contrast'] },
  ];
}

/**
 * The queries that mean "this user needs maximum contrast". Forced colours is
 * Windows High Contrast Mode; prefers-contrast covers the equivalent settings
 * on macOS/Linux and browser-level increased-contrast preferences.
 */
const HIGH_CONTRAST_QUERIES = ['(forced-colors: active)', '(prefers-contrast: more)'];

/**
 * Follow the OS contrast setting for the graph colour scheme.
 *
 * The commit graph is painted into a <canvas>, so forced-colors can't recolour
 * it the way it recolours DOM — the app has to pick a high-contrast palette
 * itself. Only applies while the scheme is on "auto"; the moment the user picks
 * a scheme in Settings this becomes a no-op for the palette (it still tracks
 * `systemHighContrast` so the UI can explain itself).
 *
 * Returns a disposer that removes the listeners.
 */
export function watchSystemContrast(): () => void {
  const queries = HIGH_CONTRAST_QUERIES.map((q) => window.matchMedia(q));
  const update = (): void => {
    settingsStore.getState().applySystemContrast(queries.some((q) => q.matches));
  };
  queries.forEach((q) => q.addEventListener('change', update));
  update();
  return () => queries.forEach((q) => q.removeEventListener('change', update));
}

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme } = settingsStore.getState();
    if (theme === 'system') {
      applyTheme('system');
    }
  });

  // Listen for system contrast changes (Windows High Contrast Mode et al.)
  watchSystemContrast();
}
