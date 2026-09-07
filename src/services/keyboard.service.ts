/**
 * Keyboard Shortcuts Service
 * Global keyboard shortcut handling for the application
 */

import { isOverlayOpen } from '../utils/overlay-stack.ts';

export interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  action: () => void;
  description: string;
  category: string;
}

/** Serializable shortcut binding (without action) */
export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface ShortcutRegistration {
  id: string;
  shortcut: Shortcut;
}

export interface KeyboardSettings {
  vimMode: boolean;
  /** Map of shortcut ID to custom binding (serialized) */
  customBindings: Record<string, ShortcutBinding>;
}

/**
 * The one place shortcut customizations live. Bindings, their action IDs, and
 * their persistence all belong to this service — a second table of action IDs
 * kept anywhere else silently drifts out of sync with what
 * registerDefaultShortcuts actually registers, and nothing that reads it can
 * act on the difference.
 */
const STORAGE_KEY = 'gitnado-keyboard-settings';

class KeyboardService {
  /**
   * Key combos the browser reserves for editing text. While the caret is in an
   * input, textarea, or contenteditable these belong to the field, so a global
   * shortcut must never claim them — undo/redo, select-all, and clipboard are
   * reflexes users expect to work in every text box.
   */
  private static readonly NATIVE_EDITING_KEYS: ReadonlySet<string> = new Set([
    'mod+z',
    'mod+shift+z',
    'mod+y',
    'mod+a',
    'mod+x',
    'mod+c',
    'mod+v',
  ]);

  private shortcuts: Map<string, Shortcut> = new Map();
  /** Map of shortcut ID to default binding */
  private defaultBindings: Map<string, ShortcutBinding> = new Map();
  /** Map of shortcut ID to custom binding (if different from default) */
  private customBindings: Map<string, ShortcutBinding> = new Map();
  /** Map of shortcut ID to its metadata (description, category, action) */
  private shortcutMetadata: Map<string, { description: string; category: string; action: () => void }> = new Map();
  /** Reverse mapping from key combo to shortcut ID for O(1) lookups */
  private keyToId: Map<string, string> = new Map();
  private enabled = true;
  private listeners: Set<(e: KeyboardEvent) => void> = new Set();
  private settingsChangeListeners: Set<() => void> = new Set();
  private vimMode = false;
  private vimPendingKey: string | null = null;
  private vimPendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private vimActions: {
    navigateUp?: () => void;
    navigateDown?: () => void;
    navigateFirst?: () => void;
    navigateLast?: () => void;
    pageUp?: () => void;
    pageDown?: () => void;
    openSearch?: () => void;
    select?: () => void;
  } = {};

  constructor() {
    this.handleKeyDown = this.handleKeyDown.bind(this);
    document.addEventListener('keydown', this.handleKeyDown);
    this.loadSettings();
  }

