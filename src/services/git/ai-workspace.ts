import { invokeCommand } from "../tauri-api.ts";
import type {
  AvatarInfo,
} from "../../types/git.types.ts";
import type {
  GetAvatarUrlCommand,
  GetAvatarUrlsCommand,
  CommandResult,
} from "../../types/api.types.ts";

/**
 * Terminal integration
 */
export async function openTerminal(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_terminal", { path: repoPath });
}

export async function openFileManager(
  repoPath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_file_manager", { path: repoPath });
}

export async function openInEditor(
  filePath: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("open_in_editor", { filePath });
}

/**
 * File operations
 */

/** Result of file open/reveal operations */
export interface OpenResult {
  success: boolean;
  message?: string;
  /** Set when the open succeeded via a fallback the user should know about. */
  notice?: string;
}

/** Editor configuration from git config */
export interface EditorConfig {
  editor?: string;
  visual?: string;
}

/**
 * Reveal a file or folder in the system file manager
 * This will select/highlight the file in the file manager
 * @param path Absolute path to the file or folder
 */
export async function revealInFileManager(
  path: string,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("reveal_in_file_manager", { path });
}

/**
 * Open a file with the system's default application
 * @param path Absolute path to the file
 */
export async function openInDefaultApp(
  path: string,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("open_in_default_app", { path });
}

/**
 * Open a file in the configured editor
 * Uses git's core.editor config, falling back to VISUAL/EDITOR env vars
 * @param repoPath Repository path (for local config lookup)
 * @param filePath File path (absolute or relative to repo)
 * @param line Optional line number to open at
 */
export async function openInConfiguredEditor(
  repoPath: string,
  filePath: string,
  line?: number,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("open_in_configured_editor", {
    path: repoPath,
    filePath,
    line,
  });
}

/**
 * Get the configured editor settings
 * @param repoPath Repository path
 * @param global If true, only return global config; otherwise prefer local
 */
export async function getEditorConfig(
  repoPath: string,
  global: boolean = false,
): Promise<CommandResult<EditorConfig>> {
  return invokeCommand<EditorConfig>("get_editor_config", {
    path: repoPath,
    global,
  });
}

/**
 * Set the configured editor
 * @param repoPath Repository path
 * @param editor Editor command (e.g., "code --wait", "vim")
 * @param global If true, set in global config; otherwise set in local repo config
 */
export async function setEditorConfig(
  repoPath: string,
  editor: string,
  global: boolean = false,
): Promise<CommandResult<OpenResult>> {
  return invokeCommand<OpenResult>("set_editor_config", {
    path: repoPath,
    editor,
    global,
  });
}


/**
 * Avatar operations
 */

/**
 * Get avatar info for a single email address
 */
export async function getAvatarUrl(
  args: GetAvatarUrlCommand,
): Promise<CommandResult<AvatarInfo>> {
  return invokeCommand<AvatarInfo>("get_avatar_url", args);
}

/**
 * Get avatar info for multiple email addresses (batch)
 */
export async function getAvatarUrls(
  args: GetAvatarUrlsCommand,
): Promise<CommandResult<AvatarInfo[]>> {
  return invokeCommand<AvatarInfo[]>("get_avatar_urls", args);
}

/**
 * Bookmark operations
 */

/**
 * Repository bookmark
 */
export interface RepoBookmark {
  path: string;
  name: string;
  group: string | null;
  pinned: boolean;
  lastOpened: number;
  color: string | null;
}

/**
 * Get all bookmarks
 */
export async function getBookmarks(): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("get_bookmarks", {});
}

/**
 * Add a new bookmark
 */
export async function addBookmark(
  path: string,
  name: string,
  group?: string | null,
  pinned?: boolean,
  color?: string | null,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("add_bookmark", {
    path,
    name,
    group: group ?? null,
    pinned: pinned ?? false,
    color: color ?? null,
  });
}

/**
 * Remove a bookmark
 */
export async function removeBookmark(
  path: string,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("remove_bookmark", { path });
}

/**
 * Update an existing bookmark
 */
export async function updateBookmark(
  bookmark: RepoBookmark,
): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("update_bookmark", { bookmark });
}

/**
 * Get recently opened repositories
 */
export async function getRecentRepos(): Promise<CommandResult<RepoBookmark[]>> {
  return invokeCommand<RepoBookmark[]>("get_recent_repos", {});
}

/**
 * Record that a repository was opened
 */
export async function recordRepoOpened(
  path: string,
  name: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>("record_repo_opened", { path, name });
}


/**
 * Custom Actions
 */

/**
 * A user-defined custom action
 */
export interface CustomAction {
  id: string;
  name: string;
  command: string;
  arguments: string | null;
  workingDirectory: string | null;
  shortcut: string | null;
  showInToolbar: boolean;
  openInTerminal: boolean;
  confirmBeforeRun: boolean;
}

/**
 * Result of executing a custom action
 */
export interface ActionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/**
 * Get all custom actions for a repository
 */
export async function getCustomActions(
  path: string,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("get_custom_actions", { path });
}

/**
 * Save a custom action
 */
export async function saveCustomAction(
  path: string,
  action: CustomAction,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("save_custom_action", { path, action });
}

/**
 * Delete a custom action
 */
export async function deleteCustomAction(
  path: string,
  actionId: string,
): Promise<CommandResult<CustomAction[]>> {
  return invokeCommand<CustomAction[]>("delete_custom_action", {
    path,
    actionId,
  });
}

/**
 * Run a custom action
 */
export async function runCustomAction(
  path: string,
  actionId: string,
): Promise<CommandResult<ActionResult>> {
  return invokeCommand<ActionResult>("run_custom_action", { path, actionId });
}


// ============================================================================
// Clipboard Operations
// ============================================================================

