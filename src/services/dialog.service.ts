/**
 * Dialog Service
 * Wrapper around Tauri dialog plugin for file/folder selection
 */

import { open, save, message, ask, confirm } from '@tauri-apps/plugin-dialog';
import { loggers } from '../utils/logger.ts';

const log = loggers.dialog;

/**
 * Check if running inside Tauri
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/**
 * Open a file or folder picker dialog
 */
export async function openDialog(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (!isTauri()) {
    console.warn('Dialog API is only available in Tauri. Run with: npm run tauri dev');
    alert('Dialog API is only available when running in Tauri.\n\nRun with: npm run tauri dev');
    return null;
  }

  log.debug('Opening dialog with options:', options);
  try {
    const result = await open({
      title: options.title,
      defaultPath: options.defaultPath,
      directory: options.directory ?? false,
      multiple: options.multiple ?? false,
      filters: options.filters,
    });
    log.debug('Dialog result:', result);
    return result;
  } catch (error) {
    log.error('Dialog error:', error);
    throw error;
  }
}

/**
 * Open a folder picker dialog specifically for repositories
 */
export async function openRepositoryDialog(): Promise<string | null> {
  const result = await openDialog({
    title: 'Open Repository',
    directory: true,
    multiple: false,
  });

  if (Array.isArray(result)) {
    return result[0] ?? null;
  }
  return result;
}

/**
 * Open a folder picker dialog for clone destination
 */
export async function openCloneDestinationDialog(defaultPath?: string): Promise<string | null> {
  const result = await openDialog({
    title: 'Select Clone Destination',
    directory: true,
    multiple: false,
    defaultPath,
  });

  if (Array.isArray(result)) {
    return result[0] ?? null;
  }
  return result;
}

/**
 * Open a save dialog
 */
export async function saveDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  try {
    const result = await save({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return result;
  } catch (error) {
    log.error('Save dialog error:', error);
    return null;
  }
}

/**
 * Show a message dialog
 */
export async function showMessage(
  title: string,
  messageText: string,
  kind: 'info' | 'warning' | 'error' = 'info'
): Promise<void> {
  await message(messageText, { title, kind });
}

/**
 * Show a confirmation dialog with Yes/No
 */
export async function showConfirm(
  title: string,
  messageText: string,
  kind: 'info' | 'warning' | 'error' = 'info'
): Promise<boolean> {
  // A rejection here means we could not ask — an IPC failure or a window
  // tearing down — so the only safe answer is "no". It also matters for the
  // callers: every destructive handler claims the shared working-tree lock
  // BEFORE this confirm (showConfirm is an IPC round trip, so a claim taken
  // after it does not serialize a double-click), and most of them do that
  // outside the try/finally that releases it. A throw from here would unwind
  // past the release and leave the repo's lock held for the rest of the
  // session, disabling every ref control in every surface. Swallowing it in
  // the one shared place beats wrapping each call site — that is the
  // hand-enumerated list that goes stale.
  try {
    return await confirm(messageText, { title, kind });
  } catch {
    return false;
  }
}

/**
 * Show an ask dialog with OK/Cancel
 */
export async function showAsk(
  title: string,
  messageText: string,
  kind: 'info' | 'warning' | 'error' = 'info'
): Promise<boolean> {
  return await ask(messageText, { title, kind });
}

/**
 * Show a themed prompt dialog using the gn-prompt-dialog singleton.
 * Returns the entered string, or null if cancelled.
 */
export async function showPrompt(
  title: string,
  messageText: string,
  defaultValue?: string,
  placeholder?: string
): Promise<string | null> {
  // A rejection here means we could not ask — the lazy chunk failed to load, or
  // the element blew up constructing — so the only safe answer is "no input",
  // the same as a cancel. It also matters for the callers: several claim the
  // shared working-tree lock BEFORE this prompt (a claim taken after it does
  // not serialize a double-click) and do so outside the try/finally that
  // releases. A throw would unwind past the release and hold that repo's lock
  // for the rest of the session, disabling every ref control in every surface.
  // Swallowed here, in the one shared place, rather than at each call site —
  // that is the hand-enumerated list that goes stale. showConfirm does the same.
  try {
    // Lazy-import to avoid circular dependencies; side-effect import registers the element
    await import('../components/dialogs/gn-prompt-dialog.ts');

    type PromptDialog = import('../components/dialogs/gn-prompt-dialog.ts').GnPromptDialog;

    let dialog = document.querySelector<PromptDialog>('gn-prompt-dialog');
    if (!dialog) {
      dialog = document.createElement('gn-prompt-dialog') as PromptDialog;
      document.body.appendChild(dialog);
      await dialog.updateComplete;
    }

    return await dialog.open({ title, message: messageText, defaultValue, placeholder });
  } catch {
    return null;
  }
}