  private loadSettings(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const settings: KeyboardSettings = JSON.parse(stored);
        this.vimMode = settings.vimMode ?? false;
        // Load custom bindings
        if (settings.customBindings) {
          for (const [id, binding] of Object.entries(settings.customBindings)) {
            this.customBindings.set(id, binding);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  private saveSettings(): void {
    try {
      const customBindingsObj: Record<string, ShortcutBinding> = {};
      for (const [id, binding] of this.customBindings.entries()) {
        customBindingsObj[id] = binding;
      }
      const settings: KeyboardSettings = {
        vimMode: this.vimMode,
        customBindings: customBindingsObj,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Generate a unique key for a shortcut combo
   */
  private getShortcutKey(e: KeyboardEvent | Shortcut): string {
    const ctrl = 'ctrlKey' in e ? e.ctrlKey : e.ctrl;
    const shift = 'shiftKey' in e ? e.shiftKey : e.shift;
    const alt = 'altKey' in e ? e.altKey : e.alt;
    const meta = 'metaKey' in e ? e.metaKey : e.meta;
    const key = e.key.toLowerCase();

    // For a single non-alphanumeric character the shift state is already
    // encoded in the character itself: you cannot type "?" without whatever
    // modifier your layout requires, and on some layouts that is not Shift at
    // all. Including it would make the same keypress hash differently
    // depending on the layout — and made the "?" shortcut match only when the
    // event happened to carry shiftKey. Letters and digits still need it,
    // since "shift+a" and "a" are genuinely different bindings.
    // Caselessness, not "non-alphanumeric". The ASCII test this replaced was
    // true for ' ' — collapsing Shift+Space onto Space and making Shift+Space
    // unbindable — and for every accented or non-Latin letter, so Shift+ü and
    // ü collided too. A character with no case distinction is one whose shift
    // state is already baked into the character; Space is the exception, since
    // shifted and unshifted both report ' '.
    const shiftIsRedundant =
      key.length === 1 && key !== ' ' && key.toUpperCase() === key.toLowerCase();

    const parts: string[] = [];
    if (ctrl || meta) parts.push('mod');
    if (shift && !shiftIsRedundant) parts.push('shift');
    if (alt) parts.push('alt');
    parts.push(key);

    return parts.join('+');
  }

  /**
   * Register a keyboard shortcut
   */
  register(id: string, shortcut: Shortcut): void {
    // Store the default binding
    const defaultBinding: ShortcutBinding = {
      key: shortcut.key,
      ctrl: shortcut.ctrl,
      shift: shortcut.shift,
      alt: shortcut.alt,
      meta: shortcut.meta,
    };
    this.defaultBindings.set(id, defaultBinding);

    // Store metadata (description, category, action)
    this.shortcutMetadata.set(id, {
      description: shortcut.description,
      category: shortcut.category,
      action: shortcut.action,
    });

    // Use custom binding if available, otherwise use default
    const activeBinding = this.customBindings.get(id) ?? defaultBinding;
    const activeShortcut: Shortcut = {
      ...activeBinding,
      description: shortcut.description,
      category: shortcut.category,
      action: shortcut.action,
    };

    const key = this.getShortcutKey(activeShortcut);
    this.shortcuts.set(key, activeShortcut);
    // Maintain reverse mapping for O(1) lookups
    this.keyToId.set(key, id);
  }

  /**
   * Unregister a keyboard shortcut
   */
  unregister(id: string): void {
    // Find and remove using reverse mapping
    const binding = this.customBindings.get(id) ?? this.defaultBindings.get(id);
    if (binding) {
      const metadata = this.shortcutMetadata.get(id);
      if (metadata) {
        const shortcut: Shortcut = { ...binding, ...metadata };
        const key = this.getShortcutKey(shortcut);
        this.shortcuts.delete(key);
        this.keyToId.delete(key);
      }
    }
    this.defaultBindings.delete(id);
    this.customBindings.delete(id);
    this.shortcutMetadata.delete(id);
  }

  /**
   * Rebind a shortcut to a new key combination
   */
  rebind(id: string, newBinding: ShortcutBinding): boolean {
    const metadata = this.shortcutMetadata.get(id);
    if (!metadata) return false;

    // Check for conflicts with existing bindings
    const testShortcut: Shortcut = { ...newBinding, ...metadata };
    const newKey = this.getShortcutKey(testShortcut);

    // Get the current binding to find the old key
    const currentBinding = this.customBindings.get(id) ?? this.defaultBindings.get(id);
    let oldKey: string | undefined;
    if (currentBinding) {
      const oldShortcut: Shortcut = { ...currentBinding, ...metadata };
      oldKey = this.getShortcutKey(oldShortcut);
    }

    // Check if new key is already taken by a different shortcut
    const existingId = this.keyToId.get(newKey);
    if (existingId && existingId !== id) {
      // Conflict with a different shortcut
      return false;
    }

    // Remove the old binding
    if (oldKey) {
      this.shortcuts.delete(oldKey);
      this.keyToId.delete(oldKey);
    }

    // Save the custom binding
    this.customBindings.set(id, newBinding);
    this.saveSettings();

    // Register the new binding
    this.shortcuts.set(newKey, testShortcut);
    this.keyToId.set(newKey, id);

    // Notify listeners
    this.notifySettingsChange();
    return true;
  }

  /**
   * Reset a shortcut to its default binding
   */
  resetBinding(id: string): void {
    const metadata = this.shortcutMetadata.get(id);
    const defaultBinding = this.defaultBindings.get(id);
    if (!metadata || !defaultBinding) return;

    // Get the current (custom) binding to find and remove the old key
    const currentBinding = this.customBindings.get(id);
    if (currentBinding) {
      const oldShortcut: Shortcut = { ...currentBinding, ...metadata };
      const oldKey = this.getShortcutKey(oldShortcut);
      this.shortcuts.delete(oldKey);
      this.keyToId.delete(oldKey);
    }

    // Remove custom binding
    this.customBindings.delete(id);
    this.saveSettings();

    // Register the default binding
    const shortcut: Shortcut = { ...defaultBinding, ...metadata };
    const key = this.getShortcutKey(shortcut);
    this.shortcuts.set(key, shortcut);
    this.keyToId.set(key, id);

    // Notify listeners
    this.notifySettingsChange();
  }

  /**
   * Reset all shortcuts to default bindings
   */
  resetAllBindings(): void {
    this.customBindings.clear();
    this.saveSettings();

    // Rebuild shortcuts map and reverse mapping with defaults
    this.shortcuts.clear();
    this.keyToId.clear();
    for (const [id, metadata] of this.shortcutMetadata.entries()) {
      const defaultBinding = this.defaultBindings.get(id);
      if (defaultBinding) {
        const shortcut: Shortcut = { ...defaultBinding, ...metadata };
        const key = this.getShortcutKey(shortcut);
        this.shortcuts.set(key, shortcut);
        this.keyToId.set(key, id);
      }
    }

    // Notify listeners
    this.notifySettingsChange();
  }

  /**
   * Get the current binding for a shortcut (custom or default)
   */
  getBinding(id: string): ShortcutBinding | undefined {
    return this.customBindings.get(id) ?? this.defaultBindings.get(id);
  }

  /**
   * Get the default binding for a shortcut
   */
  getDefaultBinding(id: string): ShortcutBinding | undefined {
    return this.defaultBindings.get(id);
  }

  /**
   * Check if a shortcut has been customized
   */
  isCustomized(id: string): boolean {
    return this.customBindings.has(id);
  }

  /**
   * Get all shortcut IDs with their bindings
   */
  getAllBindings(): Array<{
    id: string;
    binding: ShortcutBinding;
    defaultBinding: ShortcutBinding;
    description: string;
    category: string;
    isCustomized: boolean;
  }> {
    const result: Array<{
      id: string;
      binding: ShortcutBinding;
      defaultBinding: ShortcutBinding;
      description: string;
      category: string;
      isCustomized: boolean;
    }> = [];

    for (const [id, metadata] of this.shortcutMetadata.entries()) {
      const defaultBinding = this.defaultBindings.get(id);
      if (defaultBinding) {
        const customBinding = this.customBindings.get(id);
        result.push({
          id,
          binding: customBinding ?? defaultBinding,
          defaultBinding,
          description: metadata.description,
          category: metadata.category,
          isCustomized: !!customBinding,
        });
      }
    }

    return result;
  }

  /**
   * Add a listener for settings changes
   */
  addSettingsChangeListener(listener: () => void): () => void {
    this.settingsChangeListeners.add(listener);
    return () => this.settingsChangeListeners.delete(listener);
  }

  /**
   * Notify settings change listeners
   */
  private notifySettingsChange(): void {
    for (const listener of this.settingsChangeListeners) {
      listener();
    }
  }

  /**
   * Handle vim-style navigation
   */
  private handleVimKey(e: KeyboardEvent): boolean {
    if (!this.vimMode) return false;

    const key = e.key.toLowerCase();

    // Handle Ctrl+d (page down) and Ctrl+u (page up)
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (key === 'd' && this.vimActions.pageDown) {
        e.preventDefault();
        this.vimActions.pageDown();
        return true;
      }
      if (key === 'u' && this.vimActions.pageUp) {
        e.preventDefault();
        this.vimActions.pageUp();
        return true;
      }
    }

    // Don't process other vim keys if modifier keys are pressed (except shift for G)
    if (e.ctrlKey || e.metaKey || e.altKey) return false;

    // Handle pending 'g' for 'gg' command
    if (this.vimPendingKey === 'g') {
      this.vimPendingKey = null;
      if (key === 'g' && this.vimActions.navigateFirst) {
        e.preventDefault();
        this.vimActions.navigateFirst();
        return true;
      }
      // Not a valid sequence, don't consume
      return false;
    }

    // j - down
    if (key === 'j' && this.vimActions.navigateDown) {
      e.preventDefault();
      this.vimActions.navigateDown();
      return true;
    }

    // k - up
    if (key === 'k' && this.vimActions.navigateUp) {
      e.preventDefault();
      this.vimActions.navigateUp();
      return true;
    }

    // G (shift+g) - go to end
    if (e.key === 'G' && e.shiftKey && this.vimActions.navigateLast) {
      e.preventDefault();
      this.vimActions.navigateLast();
      return true;
    }

    // g - start of 'gg' command
    if (key === 'g' && !e.shiftKey) {
      this.vimPendingKey = 'g';
      // Clear any existing timeout
      if (this.vimPendingTimeout) {
        clearTimeout(this.vimPendingTimeout);
      }
      // Set timeout to clear pending key
      this.vimPendingTimeout = setTimeout(() => {
        this.vimPendingKey = null;
        this.vimPendingTimeout = null;
      }, 500);
      return true;
    }

    // / - open search
    if (e.key === '/' && this.vimActions.openSearch) {
      e.preventDefault();
      this.vimActions.openSearch();
      return true;
    }

    // o or Enter - select/open
    if ((key === 'o' || e.key === 'Enter') && this.vimActions.select) {
      e.preventDefault();
      this.vimActions.select();
      return true;
    }

    return false;
  }

  /**
   * Handle keydown events
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;

    // A modal owns the keyboard while it is up. Every shortcut here is
    // registered on `document` and fired regardless of what was on screen, so
    // a plain `s` behind an open dialog staged the entire working tree and `u`
    // unstaged it — invisibly, because the overlay covers the file-status
    // panel the change would have shown up in. The Keyboard Shortcuts dialog
    // was the worst of it: the one screen where users press a key to see what
    // it does, and it silenced the service only while RECORDING a new binding.
    // Combos carrying Ctrl/Cmd stay live: those are deliberate and
    // unambiguous, and dialogs are opened with them (Cmd+P, Cmd+,).
    if (isOverlayOpen() && !e.ctrlKey && !e.metaKey) return;

    // Don't handle shortcuts when typing in inputs
    // Use composedPath() to find the actual target inside shadow DOM
    const path = e.composedPath();
    const isInInput = path.some((el) => {
      if (el instanceof HTMLElement) {
        return (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          // SELECT too. Its native keyboard interaction IS arrow keys and
          // type-ahead letters, and this handler preventDefault()s the ones it
          // matches — so every <select> in the app was keyboard-inoperable and
          // its type-ahead ran a global shortcut instead. On the interactive
          // rebase action select the select IS the destructive control:
          // pressing `s` for "squash" left the value on `pick` and silently
          // ran stage-all behind the modal.
          el.tagName === 'SELECT' ||
          el.isContentEditable
        );
      }
      return false;
    });

    if (isInInput) {
      // Allow some shortcuts even in inputs (ones with ctrl/meta)
      if (!e.ctrlKey && !e.metaKey) return;
    }

    // Check if event originated from a component with its own keyboard handling
    // (e.g., file-status panel, graph canvas) - let those handle navigation keys themselves
    const isInLocalKeyboardHandler = path.some((el) => {
      if (el instanceof HTMLElement) {
        const tagName = el.tagName.toLowerCase();
        return (
          tagName === 'lv-file-status' ||
          tagName === 'lv-diff-view' ||
          tagName === 'lv-graph-canvas' ||
          tagName === 'lv-branches-panel' ||
          el.hasAttribute('data-keyboard-nav')
        );
      }
      return false;
    });

    // For navigation keys (arrows, home, end, vim j/k), let local handlers take precedence
    const isNavigationKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'j', 'k', 's', 'u'].includes(e.key);
    if (isInLocalKeyboardHandler && isNavigationKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      return; // Let the local component handle it
    }

    // Try vim navigation first (only when not in a local keyboard handler)
    if (this.handleVimKey(e)) {
      return;
    }

    const key = this.getShortcutKey(e);

    // Never take over the native editing combos while the caret is in a text
    // field. `mod+z` is registered globally (Undo History), and matching it here
    // preventDefault()s the browser's own undo — so pressing Ctrl/Cmd+Z to take
    // back a word of a commit message threw a modal over the user's work
    // instead, on every input in the app.
    if (isInInput && KeyboardService.NATIVE_EDITING_KEYS.has(key)) {
      return;
    }

    const shortcut = this.shortcuts.get(key);

    if (shortcut) {
      e.preventDefault();
      e.stopPropagation();
      shortcut.action();
    }

    // Notify listeners
    for (const listener of this.listeners) {
      listener(e);
    }
  }

  /**
   * Set vim mode navigation actions
   */
  setVimActions(actions: {
    navigateUp?: () => void;
    navigateDown?: () => void;
    navigateFirst?: () => void;
    navigateLast?: () => void;
    pageUp?: () => void;
    pageDown?: () => void;
    openSearch?: () => void;
    select?: () => void;
  }): void {
    this.vimActions = actions;
  }

  /**
   * Enable/disable vim mode
   */
  setVimMode(enabled: boolean): void {
    this.vimMode = enabled;
    this.saveSettings();
  }

  /**
   * Check if vim mode is enabled
   */
  isVimMode(): boolean {
    return this.vimMode;
  }

  /**
   * Add a raw keyboard listener
   */
  addListener(listener: (e: KeyboardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Enable/disable keyboard shortcuts
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Get all registered shortcuts
   */
  getAllShortcuts(): Shortcut[] {
    return Array.from(this.shortcuts.values());
  }

  /**
   * Get shortcuts by category
   */
  getShortcutsByCategory(): Map<string, Shortcut[]> {
    const byCategory = new Map<string, Shortcut[]>();
    for (const shortcut of this.shortcuts.values()) {
      const existing = byCategory.get(shortcut.category) || [];
      existing.push(shortcut);
      byCategory.set(shortcut.category, existing);
    }
    return byCategory;
  }

  /**
   * Format a shortcut for display
   */
  formatShortcut(shortcut: Shortcut): string {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const parts: string[] = [];

    if (shortcut.ctrl || shortcut.meta) {
      parts.push(isMac ? '⌘' : 'Ctrl');
    }
    if (shortcut.shift) parts.push(isMac ? '⇧' : 'Shift');
    if (shortcut.alt) parts.push(isMac ? '⌥' : 'Alt');

    // Format special keys
    let keyDisplay = shortcut.key;
    switch (shortcut.key.toLowerCase()) {
      case 'arrowup': keyDisplay = '↑'; break;
      case 'arrowdown': keyDisplay = '↓'; break;
      case 'arrowleft': keyDisplay = '←'; break;
      case 'arrowright': keyDisplay = '→'; break;
      case 'enter': keyDisplay = '↵'; break;
      case 'escape': keyDisplay = 'Esc'; break;
      case ' ': keyDisplay = 'Space'; break;
      default: keyDisplay = shortcut.key.toUpperCase();
    }
    parts.push(keyDisplay);

    return parts.join(isMac ? '' : '+');
  }

  destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    this.shortcuts.clear();
    this.listeners.clear();
    // Clear any pending vim timeout
    if (this.vimPendingTimeout) {
      clearTimeout(this.vimPendingTimeout);
      this.vimPendingTimeout = null;
    }
  }
}

// Singleton instance
export const keyboardService = new KeyboardService();

// Default shortcuts
export function registerDefaultShortcuts(actions: {
  navigateUp: () => void;
  navigateDown: () => void;
  navigateFirst?: () => void;
  navigateLast?: () => void;
  pageUp?: () => void;
  pageDown?: () => void;
  selectCommit: () => void;
  stageAll: () => void;
  unstageAll: () => void;
  commit: () => void;
  refresh: () => void;
  search: () => void;
  openSettings: () => void;
  openShortcuts?: () => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  openCommandPalette?: () => void;
  openReflog?: () => void;
  fetch?: () => void;
  pull?: () => void;
  push?: () => void;
  createBranch?: () => void;
  createStash?: () => void;
  closeDiff?: () => void;
  nextTab?: () => void;
  previousTab?: () => void;
  selectTab?: (index: number) => void;
}): void {
  // Set vim actions
  keyboardService.setVimActions({
    navigateUp: actions.navigateUp,
    navigateDown: actions.navigateDown,
    navigateFirst: actions.navigateFirst,
    navigateLast: actions.navigateLast,
    pageUp: actions.pageUp,
    pageDown: actions.pageDown,
    openSearch: actions.search,
    select: actions.selectCommit,
  });

  // Navigation
  keyboardService.register('nav-up', {
    key: 'ArrowUp',
    action: actions.navigateUp,
    description: 'Previous commit',
    category: 'Navigation',
  });

  keyboardService.register('nav-down', {
    key: 'ArrowDown',
    action: actions.navigateDown,
    description: 'Next commit',
    category: 'Navigation',
  });

  keyboardService.register('select', {
    key: 'Enter',
    action: actions.selectCommit,
    description: 'Select commit',
    category: 'Navigation',
  });

  if (actions.navigateFirst) {
    keyboardService.register('nav-first', {
      key: 'Home',
      action: actions.navigateFirst,
      description: 'First commit',
      category: 'Navigation',
    });
  }

  if (actions.navigateLast) {
    keyboardService.register('nav-last', {
      key: 'End',
      action: actions.navigateLast,
      description: 'Last commit',
      category: 'Navigation',
    });
  }

  // Staging
  keyboardService.register('stage-all', {
    key: 's',
    action: actions.stageAll,
    description: 'Stage all changes',
    category: 'Staging',
  });

  keyboardService.register('unstage-all', {
    key: 'u',
    action: actions.unstageAll,
    description: 'Unstage all changes',
    category: 'Staging',
  });

  // Commit
  keyboardService.register('commit', {
    key: 'Enter',
    ctrl: true,
    action: actions.commit,
    description: 'Commit staged changes',
    category: 'Commit',
  });

  // General
  keyboardService.register('refresh', {
    key: 'r',
    ctrl: true,
    action: actions.refresh,
    description: 'Refresh repository',
    category: 'General',
  });

  keyboardService.register('search', {
    key: 'f',
    ctrl: true,
    action: actions.search,
    description: 'Search commits',
    category: 'General',
  });

  keyboardService.register('settings', {
    key: ',',
    ctrl: true,
    action: actions.openSettings,
    description: 'Open settings',
    category: 'General',
  });

  if (actions.openShortcuts) {
    keyboardService.register('shortcuts', {
      key: '?',
      shift: true,
      action: actions.openShortcuts,
      description: 'Show keyboard shortcuts',
      category: 'General',
    });
  }

  if (actions.openCommandPalette) {
    keyboardService.register('command-palette', {
      key: 'p',
      ctrl: true,
      action: actions.openCommandPalette,
      description: 'Open command palette',
      category: 'General',
    });
  }

  if (actions.openReflog) {
    keyboardService.register('reflog', {
      key: 'z',
      ctrl: true,
      action: actions.openReflog,
      description: 'Open undo history',
      category: 'General',
    });
  }

  // Git operations
  if (actions.fetch) {
    keyboardService.register('fetch', {
      key: 'f',
      ctrl: true,
      shift: true,
      action: actions.fetch,
      description: 'Fetch from remote',
      category: 'Git',
    });
  }

  if (actions.pull) {
    keyboardService.register('pull', {
      key: 'p',
      ctrl: true,
      shift: true,
      action: actions.pull,
      description: 'Pull from remote',
      category: 'Git',
    });
  }

  if (actions.push) {
    keyboardService.register('push', {
      key: 'u',
      ctrl: true,
      shift: true,
      action: actions.push,
      description: 'Push to remote',
      category: 'Git',
    });
  }

  if (actions.createBranch) {
    keyboardService.register('new-branch', {
      key: 'n',
      ctrl: true,
      shift: true,
      action: actions.createBranch,
      description: 'Create new branch',
      category: 'Git',
    });
  }

  if (actions.createStash) {
    keyboardService.register('stash', {
      key: 's',
      ctrl: true,
      shift: true,
      action: actions.createStash,
      description: 'Create stash',
      category: 'Git',
    });
  }

  // Panels
  keyboardService.register('toggle-left', {
    key: 'b',
    ctrl: true,
    action: actions.toggleLeftPanel,
    description: 'Toggle left panel',
    category: 'View',
  });

  keyboardService.register('toggle-right', {
    key: 'j',
    ctrl: true,
    action: actions.toggleRightPanel,
    description: 'Toggle right panel',
    category: 'View',
  });

  if (actions.closeDiff) {
    keyboardService.register('close-diff', {
      key: 'Escape',
      action: actions.closeDiff,
      description: 'Close diff/panel',
      category: 'View',
    });
  }

  // Repository tabs
  if (actions.nextTab) {
    keyboardService.register('next-tab', {
      key: 'Tab',
      ctrl: true,
      action: actions.nextTab,
      description: 'Next repository tab',
      category: 'View',
    });
  }

  if (actions.previousTab) {
    keyboardService.register('previous-tab', {
      key: 'Tab',
      ctrl: true,
      shift: true,
      action: actions.previousTab,
      description: 'Previous repository tab',
      category: 'View',
    });
  }

  if (actions.selectTab) {
    const selectTab = actions.selectTab;
    for (let n = 1; n <= 9; n++) {
      keyboardService.register(`select-tab-${n}`, {
        key: String(n),
        ctrl: true,
        action: () => selectTab(n - 1),
        description: `Go to repository tab ${n}`,
        category: 'View',
      });
    }
  }
}
