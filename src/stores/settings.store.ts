/**
 * Settings Store
 * Persisted user preferences and application settings
 */

import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';
import type { DiffWhitespaceMode } from '../types/api.types.ts';
import { msg } from '@lit/localize';
import { detectSystemLocale, resolveLocale, setAppLocale, type Locale } from '../i18n/index.ts';

export type Theme = 'dark' | 'light' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type GraphColorScheme = 'default' | 'pastel' | 'vibrant' | 'monochrome' | 'high-contrast';

/**
 * Bounds for `diffContextLines`. git's own default is 3; 20 is plenty of
 * surrounding context for reading a hunk and keeps a mistyped number from
 * asking the backend to render most of the file. The backend has no
 * "whole file" context option, so neither does the UI.
 */
export const MIN_DIFF_CONTEXT_LINES = 0;
export const MAX_DIFF_CONTEXT_LINES = 20;

/** Clamp any user- or storage-supplied context-line value into range. */
export function clampDiffContextLines(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(MAX_DIFF_CONTEXT_LINES, Math.max(MIN_DIFF_CONTEXT_LINES, Math.trunc(value)));
}

/**
 * Labels for the whitespace modes the backend implements, in menu order.
 *
 * Source-locale labels, for the surfaces that have not been migrated to
 * `msg()` yet (the diff view's own toolbar). Localised surfaces call
 * `getDiffWhitespaceModes()` instead — the two lists carry the same modes in
 * the same order.
 */
export const DIFF_WHITESPACE_MODES: { value: DiffWhitespaceMode; label: string }[] = [
  { value: 'none', label: 'Show all whitespace' },
  { value: 'eol', label: 'Ignore trailing whitespace' },
  { value: 'change', label: 'Ignore whitespace changes' },
  { value: 'all', label: 'Ignore all whitespace' },
];

/**
 * The whitespace modes with their labels in the ACTIVE locale.
 *
 * A function rather than a constant for the same reason as
 * `getGraphColorSchemes()`: `msg()` evaluated at module scope would freeze the
 * labels at whatever locale happened to be active when the module was first
 * imported, so switching language would leave this menu in the old one.
 */
export function getDiffWhitespaceModes(): { value: DiffWhitespaceMode; label: string }[] {
  return [
    { value: 'none', label: msg('Show all whitespace') },
    { value: 'eol', label: msg('Ignore trailing whitespace') },
    { value: 'change', label: msg('Ignore whitespace changes') },
    { value: 'all', label: msg('Ignore all whitespace') },
  ];
}

export interface SettingsState {
  // Appearance
  language: Locale;
  theme: Theme;
  fontSize: FontSize;
  fontFamily: string;
  density: Density;

  // Git defaults
  defaultBranchName: string;
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
  /** Whitespace mode sent to the diff commands ('none' shows every change). */
  diffIgnoreWhitespace: DiffWhitespaceMode;