/**
 * Result of a clipboard copy operation
 */
export interface CopyResult {
  success: boolean;
  text: string;
}

/**
 * Format options for commit info
 */
export type CommitInfoFormat =
  | "sha"
  | "short_sha"
  | "message"
  | "full"
  | "patch";

/**
 * Format options for file paths
 */
export type FilePathFormat = "relative" | "absolute" | "filename";

/**
 * How long to wait for `navigator.clipboard.writeText` before giving up on it.
 *
 * The async clipboard API does not always reject when it cannot write: without
 * clipboard-write permission, outside a secure context, or outside a user
 * gesture it can leave its promise pending forever. An unbounded `await` there
 * means the caller never returns, so the user clicks "Copy" and gets neither a
 * clipboard entry nor an error — the operation just disappears. Bound the wait
 * and fall through to the synchronous fallback below instead.
 */
const CLIPBOARD_WRITE_TIMEOUT_MS = 2000;

/**
 * Last-resort clipboard write using the legacy synchronous API.
 *
 * `document.execCommand("copy")` is deprecated but still implemented
 * everywhere, works without the clipboard-write permission, and — being
 * synchronous — cannot hang. It only copies the current selection, so the text
 * is staged in an off-screen textarea first.
 *
 * @returns true when the copy was accepted
 */
function copyToClipboardFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Keep it out of view and out of the layout, but still focusable/selectable —
  // `display: none` and `visibility: hidden` elements cannot hold a selection.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.setAttribute("aria-hidden", "true");

  const previouslyFocused = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    // Restore focus so the fallback is invisible to the user.
    previouslyFocused?.focus?.();
  }
}

/**
 * Copy text to the system clipboard
 *
 * Prefers the async clipboard API and falls back to the legacy synchronous
 * copy when it is missing, rejects, or never settles. Always resolves — a
 * clipboard write must never leave a caller (or a test) awaiting forever.
 *
 * Note: this deliberately does not route through the `copy_to_clipboard` Tauri
 * command. That command does not touch the system clipboard; it echoes the
 * text back, so using it would report success while copying nothing.
 *
 * @param text Text to copy
 * @returns Result with the copied text
 */
export async function copyToClipboard(
  text: string,
): Promise<CommandResult<CopyResult>> {
  let asyncError: unknown;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const wrote = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CLIPBOARD_WRITE_TIMEOUT_MS);
        }),
      ]);
      if (wrote) {
        return {
          success: true,
          data: { success: true, text },
        };
      }
    } catch (error) {
      asyncError = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  if (copyToClipboardFallback(text)) {
    return {
      success: true,
      data: { success: true, text },
    };
  }

  return {
    success: false,
    error: {
      code: "CLIPBOARD_ERROR",
      message:
        asyncError instanceof Error
          ? asyncError.message
          : "Failed to copy to clipboard",
    },
  };
}

/**
 * Get formatted commit info for copying
 * @param path Repository path
 * @param oid Commit OID
 * @param format Format type: "sha", "short_sha", "message", "full", "patch"
 * @returns Formatted commit info
 */
export async function getCommitInfoForCopy(
  path: string,
  oid: string,
  format: CommitInfoFormat,
): Promise<CommandResult<CopyResult>> {
  return invokeCommand<CopyResult>("get_commit_info_for_copy", {
    path,
    oid,
    format,
  });
}

/**
 * Get file path in various formats for copying
 * @param path Repository path
 * @param filePath Relative file path within the repo
 * @param format Format type: "relative", "absolute", "filename"
 * @returns Formatted file path
 */
export async function getFilePathForCopy(
  path: string,
  filePath: string,
  format: FilePathFormat,
): Promise<CommandResult<CopyResult>> {
  return invokeCommand<CopyResult>("get_file_path_for_copy", {
    path,
    filePath,
    format,
  });
}

/**
 * Copy commit SHA to clipboard
 * Convenience function that combines getCommitInfoForCopy and copyToClipboard
 * @param path Repository path
 * @param oid Commit OID
 * @param short If true, copy short SHA (7 characters)
 * @returns Result with the copied text
 */
export async function copyCommitSha(
  path: string,
  oid: string,
  short?: boolean,
): Promise<CommandResult<CopyResult>> {
  const format: CommitInfoFormat = short ? "short_sha" : "sha";
  const infoResult = await getCommitInfoForCopy(path, oid, format);

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy commit message to clipboard
 * @param path Repository path
 * @param oid Commit OID
 * @returns Result with the copied text
 */
export async function copyCommitMessage(
  path: string,
  oid: string,
): Promise<CommandResult<CopyResult>> {
  const infoResult = await getCommitInfoForCopy(path, oid, "message");

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy commit as patch to clipboard
 * @param path Repository path
 * @param oid Commit OID
 * @returns Result with the copied patch text
 */
export async function copyCommitPatch(
  path: string,
  oid: string,
): Promise<CommandResult<CopyResult>> {
  const infoResult = await getCommitInfoForCopy(path, oid, "patch");

  if (!infoResult.success || !infoResult.data) {
    return infoResult;
  }

  return copyToClipboard(infoResult.data.text);
}

/**
 * Copy file path to clipboard
 * @param repoPath Repository path
 * @param filePath Relative file path within the repo
 * @param format Format type: "relative", "absolute", "filename"
 * @returns Result with the copied text
 */
export async function copyFilePath(
  repoPath: string,
  filePath: string,
  format: FilePathFormat = "relative",
): Promise<CommandResult<CopyResult>> {
  const pathResult = await getFilePathForCopy(repoPath, filePath, format);

  if (!pathResult.success || !pathResult.data) {
    return pathResult;
  }

  return copyToClipboard(pathResult.data.text);
}

