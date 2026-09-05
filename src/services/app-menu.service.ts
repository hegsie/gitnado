/**
 * Application menu bar service.
 *
 * The native menu is built in `src-tauri/src/menu.rs`; choosing an item emits
 * `app-menu-action` with the item's id. This module is the single place that
 * maps such an id onto an action the app already has, so a menu item can never
 * do something subtly different from its command-palette twin — it literally
 * runs the palette command's own `action`.
 *
 * It also computes what the native menu cannot know on its own:
 * - which items must be greyed out (everything repository-scoped, with no
 *   repository open), and
 * - the accelerator to print next to each item, taken from keyboard.service so
 *   the menu teaches the shortcut the user actually has, custom rebinds
 *   included.
 */

import type { PaletteCommand } from '../components/dialogs/lv-command-palette.ts';
import { keyboardService, type ShortcutBinding } from './keyboard.service.ts';
import { invokeCommand } from './tauri-api.ts';
import type { CommandResult } from '../types/api.types.ts';

/** Tauri event carrying the id of the chosen menu item. */
export const MENU_ACTION_EVENT = 'app-menu-action';

/**
 * Actions with no command-palette twin. Each one is implemented once, in
 * app-shell, and handed to `resolveMenuAction`.
 */
export type MenuShellActionId =
  | 'openRepository'
  | 'cloneRepository'
  | 'initRepository'
  | 'closeRepositoryTab'
  | 'switchBranch'
  | 'commandPalette'
  | 'keyboardShortcuts'
  | 'about';

export interface AppMenuAction {
  /** Menu item id, identical to the one in `src-tauri/src/menu.rs`. */
  id: string;
  /** Id of the command-palette entry whose action this item runs. */
  paletteId?: string;
  /** Shell action, for the few items the palette has no entry for. */
  shell?: MenuShellActionId;
  /** keyboard.service shortcut id whose current binding is shown on the item. */
  shortcutId?: string;
  /** Must be greyed out while no repository is open. */
  repositoryScoped: boolean;
}

/**
 * Menu id -> action, mirroring `APP_MENU` in `src-tauri/src/menu.rs`.
 * `scripts/menu-contract.test.mjs` fails when the two lists disagree, so a
 * menu item can never be added on one side only.
 */
export const APP_MENU_ACTIONS: readonly AppMenuAction[] = [
  // File
  { id: 'open-repository', shell: 'openRepository', repositoryScoped: false },
  { id: 'clone-repository', shell: 'cloneRepository', repositoryScoped: false },
  { id: 'init-repository', shell: 'initRepository', repositoryScoped: false },
  { id: 'close-repository-tab', shell: 'closeRepositoryTab', repositoryScoped: true },
  // Repository
  { id: 'fetch', paletteId: 'fetch', shortcutId: 'fetch', repositoryScoped: true },
  { id: 'pull', paletteId: 'pull', shortcutId: 'pull', repositoryScoped: true },
  { id: 'push', paletteId: 'push', shortcutId: 'push', repositoryScoped: true },
  { id: 'clean', paletteId: 'clean', repositoryScoped: true },
  { id: 'bisect', paletteId: 'bisect', repositoryScoped: true },
  { id: 'worktrees', paletteId: 'worktrees', repositoryScoped: true },
  { id: 'submodules', paletteId: 'submodules', repositoryScoped: true },
  { id: 'lfs', paletteId: 'lfs', repositoryScoped: true },
  { id: 'hooks', paletteId: 'hooks', repositoryScoped: true },
  { id: 'config', paletteId: 'config', repositoryScoped: true },
  { id: 'gitignore', paletteId: 'gitignore', repositoryScoped: true },
  { id: 'repository-health', paletteId: 'repository-health', repositoryScoped: true },
  // Branch
  {
    id: 'create-branch',
    paletteId: 'create-branch',
    shortcutId: 'new-branch',
    repositoryScoped: true,
  },
  { id: 'switch-branch', shell: 'switchBranch', repositoryScoped: true },
  { id: 'compare-branches', paletteId: 'compare-branches', repositoryScoped: true },
  { id: 'branch-cleanup', paletteId: 'branch-cleanup', repositoryScoped: true },
  // View
  {
    id: 'toggle-left-panel',
    paletteId: 'toggle-left-panel',
    shortcutId: 'toggle-left',
    repositoryScoped: false,
  },
  {
    id: 'toggle-right-panel',
    paletteId: 'toggle-right-panel',
    shortcutId: 'toggle-right',
    repositoryScoped: false,
  },
  // The output panel renders only inside the active-repository layout, so with
  // no repository open the item would be a silent no-op that also armed the
  // panel flag for whichever repository the user opened next.
  { id: 'toggle-output-panel', paletteId: 'toggle-output-panel', repositoryScoped: true },
  {
    id: 'command-palette',
    shell: 'commandPalette',
    shortcutId: 'command-palette',
    repositoryScoped: false,
  },
  // Help
  {
    id: 'keyboard-shortcuts',
    shell: 'keyboardShortcuts',
    shortcutId: 'shortcuts',
    repositoryScoped: false,
  },
  { id: 'about', shell: 'about', repositoryScoped: false },
];

/** One item's state, as the `sync_app_menu` command expects it. */
export interface MenuItemUpdate {
  id: string;
  enabled: boolean;
  accelerator: string | null;
}

export type MenuShellHandlers = Record<MenuShellActionId, () => void>;