  // Behavior
  autoFetchInterval: number; // 0 = disabled, in minutes
  fetchOnFocus: boolean; // Fetch when window regains focus
  confirmBeforeDiscard: boolean;
  openLastRepository: boolean;
  autoStashOnCheckout: boolean; // Automatically stash/pop when switching branches
  alwaysSignOff: boolean; // Start every new commit message with Sign off enabled

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
  /**
   * Switch the UI language. Async because the locale's templates are fetched on
   * demand; resolves with the locale that actually ended up rendering, which is
   * the previous one when the templates could not be loaded.
   */
  setLanguage: (locale: string) => Promise<Locale>;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontFamily: (family: string) => void;
  setDensity: (density: Density) => void;
  setGraphColorScheme: (scheme: GraphColorScheme) => void;
  applySystemContrast: (highContrast: boolean) => void;
  setDefaultBranchName: (name: string) => void;
  setDefaultClonePath: (path: string) => void;
  setShowAvatars: (show: boolean) => void;
  setShowCommitSize: (show: boolean) => void;
  setGraphRowHeight: (height: number) => void;
  setDiffContextLines: (lines: number) => void;
  setWordWrap: (wrap: boolean) => void;
  setDiffIgnoreWhitespace: (mode: DiffWhitespaceMode) => void;
  setAutoFetchInterval: (minutes: number) => void;
  setFetchOnFocus: (enabled: boolean) => void;
  setConfirmBeforeDiscard: (confirm: boolean) => void;
  setOpenLastRepository: (open: boolean) => void;
  setAutoStashOnCheckout: (enabled: boolean) => void;
  setAlwaysSignOff: (enabled: boolean) => void;
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
  // The system language when we ship it, English otherwise.
  language: detectSystemLocale(),
  theme: 'dark' as Theme,
  fontSize: 'medium' as FontSize,
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  density: 'comfortable' as Density,
  defaultBranchName: 'main',
  defaultClonePath: '',
  // Defaults OFF: avatars are images fetched from gravatar.com, which hands a
  // third party an MD5 of every commit author's email and this machine's IP.
  // A privacy-first client does not do that until the user asks for it.
  // Existing installs keep whatever they had — see the v5 migration below.
  showAvatars: false,
  showCommitSize: true,
  graphRowHeight: 40,
  graphColorScheme: 'default' as GraphColorScheme,
  graphColorSchemeAuto: true,
  diffContextLines: 3,
  // Defaults OFF: until it was wired up nothing read this, and the diff view's
  // own copy — the only word wrap anyone has ever seen — defaulted to off.
  wordWrap: false,
  // 'none' is the behaviour every diff has always had, so it stays the default.
  diffIgnoreWhitespace: 'none' as DiffWhitespaceMode,
  autoFetchInterval: 0,
  fetchOnFocus: false,
  confirmBeforeDiscard: true,
  openLastRepository: true,
  // Defaults ON: until the setting was wired up it was never read and every
  // checkout auto-stashed, so `false` here would silently change behaviour for
  // every existing user — turning a seamless branch switch into a refusal.
  autoStashOnCheckout: true,
  // Defaults OFF: sign-off is a project requirement, not a universal one, and
  // adding a trailer nobody asked for would rewrite every commit message.
  alwaysSignOff: false,
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
  if (fromVersion < 5 && state.showAvatars === undefined) {
    // v5 flips the `showAvatars` default to `false` so a fresh install never
    // talks to gravatar.com unasked. Unlike `autoStashOnCheckout`/`wordWrap`,
    // this setting was always read — avatars have always been drawn — so a
    // persisted value is a real user choice and the shallow merge rightly
    // preserves it. Only a pre-v5 state that predates the key needs the OLD
    // default filled in, so those users keep seeing what they saw before.
    state.showAvatars = true;
  }
  if (fromVersion < 6) {
    // `showWhitespace` had the same story again: persisted, never read, so its
    // stored value was never a user choice. It is replaced by the four-mode
    // `diffIgnoreWhitespace`, which starts at the behaviour every diff has
    // always had.
    delete (state as Record<string, unknown>).showWhitespace;
    state.diffIgnoreWhitespace = 'none';
  }
  if (fromVersion < 7) {
    // `defaultRemoteName` was removed: nothing ever read it, and which remote
    // fetch/pull/push contact is answered by git's own config (the branch's
    // upstream, branch.<name>.pushRemote, remote.pushDefault) rather than by an
    // app preference. Drop the stale key so it stops riding along in every
    // persisted blob.
    delete (state as Record<string, unknown>).defaultRemoteName;
  }
  if (fromVersion < 8 && state.language === undefined) {
    // v8 adds `language`, whose fresh-install default is the OS language.
    // Every pre-v8 blob predates the key, and every one of those installs has
    // only ever rendered in English — so letting the shallow merge fill the
    // gap from the default would switch a French-locale machine's whole UI to
    // French on the first launch after an upgrade, unasked and with no prompt.
    // Detecting the system locale is what a FIRST run does; an existing
    // install keeps the language it has always had until the user picks
    // another in Settings.
    state.language = 'en';
  }
  // A persisted context-line count predates any bound being enforced, and is
  // also the one setting a user could have hand-edited in storage. Applied on
  // every migration, not just one step, so no stored value escapes the bounds.
  if (state.diffContextLines !== undefined) {
    state.diffContextLines = clampDiffContextLines(Number(state.diffContextLines));
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

      setLanguage: async (locale) => {
        // Persist only what actually rendered: a locale whose templates failed
        // to load must not come back on the next launch.
        const applied = await setAppLocale(resolveLocale(locale));
        set({ language: applied });
        return applied;
      },

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

      setDefaultClonePath: (defaultClonePath) => set({ defaultClonePath }),

      setShowAvatars: (showAvatars) => set({ showAvatars }),

      setShowCommitSize: (showCommitSize) => set({ showCommitSize }),

      setGraphRowHeight: (graphRowHeight) => set({ graphRowHeight }),

      // Clamped here rather than at each control, so a stepper, the Settings
      // dialog and a hand-edited persisted value can never disagree about what
      // is in range.
      setDiffContextLines: (diffContextLines) =>
        set({ diffContextLines: clampDiffContextLines(diffContextLines) }),

      setWordWrap: (wordWrap) => set({ wordWrap }),

      setDiffIgnoreWhitespace: (diffIgnoreWhitespace) => set({ diffIgnoreWhitespace }),

      setAutoFetchInterval: (autoFetchInterval) => set({ autoFetchInterval }),

      setFetchOnFocus: (fetchOnFocus) => set({ fetchOnFocus }),

      setConfirmBeforeDiscard: (confirmBeforeDiscard) => set({ confirmBeforeDiscard }),

      setOpenLastRepository: (openLastRepository) => set({ openLastRepository }),

      setAutoStashOnCheckout: (autoStashOnCheckout) => set({ autoStashOnCheckout }),

      setAlwaysSignOff: (alwaysSignOff) => set({ alwaysSignOff }),

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
        void setAppLocale(defaultSettings.language);
        applyTheme(defaultSettings.theme);
        applyFontSize(defaultSettings.fontSize);
        applyDensity(defaultSettings.density);
        applyGraphColorScheme(defaultSettings.graphColorScheme);
        get().applySystemContrast(systemHighContrast);
      },
    }),
    {
      name: 'gitnado-settings',
      version: 8,
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
      //
      // `showAvatars` is the opposite case: it WAS read — avatars have always
      // been drawn — so a persisted value is a real user choice and the v5
      // default flip to `false` must not reach it. See `migrateSettings`.
      //
      // `language` is a third shape again: the key is NEW, so no persisted blob
      // has it, and its fresh-install default (the OS language) is exactly what
      // an upgrade must not apply — see the v8 rule in `migrateSettings`.
      migrate: migrateSettings,
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Goes through the action so a persisted locale we no longer ship is
          // sanitised back to English instead of throwing on every render.
          void state.setLanguage(state.language);
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
 * Apply the persisted language at startup.
 *
 * Goes through the store action rather than calling `setAppLocale()` directly:
 * the action writes back the locale that ACTUALLY rendered, so a persisted
 * language whose templates fail to load — or that we no longer ship — is
 * corrected in storage instead of leaving the Settings picker naming a
 * language the UI is not in. That is the same contract the picker itself
 * relies on when the user changes language.
 *
 * Resolves with the locale that ended up active.
 */
export function applyPersistedLocale(): Promise<Locale> {
  return settingsStore.getState().setLanguage(settingsStore.getState().language);
}

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
    { id: 'default', name: msg('Default'), colors: graphColorSchemes.default },
    { id: 'pastel', name: msg('Pastel'), colors: graphColorSchemes.pastel },
    { id: 'vibrant', name: msg('Vibrant'), colors: graphColorSchemes.vibrant },
    { id: 'monochrome', name: msg('Monochrome'), colors: graphColorSchemes.monochrome },
    { id: 'high-contrast', name: msg('High Contrast'), colors: graphColorSchemes['high-contrast'] },
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