/**
 * Key names muda (Tauri's menu layer) understands, keyed by the lowercase
 * `KeyboardEvent.key` keyboard.service stores.
 *
 * Anything absent yields no accelerator at all rather than a guess: a menu item
 * that advertises the wrong key teaches the user something false, and a wrong
 * accelerator string is rejected by the native layer anyway.
 */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  '`': 'Backquote',
  '\\': 'Backslash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '=': 'Equal',
  '-': 'Minus',
  '.': 'Period',
  "'": 'Quote',
  ';': 'Semicolon',
  '/': 'Slash',
  ' ': 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  end: 'End',
  enter: 'Enter',
  escape: 'Escape',
  home: 'Home',
  insert: 'Insert',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  tab: 'Tab',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
};

function acceleratorKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  return ACCELERATOR_KEYS[lower] ?? null;
}

/**
 * Convert a keyboard.service binding into a Tauri accelerator string.
 *
 * Returns null when the combo cannot be expressed, and — deliberately — for any
 * binding without Ctrl/Cmd/Alt: a bare "S" accelerator on a native menu item
 * swallows the letter S everywhere in the app, including inside text fields.
 */
export function toAccelerator(binding: ShortcutBinding | undefined): string | null {
  if (!binding) return null;
  const key = acceleratorKey(binding.key);
  if (!key) return null;

  const modifier = binding.ctrl || binding.meta;
  if (!modifier && !binding.alt) return null;

  const parts: string[] = [];
  if (modifier) parts.push('CmdOrCtrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** The accelerator a key press corresponds to, in the same notation. */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  return toAccelerator({
    key: e.key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  });
}

/** The accelerator currently bound to a menu item, custom rebinds included. */
export function acceleratorForMenuItem(id: string): string | null {
  const action = APP_MENU_ACTIONS.find((a) => a.id === id);
  if (!action?.shortcutId) return null;
  return toAccelerator(keyboardService.getBinding(action.shortcutId));
}

/** The payload `sync_app_menu` expects for the current repository state. */
export function buildMenuUpdates(hasRepository: boolean): MenuItemUpdate[] {
  return APP_MENU_ACTIONS.map((action) => ({
    id: action.id,
    enabled: action.repositoryScoped ? hasRepository : true,
    accelerator: acceleratorForMenuItem(action.id),
  }));
}

/**
 * Push the current enabled state and accelerators to the native menu.
 * Returns the raw command result so callers can log a failure; a stale menu is
 * not worth a toast, but it must not vanish silently either.
 */
export async function syncAppMenu(hasRepository: boolean): Promise<CommandResult<void>> {
  return invokeCommand<void>('sync_app_menu', { items: buildMenuUpdates(hasRepository) });
}

/**
 * Find the function a menu id must run.
 *
 * Palette-backed ids return the palette command's own action — not a copy of it
 * — so the menu and the palette can never diverge in behaviour, including the
 * "Please open a repository first" guard the palette entries already carry.
 */
export function resolveMenuAction(
  id: string,
  paletteCommands: readonly PaletteCommand[],
  shell: MenuShellHandlers
): (() => void) | null {
  const action = APP_MENU_ACTIONS.find((a) => a.id === id);
  if (!action) return null;
  if (action.shell) return shell[action.shell];
  if (action.paletteId) {
    return paletteCommands.find((c) => c.id === action.paletteId)?.action ?? null;
  }
  return null;
}

/**
 * Guard against an action running twice for one key press.
 *
 * A menu accelerator is consumed by the menu on macOS, but on Linux (and, in
 * some window states, Windows) the webview can see the same key press as well —
 * so keyboard.service runs the action AND the native menu emits its event.
 * "Push" twice from one Ctrl+Shift+U is not acceptable, so a menu action is
 * dropped when its own accelerator was pressed a moment earlier.
 */
const DUPLICATE_WINDOW_MS = 500;
let lastAcceleratorPress: { accelerator: string; at: number } | null = null;

/** Record a key press for the duplicate guard. Exported for the watcher below. */
export function noteAcceleratorKeydown(e: KeyboardEvent, now: number = Date.now()): void {
  const accelerator = acceleratorFromEvent(e);
  if (!accelerator) return;
  lastAcceleratorPress = { accelerator, at: now };
}

/** Whether this menu action has just been run by its own keyboard shortcut. */
export function shouldSuppressMenuAction(id: string, now: number = Date.now()): boolean {
  const accelerator = acceleratorForMenuItem(id);
  if (!accelerator || !lastAcceleratorPress) return false;
  const isDuplicate =
    lastAcceleratorPress.accelerator === accelerator &&
    now - lastAcceleratorPress.at < DUPLICATE_WINDOW_MS;
  // Consume it either way: one key press may only ever suppress one menu event,
  // otherwise a deliberate second visit to the menu inside the window is eaten.
  if (isDuplicate) lastAcceleratorPress = null;
  return isDuplicate;
}

/** Reset the duplicate guard. Used by tests and on teardown. */
export function resetAcceleratorGuard(): void {
  lastAcceleratorPress = null;
}

/**
 * Watch key presses for the duplicate guard. Capture phase, so a press is
 * recorded even when a dialog stops the event on its way down.
 */
export function startAcceleratorWatch(target: Document = document): () => void {
  const listener = (e: Event) => noteAcceleratorKeydown(e as KeyboardEvent);
  target.addEventListener('keydown', listener, { capture: true });
  return () => {
    target.removeEventListener('keydown', listener, { capture: true });
    resetAcceleratorGuard();
  };
}
