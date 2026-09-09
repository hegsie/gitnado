import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared-styles.ts";
import * as gitService from "../../services/git.service.ts";
import * as watcherService from "../../services/watcher.service.ts";
import { showConfirm } from "../../services/dialog.service.ts";
import { showToast } from "../../services/notification.service.ts";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { join } from "@tauri-apps/api/path";
import type { StatusEntry, FileStatus } from "../../types/git.types.ts";
import { repositoryStore } from "../../stores/repository.store.ts";
import { settingsStore } from "../../stores/settings.store.ts";
import { isTopOverlay } from "../../utils/overlay-stack.ts";
import {
  tryAcquireRefOp,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

interface FileContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  file: StatusEntry | null;
  isStaged: boolean;
}

/**
 * Render a working-tree path as a .gitignore pattern that matches THAT file and
 * nothing else.
 *
 * Anchored with a leading slash so it resolves against the repo-root
 * .gitignore — a bare `notes.txt` would also ignore `docs/notes.txt`. Glob
 * metacharacters are escaped so a file literally called `a[1].txt` is not read
 * back as a character class, and a trailing space is escaped because git strips
 * unescaped trailing whitespace from a pattern (the rule would then miss the
 * very file it was written for).
 */
function gitignorePatternForPath(path: string): string {
  const escaped = path
    .replace(/[\\*?[\]]/g, (c) => `\\${c}`)
    .replace(/ $/, "\\ ");
  return `/${escaped}`;
}

/**
 * `*.log` for `logs/run.log`. Null when the file name carries no usable
 * extension — `Makefile`, a dotfile like `.env`, or a name ending in a dot.
 */
function gitignoreExtensionPattern(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return `*.${name.slice(dot + 1).replace(/[\\*?[\]]/g, (c) => `\\${c}`)}`;
}

/**
 * Why "File history" and "Blame" are refused on some working-tree rows.
 *
 * Both views read from HEAD, so a path that has never been committed has
 * nothing to show: its log is empty and `blame_file` fails outright.
 */
const NO_HISTORY_REASON = "Not committed yet, so there is no history to show";

/**
 * File status component
 * Displays staged and unstaged changes with staging functionality
 */
@customElement("lv-file-status")
export class LvFileStatus extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        -webkit-user-select: none;
        user-select: none;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      .section {
        border-bottom: 1px solid var(--color-border);
      }

      .section:last-child {
        border-bottom: none;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .section-header {
        --lv-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .section-header:hover {
        background: var(--color-bg-hover);
      }

      .chevron {
        width: 14px;
        height: 14px;
        transition: transform var(--transition-fast);
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .section-title {
        flex: 1;
        font-weight: var(--font-weight-medium);
      }

      .section-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
      }

      .section-actions {
        display: flex;
        gap: 2px;
      }

      .section-action {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .section-action:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .file-list {
        list-style: none;
        margin: 0;
        padding: 0;
        -webkit-user-select: none;
        user-select: none;
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        padding-left: 22px;
        cursor: default;
        font-size: var(--font-size-xs);
        min-height: 22px;
        -webkit-user-select: none;
        user-select: none;
        -webkit-backface-visibility: hidden;
        backface-visibility: hidden;
      }

      .file-item:hover {
        background: var(--color-bg-hover);
      }

      .file-item.selected {
        background: var(--color-primary-bg);
      }

      .file-item.focused {
        outline: 1px solid var(--color-primary);
        outline-offset: -1px;
      }

      .file-status {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: var(--font-weight-bold);
        border-radius: 2px;
        flex-shrink: 0;
      }

      .file-status.new,
      .file-status.untracked {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .file-status.modified {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .file-status.deleted {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .file-status.renamed,
      .file-status.copied {
        background: var(--color-info-bg);
        color: var(--color-info);
      }

      .file-status.conflicted {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      /* Partial staging indicator - file has some changes staged, some not */
      .file-item.partial-staged {
        position: relative;
      }

      .partial-indicator {
        position: absolute;
        left: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--color-warning);
        box-shadow: 0 0 0 2px var(--color-bg-primary);
      }

      .partial-badge {
        font-size: 9px;
        color: var(--color-warning);
        background: var(--color-warning-bg);
        padding: 0 4px;
        border-radius: var(--radius-sm);
        margin-left: 4px;
        flex-shrink: 0;
      }

      .file-name-container {
        flex: 1;
        display: flex;
        align-items: baseline;
        gap: 6px;
        overflow: hidden;
        min-width: 0;
        -webkit-user-select: none;
        user-select: none;
      }

      .file-name {
        font-family: var(--font-family-mono);
        font-size: 12px;
        white-space: nowrap;
        flex-shrink: 0;
        -webkit-user-select: none;
        user-select: none;
      }

      .file-dir {
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
        min-width: 0;
        -webkit-user-select: none;
        user-select: none;
      }

      .file-actions {
        display: none;
        gap: 2px;
      }

      .file-item:hover .file-actions {
        display: flex;
      }

      .file-action {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .file-action:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .empty {
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        min-height: 100px;
      }

      .error {
        padding: var(--spacing-sm);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .clean-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
        text-align: center;
        min-height: 100px;
      }

      .clean-state svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-sm);
        opacity: 0.5;
      }

      .clean-state .title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--spacing-xs);
      }

      .clean-state .subtitle {
        font-size: var(--font-size-xs);
      }

      /* Tree view styles */
      .folder-item {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        padding-left: calc(22px + var(--tree-depth, 0) * 12px);
        cursor: pointer;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        -webkit-user-select: none;
        user-select: none;
      }

      .folder-item:hover {
        background: var(--color-bg-hover);
      }

      .folder-item .folder-icon {
        width: 14px;
        height: 14px;
        color: var(--color-warning);
      }

      .folder-item .folder-name {
        font-family: var(--font-family-mono);
        font-size: 11px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .folder-count {
        font-size: 10px;
        color: var(--color-text-muted);
        background: var(--color-bg-tertiary);
        padding: 0 5px;
        border-radius: var(--radius-full);
        flex-shrink: 0;
      }

      .folder-actions {
        display: none;
        gap: 2px;
        flex-shrink: 0;
      }

      .folder-item:hover .folder-actions {
        display: flex;
      }

      .folder-item:hover .folder-count {
        display: none;
      }

      .folder-children {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .tree-file-item {
        padding-left: calc(34px + var(--tree-depth, 0) * 12px);
      }

      .tree-file-item .file-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
      }

      .filter-bar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .filter-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-text-muted);
      }

      .filter-input {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        outline: none;
        padding: 2px 0;
      }

      .filter-input::placeholder {
        color: var(--color-text-muted);
      }

      .filter-clear {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        padding: 0;
      }

      .filter-clear:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .filter-clear svg {
        width: 12px;
        height: 12px;
      }

      .no-match-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 24px 12px;
        text-align: center;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .no-match-state .no-match-query {
        color: var(--color-text-primary);
        font-weight: var(--font-weight-medium);
        word-break: break-all;
      }

      .no-match-clear {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        padding: 3px 10px;
        cursor: pointer;
      }

      .no-match-clear:hover {
        background: var(--color-bg-hover);
      }

      .view-toggle {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        cursor: pointer;
        font-size: var(--font-size-xs);
      }

      .view-toggle:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .view-toggle.active {
        color: var(--color-primary);
        background: var(--color-primary-bg);
      }

      .view-toggle svg {
        width: 14px;
        height: 14px;
      }

      .selection-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
      }

      .selection-count {
        color: var(--color-text-secondary);
        flex: 1;
      }

      .selection-action-btn {
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        background: transparent;
        border: 1px solid var(--color-border);
        cursor: pointer;
      }

      .selection-action-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .selection-action-btn.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
        border-color: var(--color-error);
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
        min-width: 180px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--spacing-xs) 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        text-align: left;
        cursor: pointer;
      }

      .context-menu-item:hover {
        background: var(--color-bg-hover);
      }

      .context-menu-item.danger {
        color: var(--color-error);
      }

      .context-menu-item[disabled],
      .context-menu-item.disabled {
        opacity: 0.5;
        cursor: default;
      }

      .context-menu-item[disabled]:hover,
      .context-menu-item.disabled:hover {
        background: none;
      }

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-item.danger svg {
        color: var(--color-error);
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = "";

  @state() private stagedFiles: StatusEntry[] = [];
  @state() private unstagedFiles: StatusEntry[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private stagedExpanded = true;
  @state() private unstagedExpanded = true;
  @state() private selectedFiles: Set<string> = new Set();
  @state() private lastSelectedFile: string | null = null;
  @state() private focusedIndex: number = -1;
  @state() private viewMode: "flat" | "tree" = "flat";
  @state() private expandedFolders: Set<string> = new Set();
  /** Working-tree path filter. Empty string means "no filter". */
  @state() private filterQuery = "";
  @state() private contextMenu: FileContextMenuState = {
    visible: false,
    x: 0,
    y: 0,
    file: null,
    isStaged: false,
  };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleKeydownForContextMenu = (e: KeyboardEvent): void => {
    // A context menu must not eat an Escape aimed at a dialog opened over it:
    // every global keydown listener fires on the same keypress.
    if (!isTopOverlay(this)) return;
    if (e.key === "Escape" && this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleContextMenuKeydown(e: KeyboardEvent): void {
    const menu = this.renderRoot.querySelector(".context-menu") as HTMLElement;
    if (!menu) return;

    const items = Array.from(
      menu.querySelectorAll(".context-menu-item:not([disabled])"),
    ) as HTMLElement[];
    const currentIndex = items.indexOf(e.target as HTMLElement);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        items[next]?.focus();
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        items[prev]?.focus();
        break;
      }
      case "Escape":
        e.preventDefault();
        this.contextMenu = { ...this.contextMenu, visible: false };
        break;
    }
  }

  /** Tree node structure for tree view */
  private buildFileTree(
    files: StatusEntry[],
  ): Map<string, { file?: StatusEntry; children: Map<string, unknown> }> {
    const root = new Map<
      string,
      { file?: StatusEntry; children: Map<string, unknown> }
    >();

    for (const file of files) {
      const parts = file.path.split("/");
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;

        if (!current.has(part)) {
          current.set(part, { children: new Map() });
        }

        const node = current.get(part)!;
        if (isFile) {
          node.file = file;
        }
        current = node.children as Map<
          string,
          { file?: StatusEntry; children: Map<string, unknown> }
        >;
      }
    }

    return root;
  }

  /** The query actually applied — trimmed and lowercased; "" when inactive. */
  private get filterTerm(): string {
    return this.filterQuery.trim().toLowerCase();
  }

  private get isFiltering(): boolean {
    return this.filterTerm.length > 0;
  }

  /**
   * Case-insensitive substring match against the FULL repo-relative path, so
   * `src/ut` narrows by directory. A basename match needs no separate arm:
   * the basename is a substring of the path, so `helper.ts` matches
   * `src/utils/helper.ts` through the same test.
   */
  private matchesFilter(file: StatusEntry): boolean {
    const term = this.filterTerm;
    if (!term) return true;
    return file.path.toLowerCase().includes(term);
  }

  /**
   * The filtered view of a section. Returns the SAME array instance when no
   * filter is active, so an inactive filter costs nothing and cannot make
   * `areStatusEntriesEqual`-style identity checks see spurious changes.
   */
  private applyFilter(files: StatusEntry[]): StatusEntry[] {
    return this.isFiltering ? files.filter((f) => this.matchesFilter(f)) : files;
  }

  private get filteredStagedFiles(): StatusEntry[] {
    return this.applyFilter(this.stagedFiles);
  }

  private get filteredUnstagedFiles(): StatusEntry[] {
    return this.applyFilter(this.unstagedFiles);
  }

  private handleFilterInput(e: Event): void {
    this.setFilterQuery((e.target as HTMLInputElement).value);
  }

  /** Clear from the × button or the empty-result state, keeping focus usable. */
  private clearFilter(): void {
    if (this.filterQuery === "") return;
    this.setFilterQuery("");
    this.focusFilterInput();
  }

  private focusFilterInput(): void {
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector(
        ".filter-input",
      ) as HTMLInputElement | null;
      input?.focus();
    });
  }

  private handleFilterKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // An empty box has nothing to clear, so Escape belongs to whatever is
    // above this panel (context menu, dialog) — let it through.
    if (this.filterQuery === "") return;
    e.preventDefault();
    // Stop here: the same keypress would otherwise reach the document-level
    // Escape handlers and close a menu/overlay the user never aimed at.
    e.stopPropagation();
    this.setFilterQuery("");
  }

  /**
   * Single entry point for changing the query, because three things have to
   * move together with it.
   */
  private setFilterQuery(value: string): void {
    if (this.filterQuery === value) return;
    this.filterQuery = value;

    // 1. The multi-file selection drives the batch Stage/Unstage/DISCARD
    //    buttons. A selection that outlived the filter would let "Discard"
    //    delete files that are no longer on screen — exactly the bulk hazard
    //    the filter must not introduce. Selection is therefore always a
    //    subset of what the filter shows.
    if (this.selectedFiles.size > 0) {
      const visible = new Set<string>();
      for (const f of this.filteredStagedFiles) visible.add(f.path);
      for (const f of this.filteredUnstagedFiles) visible.add(f.path);
      const pruned = new Set(
        Array.from(this.selectedFiles).filter((path) => visible.has(path)),
      );
      if (pruned.size !== this.selectedFiles.size) {
        this.selectedFiles = pruned;
        if (this.lastSelectedFile && !pruned.has(this.lastSelectedFile)) {
          this.lastSelectedFile = null;
        }
      }
    }

    // 2. Row indices are positional, so the keyboard cursor no longer points
    //    at the row it did before the list was re-cut.
    this.focusedIndex = -1;

    // 3. In tree view a match buried in a collapsed folder would leave the
    //    panel looking empty. Reveal the ancestors of everything that matches.
    if (this.isFiltering) this.expandAncestorsOfMatches();
  }

  private expandAncestorsOfMatches(): void {
    const next = new Set(this.expandedFolders);
    let added = false;
    for (const file of [
      ...this.filteredStagedFiles,
      ...this.filteredUnstagedFiles,
    ]) {
      const parts = file.path.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        if (!next.has(path)) {
          next.add(path);
          added = true;
        }
      }
    }
    if (added) this.expandedFolders = next;
  }

  private toggleFolder(folderPath: string): void {
    const newSet = new Set(this.expandedFolders);
    if (newSet.has(folderPath)) {
      newSet.delete(folderPath);
    } else {
      newSet.add(folderPath);
    }
    this.expandedFolders = newSet;
  }

  private toggleViewMode(): void {
    this.viewMode = this.viewMode === "flat" ? "tree" : "flat";
    // Expand all folders by default when switching to tree view
    if (this.viewMode === "tree") {
      const allFolders = new Set<string>();
      const collectFolders = (files: StatusEntry[]) => {
        for (const file of files) {
          const parts = file.path.split("/");
          let path = "";
          for (let i = 0; i < parts.length - 1; i++) {
            path = path ? `${path}/${parts[i]}` : parts[i];
            allFolders.add(path);
          }
        }
      };
      collectFolders(this.stagedFiles);
      collectFolders(this.unstagedFiles);
      this.expandedFolders = allFolders;
    }
  }

  /** Count all files in a tree node (recursively) */
  private countTreeNodeFiles(node: {
    file?: StatusEntry;
    children: Map<string, unknown>;
  }): number {
    if (node.file) return 1;
    let count = 0;
    for (const child of node.children.values()) {
      count += this.countTreeNodeFiles(
        child as { file?: StatusEntry; children: Map<string, unknown> },
      );
    }
    return count;
  }

  /**
   * Count only the files a tree node actually RENDERS — a collapsed folder
   * renders none. The keyboard model (getAllVisibleFiles) numbers rows this
   * way, so the data-index the rows carry has to be counted the same way;
   * counting hidden files here put `.focused` on a different row than the one
   * Enter/s/u acted on. `path` is the node's own full path.
   */
  private countVisibleTreeNodeFiles(
    node: { file?: StatusEntry; children: Map<string, unknown> },
    path: string,
  ): number {
    if (node.file) return 1;
    if (!this.expandedFolders.has(path)) return 0;
    let count = 0;
    for (const [childName, child] of node.children.entries()) {
      count += this.countVisibleTreeNodeFiles(
        child as { file?: StatusEntry; children: Map<string, unknown> },
        path ? `${path}/${childName}` : childName,
      );
    }
    return count;
  }

  /**
   * How many rows a section actually renders (collapsed folders hide theirs).
   * `prebuiltTree` lets a caller that has already built this section's tree
   * hand it over, so one render pass does not build the same tree twice.
   */
  private visibleFileCount(
    files: StatusEntry[],
    prebuiltTree?: Map<
      string,
      { file?: StatusEntry; children: Map<string, unknown> }
    >,
  ): number {
    if (this.viewMode !== "tree") return files.length;
    const visible: StatusEntry[] = [];
    this.collectVisibleFromNode(
      prebuiltTree ?? this.buildFileTree(files),
      "",
      visible,
    );
    return visible.length;
  }

  /**
   * Collect all file paths under a given directory prefix.
   *
   * Callers pass the FILTERED section list: a folder row rendered under an
   * active filter shows (and counts) only matching files, so its stage /
   * unstage / discard buttons must not reach the ones the filter hid.
   */
  private getFilesUnderPath(
    files: StatusEntry[],
    dirPath: string,
  ): StatusEntry[] {
    const prefix = dirPath + "/";
    return files.filter(
      (f) => f.path.startsWith(prefix) || f.path === dirPath,
    );
  }

  /** Stage all files under a directory */
  private async handleStageDirectory(
    dirPath: string,
    e: Event,
  ): Promise<void> {
    e.stopPropagation();
    const filesToStage = this.getFilesUnderPath(
      this.filteredUnstagedFiles,
      dirPath,
    );
    if (filesToStage.length === 0) return;

    const paths = this.stageablePaths(filesToStage);
    if (paths.length === 0) return;
    const result = await gitService.stageFiles(this.repositoryPath, { paths });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to stage files', 'error');
    }
  }

  /** Unstage all files under a directory */
  private async handleUnstageDirectory(
    dirPath: string,
    e: Event,
  ): Promise<void> {
    e.stopPropagation();
    const filesToUnstage = this.getFilesUnderPath(
      this.filteredStagedFiles,
      dirPath,
    );
    if (filesToUnstage.length === 0) return;

    const paths = filesToUnstage.map((f) => f.path);
    const result = await gitService.unstageFiles(this.repositoryPath, {
      paths,
    });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to unstage files', 'error');
    }
  }

  /** Discard all changes under a directory */
  private async handleDiscardDirectory(
    dirPath: string,
    e: Event,
  ): Promise<void> {
    e.stopPropagation();
    const filesToDiscard = this.getFilesUnderPath(
      this.filteredUnstagedFiles,
      dirPath,
    );
    if (filesToDiscard.length === 0) return;

    const entries = this.discardableEntries(filesToDiscard);
    if (entries.length === 0) return;
    const paths = entries.map((f) => f.path);
    // Captured BEFORE the confirm await: discarding is irreversible and must
    // target the repo it was invoked on, even if the user switches tabs (which
    // rebinds this.repositoryPath) while the confirm is up.
    const repoPath = this.repositoryPath;
    // Claimed BEFORE the confirm. showConfirm is an IPC round trip before the
    // native dialog opens and takes focus, and the row × / toolbar button stay
    // on screen through that window — so a double-click stacked two
    // "permanently delete" prompts for one gesture and ran the discard twice.
    // The context-menu surfaces elsewhere are exempt because they close their
    // menu synchronously; these controls do not.
    // Reports its refusal. Returning bare here meant a discard requested while
    // "Discard all selected" was still running over hundreds of files did
    // NOTHING visible — no toast, no error, not even a console line — because
    // this check sat above the one that speaks.
    if (this.discarding) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    // discard_changes does its own forced checkout against the same working
    // tree every other destructive surface mutates, and the backend takes no
    // per-repo lock — so this must join the shared one rather than guard only
    // itself. Claimed before the confirm, like its siblings.
    if (!tryAcquireRefOp(repoPath)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.discarding = true;
    try {
      if (!(await this.confirmDiscard(entries, dirPath))) return;

      const result = await gitService.discardChanges(repoPath, paths);
      if (result.success) {
        await this.loadStatus();
      } else {
        showToast(result.error?.message ?? 'Failed to discard changes', 'error');
      }
    } finally {
      this.discarding = false;
      releaseRefOp(repoPath);
    }
  }

  private unsubscribeWatcher: (() => void) | null = null;
  private statusRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private hasInitiallyLoaded = false;
  private static readonly STATUS_REFRESH_DEBOUNCE_MS = 300;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.requestUpdate();
    });

    // Add document click listener for closing context menu
    document.addEventListener("click", this.handleDocumentClick);
    document.addEventListener("keydown", this.handleKeydownForContextMenu);

    // Subscribe to file change events with debouncing
    // Note: refs-changed is handled globally by app-shell to ensure it works
    // even when the right panel (and this component) is hidden
    this.unsubscribeWatcher = watcherService.onFileChange(this.handleWatcherEvent);

    // Listen for global stage-all, unstage-all, and refresh events
    // Both go through the same "shown" pair the section header buttons use:
    // see handleStageAllShown for why every surface must agree.
    this.boundHandleStageAllEvent = () => this.handleStageAllShown();
    this.boundHandleUnstageAllEvent = () => this.handleUnstageAllShown();
    this.boundHandleRefreshEvent = () => this.refresh();
    this.boundMarkStatusDirty = () => {
      this.statusDirtySeq++;
    };
    window.addEventListener("stage-all", this.boundHandleStageAllEvent);
    window.addEventListener("unstage-all", this.boundHandleUnstageAllEvent);
    window.addEventListener("status-refresh", this.boundHandleRefreshEvent);
    // `repository-refresh` is the broadcast handleRefresh() fires after EVERY
    // state-mutating operation — stash apply/pop/drop, reset, merge, rebase,
    // revert, a hunk staged from the diff view. Marking dirty here (rather than
    // reloading) means ensureStatusFresh cannot skip after an out-of-band
    // mutation, without enumerating the operations one by one: that list is
    // exactly what went stale and put "Stage all" back on a cached list.
    window.addEventListener("repository-refresh", this.boundMarkStatusDirty);

    // Listen for keyboard events
    this.addEventListener("keydown", this.handleKeyDown);
    this.setAttribute("tabindex", "0");

    await this.loadStatus();
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Keystrokes aimed at the filter box are text, not commands: the bare
    // shortcuts below are single letters, so typing "status" into the filter
    // would otherwise stage (s) and unstage (u) the focused file. The path is
    // read from composedPath() because the host listener retargets e.target
    // to this element.
    const origin = e.composedPath()[0];
    if (
      origin instanceof HTMLInputElement ||
      origin instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const allFiles = this.getAllVisibleFiles();
    if (allFiles.length === 0) return;

    // Single-character keys are bare shortcuts, never chords: the host row
    // carries tabindex="0", so clicking a file and then hitting the save
    // reflex Ctrl+S ran "stage selected" and Ctrl+U ran "unstage selected",
    // both silently. Modifier-carrying presses belong to the app-level
    // shortcuts, so let them through untouched. The multi-character arms
    // (Arrow*, Enter, Home, End) are unaffected — same guard lv-diff-view
    // already applies to its own `[` / `]` bindings.
    if (e.key.length === 1 && (e.ctrlKey || e.metaKey || e.altKey)) return;

    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        this.focusedIndex = Math.min(
          this.focusedIndex + 1,
          allFiles.length - 1,
        );
        if (this.focusedIndex < 0) this.focusedIndex = 0;
        this.scrollFocusedIntoView();
        break;

      case "ArrowUp":
      case "k":
        e.preventDefault();
        this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
        this.scrollFocusedIntoView();
        break;

      case "Enter":
        e.preventDefault();
        if (this.focusedIndex >= 0 && this.focusedIndex < allFiles.length) {
          this.handleFileClick(allFiles[this.focusedIndex]);
        }
        break;

      case " ":
        // Toggle selection on focused file
        e.preventDefault();
        if (this.focusedIndex >= 0 && this.focusedIndex < allFiles.length) {
          const file = allFiles[this.focusedIndex];
          const newSelected = new Set(this.selectedFiles);
          if (newSelected.has(file.path)) {
            newSelected.delete(file.path);
          } else {
            newSelected.add(file.path);
          }
          this.selectedFiles = newSelected;
          this.lastSelectedFile = file.path;
        }
        break;

      case "s":
        // Stage selected files or focused file
        e.preventDefault();
        if (this.selectedFiles.size > 0) {
          this.handleStageSelected();
        } else if (
          this.focusedIndex >= 0 &&
          this.focusedIndex < allFiles.length
        ) {
          const file = allFiles[this.focusedIndex];
          if (!this.stagedFiles.some((f) => f.path === file.path)) {
            this.handleStageFile(file, e);
          }
        }
        break;

      case "u":
        // Unstage selected files or focused file
        e.preventDefault();
        if (this.selectedFiles.size > 0) {
          this.handleUnstageSelected();
        } else if (
          this.focusedIndex >= 0 &&
          this.focusedIndex < allFiles.length
        ) {
          const file = allFiles[this.focusedIndex];
          if (this.stagedFiles.some((f) => f.path === file.path)) {
            this.handleUnstageFile(file, e);
          }
        }
        break;

      case "h":
        // File history for the focused file, the keyboard twin of the context
        // menu item. Selection is deliberately ignored: both views take one
        // path, so acting on a multi-file selection has no meaning.
        e.preventDefault();
        if (this.focusedIndex >= 0 && this.focusedIndex < allFiles.length) {
          this.requestFileHistory(allFiles[this.focusedIndex]);
        }
        break;

      case "b":
        // Blame for the focused file. Bare "b" only: Ctrl+B toggles the left
        // panel, and the modifier guard above already let that press through.
        e.preventDefault();
        if (this.focusedIndex >= 0 && this.focusedIndex < allFiles.length) {
          this.requestBlame(allFiles[this.focusedIndex]);
        }
        break;

      case "Home":
        e.preventDefault();
        this.focusedIndex = 0;
        this.scrollFocusedIntoView();
        break;

      case "End":
        e.preventDefault();
        this.focusedIndex = allFiles.length - 1;
        this.scrollFocusedIntoView();
        break;
    }
  };

  /**
   * The rows the panel actually renders, in render order — the filter cuts
   * this list too, so `focusedIndex` keeps addressing the row it highlights
   * and Enter/s/u never act on a file the filter hid.
   */
  private getAllVisibleFiles(): StatusEntry[] {
    const staged = this.filteredStagedFiles;
    const unstaged = this.filteredUnstagedFiles;
    const files: StatusEntry[] = [];
    if (this.stagedExpanded) {
      if (this.viewMode === "tree") {
        this.collectVisibleTreeFiles(staged, files);
      } else {
        files.push(...staged);
      }
    }
    if (this.unstagedExpanded) {
      if (this.viewMode === "tree") {
        this.collectVisibleTreeFiles(unstaged, files);
      } else {
        files.push(...unstaged);
      }
    }
    return files;
  }

  /** Collect only files visible in tree view (respecting collapsed folders) */
  private collectVisibleTreeFiles(
    sectionFiles: StatusEntry[],
    result: StatusEntry[],
  ): void {
    const tree = this.buildFileTree(sectionFiles);
    this.collectVisibleFromNode(tree, "", result);
  }

  private collectVisibleFromNode(
    children: Map<
      string,
      { file?: StatusEntry; children: Map<string, unknown> }
    >,
    parentPath: string,
    result: StatusEntry[],
  ): void {
    for (const [name, node] of children.entries()) {
      const nodePath = parentPath ? `${parentPath}/${name}` : name;
      if (node.file) {
        result.push(node.file);
      } else {
        // It's a folder - only recurse if expanded
        if (this.expandedFolders.has(nodePath)) {
          this.collectVisibleFromNode(
            node.children as Map<
              string,
              { file?: StatusEntry; children: Map<string, unknown> }
            >,
            nodePath,
            result,
          );
        }
      }
    }
  }

  private scrollFocusedIntoView(): void {
    requestAnimationFrame(() => {
      const item = this.shadowRoot?.querySelector(
        `[data-index="${this.focusedIndex}"]`,
      );
      item?.scrollIntoView({ block: "nearest" });
    });
  }

  private boundHandleStageAllEvent: (() => void) | null = null;
  private boundHandleUnstageAllEvent: (() => void) | null = null;
  private boundHandleRefreshEvent: (() => void) | null = null;
  private boundMarkStatusDirty: (() => void) | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;

    // Remove document click listener
    document.removeEventListener("click", this.handleDocumentClick);
    document.removeEventListener("keydown", this.handleKeydownForContextMenu);

    // Clear debounce timeout
    if (this.statusRefreshTimeout) {
      clearTimeout(this.statusRefreshTimeout);
      this.statusRefreshTimeout = null;
    }

    // Unsubscribe from file changes
    if (this.unsubscribeWatcher) {
      this.unsubscribeWatcher();
      this.unsubscribeWatcher = null;
    }

    // Remove global event listeners
    if (this.boundHandleStageAllEvent) {
      window.removeEventListener("stage-all", this.boundHandleStageAllEvent);
    }
    if (this.boundHandleUnstageAllEvent) {
      window.removeEventListener(
        "unstage-all",
        this.boundHandleUnstageAllEvent,
      );
    }
    if (this.boundHandleRefreshEvent) {
      window.removeEventListener(
        "status-refresh",
        this.boundHandleRefreshEvent,
      );
    }
    if (this.boundMarkStatusDirty) {
      window.removeEventListener("repository-refresh", this.boundMarkStatusDirty);
    }

    // Remove keyboard listener
    this.removeEventListener("keydown", this.handleKeyDown);
  }

  /**
   * Route file-watcher events. Every open repo is watched — only THIS
   * panel's repo may trigger a status reload here; background repos are
   * routed to staleness by app-shell and refresh when their tab activates.
   * (refs-changed stays global in app-shell so it works while this panel is
   * hidden.)
   */
  private handleWatcherEvent = (event: watcherService.FileChangeEvent): void => {
    if (event.repoPath !== this.repositoryPath) return;
    if (
      event.eventType === "workdir-changed" ||
      event.eventType === "index-changed"
    ) {
      this.debouncedLoadStatus();
    }
  };

  /**
   * Debounced version of loadStatus to prevent excessive refreshes
   * when multiple file changes occur in rapid succession.
   */
  private debouncedLoadStatus(): void {
    if (this.statusRefreshTimeout) {
      clearTimeout(this.statusRefreshTimeout);
    }
    // The list is known-stale from the moment the watcher fires, not from when
    // the debounce expires — a stage-all inside that window must reload.
    this.statusDirtySeq++;
    this.statusRefreshTimeout = setTimeout(() => {
      this.statusRefreshTimeout = null;
      this.loadStatus();
    }, LvFileStatus.STATUS_REFRESH_DEBOUNCE_MS);
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has("repositoryPath") && this.repositoryPath) {
      // A menu entry acts on the file it was opened over, but resolves the repo
      // from `this.repositoryPath` at click time — and a keyboard tab switch
      // produces neither a document click nor Escape, so the menu would survive
      // the rebind and discard/stage repo A's file inside repo B.
      this.contextMenu = { ...this.contextMenu, visible: false };
      // The multi-file selection is a set of PATHS, and the row buttons and the
      // s/u shortcuts redirect to the batch handlers whenever the clicked file
      // is in it — so a selection carried across the rebind re-selects
      // same-named files in the new repo (guaranteed with several worktrees of
      // one project open as tabs) and turns a single-file discard into a batch
      // discard of files never selected here.
      this.selectedFiles = new Set();
      this.lastSelectedFile = null;
      // The filter is a view of ONE repo's paths. Carrying it across a tab
      // switch would open the new repo on a silently narrowed list — and the
      // section counts would read "0 of 128" for a query the user typed
      // against a different working tree.
      this.filterQuery = "";
      this.focusedIndex = -1;
      // Reset for new repository so we show loading on first load
      this.hasInitiallyLoaded = false;
      this.statusDirtySeq++;
      // Start watching the new repository
      try {
        await watcherService.startWatching(this.repositoryPath);
      } catch (err) {
        // watcher.service already warns the user that auto-refresh is
        // unavailable (with the actionable cause); don't toast twice
        console.warn("Failed to start file watcher:", err);
      }
      await this.loadStatus();
    }
  }

  // Monotonic sequence per repo path: a load only applies its result if no
  // NEWER load for the same path started meanwhile (path equality alone
  // can't catch A -> B -> A switches reordering two loads for A)
  private statusLoadSeq = new Map<string, number>();

  /** Path of the last COMPLETED successful load.
   *
   * Freshness is a GENERATION counter, not a boolean. A boolean is wrong
   * because ensureStatusFresh awaits a load already in flight: if the mutation
   * happened after that load started, its result predates the change, and
   * clearing a flag on completion would declare a stale list fresh. Each dirty
   * signal bumps `statusDirtySeq`; a load records which generation it observed,
   * so a signal that arrives mid-flight still leaves the two unequal. */
  private statusLoadedForPath: string | null = null;
  /** Re-entrancy guard for the discard controls; see handleDiscardFile. */
  @state() private discarding = false;
  private unsubscribeRefOps?: () => void;
  private statusDirtySeq = 1;
  private statusCleanSeq = 0;
  /** The load currently in flight, so a caller can await it instead of racing. */
  private statusLoadInFlight: Promise<void> | null = null;

  /**
   * Resolve once `unstagedFiles`/`stagedFiles` reflect the current repository.
   *
   * "Stage all" must act on what is on disk, not on a list left over from
   * another repo or from before a watcher event. Calling loadStatus()
   * unconditionally did that but cost a full working-tree walk on every
   * keypress — the sequence guard only discards a stale RESPONSE, it never
   * skips the request.
   */
  public async ensureStatusFresh(): Promise<void> {
    if (this.statusLoadInFlight) {
      await this.statusLoadInFlight;
    }
    if (
      this.statusCleanSeq !== this.statusDirtySeq ||
      this.statusLoadedForPath !== this.repositoryPath
    ) {
      await this.loadStatus();
    }
  }

  async loadStatus(): Promise<void> {
    const run = this.runLoadStatus();
    this.statusLoadInFlight = run;
    try {
      await run;
    } finally {
      if (this.statusLoadInFlight === run) this.statusLoadInFlight = null;
    }
  }

  private async runLoadStatus(): Promise<void> {
    if (!this.repositoryPath) return;
    // Captured before the await so a mid-flight tab switch still writes the
    // result to the repo it was loaded FROM
    const loadedPath = this.repositoryPath;
    const seq = (this.statusLoadSeq.get(loadedPath) ?? 0) + 1;
    this.statusLoadSeq.set(loadedPath, seq);
    const dirtyAtStart = this.statusDirtySeq;

    // Only show loading indicator on the very first load
    if (!this.hasInitiallyLoaded) {
      this.loading = true;
    }
    this.error = null;

    try {
      const result = await gitService.getStatus(loadedPath);
      // A newer load for the SAME path supersedes this one entirely (its
      // result is fresher for both the store and the panel).
      const isLatestForPath = this.statusLoadSeq.get(loadedPath) === seq;
      if (!isLatestForPath) return;
      // The tab may have switched while the fetch was in flight. The store
      // write below is path-keyed and always safe; the component's OWN
      // render state belongs to the now-active repo and must not be
      // overwritten with a stale result (showing repo A's files under repo
      // B's tab risks destructive actions on files the user never saw).
      const isCurrent = this.repositoryPath === loadedPath;

      if (!result.success) {
        if (isCurrent) {
          this.error = result.error?.message ?? "Failed to load status";
        }
        return;
      }

      const entries = result.data!;
      const newStagedFiles = entries.filter((e) => e.isStaged);
      const newUnstagedFiles = entries.filter((e) => !e.isStaged);

      // Mirror the loaded status into the repository store so path-keyed
      // consumers (e.g. the tab bar's dirty indicator) stay in sync
      repositoryStore.getState().updateRepoData(loadedPath, {
        status: entries,
        stagedFiles: newStagedFiles,
        unstagedFiles: newUnstagedFiles,
      });

      // The list for `loadedPath` is now current AS OF the generation this load
      // observed — a dirty signal that arrived while it was in flight leaves
      // the counters unequal, so the next ensureStatusFresh reloads.
      this.statusLoadedForPath = loadedPath;
      this.statusCleanSeq = dirtyAtStart;

      if (!isCurrent) return;

      // Only update if there are actual changes (delta update)
      const stagedChanged = !this.areStatusEntriesEqual(
        this.stagedFiles,
        newStagedFiles,
      );
      const unstagedChanged = !this.areStatusEntriesEqual(
        this.unstagedFiles,
        newUnstagedFiles,
      );

      if (stagedChanged) {
        this.stagedFiles = newStagedFiles;
      }
      if (unstagedChanged) {
        this.unstagedFiles = newUnstagedFiles;
      }

      // Emit status changed event only if something changed
      if (stagedChanged || unstagedChanged) {
        this.dispatchEvent(
          new CustomEvent("status-changed", {
            detail: {
              stagedCount: this.stagedFiles.length,
              totalCount: this.stagedFiles.length + this.unstagedFiles.length,
            },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } catch (err) {
      if (this.repositoryPath === loadedPath) {
        this.error = err instanceof Error ? err.message : "Unknown error";
      }
    } finally {
      // A stale load must not stomp the loading state of the load that the
      // now-active repo owns
      if (this.repositoryPath === loadedPath) {
        this.loading = false;
        this.hasInitiallyLoaded = true;
      }
    }
  }

  /**
   * Public method to refresh the status
   * Can be called from outside the component
   */
  public refresh(): void {
    this.loadStatus();
  }

  /**
   * Compare two arrays of status entries for equality
   */
  private areStatusEntriesEqual(a: StatusEntry[], b: StatusEntry[]): boolean {
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
      if (
        a[i].path !== b[i].path ||
        a[i].status !== b[i].status ||
        a[i].isStaged !== b[i].isStaged ||
        a[i].isConflicted !== b[i].isConflicted
      ) {
        return false;
      }
    }
    return true;
  }

  private getStatusLabel(status: FileStatus): string {
    const labels: Record<FileStatus, string> = {
      new: "A",
      modified: "M",
      deleted: "D",
      renamed: "R",
      copied: "C",
      ignored: "I",
      untracked: "?",
      typechange: "T",
      conflicted: "!",
    };
    return labels[status] || "?";
  }

  /**
   * Check if a file is partially staged (has changes in both staged and unstaged)
   */
  private isPartiallyStaged(filePath: string): boolean {
    const inStaged = this.stagedFiles.some((f) => f.path === filePath);
    const inUnstaged = this.unstagedFiles.some((f) => f.path === filePath);
    return inStaged && inUnstaged;
  }

  /**
   * Staging a conflicted file would put git's conflict-marker text into the
   * index and clear the conflict entries — git would then treat the file as
   * "resolved" with markers in it. Route to the merge editor instead.
   */
  private redirectConflictedToMergeEditor(file: StatusEntry): void {
    this.dispatchEvent(
      new CustomEvent('open-conflict-dialog', {
        detail: { filePath: file.path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Filter conflicted files out of a bulk stage, with feedback for what was
   * skipped — they must be resolved in the merge editor, not staged raw.
   */
  private stageablePaths(files: StatusEntry[]): string[] {
    const conflicted = files.filter((f) => f.isConflicted);
    if (conflicted.length > 0) {
      showToast(
        `${conflicted.length} conflicted file${conflicted.length === 1 ? '' : 's'} skipped — resolve ${conflicted.length === 1 ? 'it' : 'them'} in the merge editor first`,
        'warning',
      );
    }
    return files.filter((f) => !f.isConflicted).map((f) => f.path);
  }

  /**
   * Filter conflicted files out of a bulk discard, with feedback for what
   * was skipped. A conflicted path has no stage-0 index entry, so the
   * backend either silently no-ops or DELETES the merged working file while
   * the index stays conflicted — either way the conflict must be resolved
   * (or the operation aborted) in the merge editor instead.
   */
  private discardableEntries(files: StatusEntry[]): StatusEntry[] {
    const conflicted = files.filter((f) => f.isConflicted);
    if (conflicted.length > 0) {
      showToast(
        `${conflicted.length} conflicted file${conflicted.length === 1 ? '' : 's'} skipped — resolve ${conflicted.length === 1 ? 'it' : 'them'} in the merge editor (or abort the operation) instead`,
        'warning',
      );
    }
    return files.filter((f) => !f.isConflicted);
  }

  /**
   * Confirm title/message for a discard.
   *
   * Discarding an UNTRACKED file deletes it from disk — staging.rs classifies
   * anything absent from both the index and HEAD as untracked and removes it.
   * There is no git object and no trash, so the file is unrecoverable. "Discard
   * changes to X" reads as "restore X to its previous state", which materially
   * understates that, and in bulk "discard changes to 12 files" can mean 12
   * permanent deletions. Name the deletion whenever one is involved.
   */
  /**
   * Prompt for a discard, honouring the "Confirm Before Discard" setting.
   *
   * Returns true when the caller should proceed.
   *
   * The setting only suppresses the prompt for TRACKED files, whose content is
   * restored from the index and is therefore recoverable. Any selection that
   * includes an untracked file always prompts: those are deleted from disk with
   * no git object and no trash, and a preference for fewer dialogs must not
   * silently become unrecoverable deletion.
   */
  private async confirmDiscard(files: StatusEntry[], scope?: string): Promise<boolean> {
    const hasUntracked = files.some((f) => f.status === 'untracked');
    if (!hasUntracked && !settingsStore.getState().confirmBeforeDiscard) {
      return true;
    }

    const { title, message } = this.discardConfirmCopy(files, scope);
    return showConfirm(title, message, 'warning');
  }

  private discardConfirmCopy(
    files: StatusEntry[],
    scope?: string,
  ): { title: string; message: string } {
    const untracked = files.filter((f) => f.status === 'untracked').length;
    const tracked = files.length - untracked;
    const where = scope ? ` in "${scope}"` : '';
    const plural = (n: number) => (n === 1 ? '' : 's');

    if (files.length === 1) {
      return untracked === 1
        ? {
            title: 'Delete Untracked File',
            message: `Permanently delete the untracked file "${files[0].path}"? It is not in Git and cannot be recovered.`,
          }
        : {
            title: 'Discard Changes',
            message: `Discard changes to "${files[0].path}"? This cannot be undone.`,
          };
    }

    if (untracked === 0) {
      return {
        title: 'Discard Changes',
        message: `Discard changes to ${tracked} file${plural(tracked)}${where}? This cannot be undone.`,
      };
    }

    if (tracked === 0) {
      return {
        title: 'Delete Untracked Files',
        message: `Permanently delete ${untracked} untracked file${plural(untracked)}${where}? They are not in Git and cannot be recovered.`,
      };
    }

    return {
      title: 'Discard Changes',
      message: `Discard changes to ${tracked} file${plural(tracked)} and permanently delete ${untracked} untracked file${plural(untracked)}${where}? This cannot be undone.`,
    };
  }

  private async handleStageFile(file: StatusEntry, e: Event): Promise<void> {
    e.stopPropagation();

    // If multiple files are selected and this file is one of them, stage all
    // selected — handleStageSelected stages the non-conflicted subset with a
    // toast for what was skipped. This must run BEFORE the single-file
    // conflict redirect, or the other selected files would be silently dropped.
    if (this.selectedFiles.size > 1 && this.selectedFiles.has(file.path)) {
      await this.handleStageSelected();
      return;
    }

    if (file.isConflicted) {
      this.redirectConflictedToMergeEditor(file);
      return;
    }

    const result = await gitService.stageFiles(this.repositoryPath, {
      paths: [file.path],
    });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to stage file', 'error');
    }
  }

  private async handleUnstageFile(file: StatusEntry, e: Event): Promise<void> {
    e.stopPropagation();
    
    // If multiple files are selected and this file is one of them, unstage all selected
    if (this.selectedFiles.size > 1 && this.selectedFiles.has(file.path)) {
      await this.handleUnstageSelected();
      return;
    }
    
    const result = await gitService.unstageFiles(this.repositoryPath, {
      paths: [file.path],
    });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to unstage file', 'error');
    }
  }

  private async handleDiscardFile(file: StatusEntry, e: Event): Promise<void> {
    e.stopPropagation();

    // If multiple files are selected and this file is one of them, discard all selected
    if (this.selectedFiles.size > 1 && this.selectedFiles.has(file.path)) {
      await this.handleDiscardSelected();
      return;
    }

    // Discarding a conflicted file either silently no-ops or deletes the
    // merged working file (no stage-0 entry) — route to the merge editor,
    // matching the stage guard.
    if (file.isConflicted) {
      this.redirectConflictedToMergeEditor(file);
      return;
    }

    // Captured BEFORE the confirm await: discarding is irreversible and must
    // target the repo it was invoked on, even if the user switches tabs (which
    // rebinds this.repositoryPath) while the confirm is up.
    const repoPath = this.repositoryPath;
    // Claimed BEFORE the confirm. showConfirm is an IPC round trip before the
    // native dialog opens and takes focus, and the row × / toolbar button stay
    // on screen through that window — so a double-click stacked two
    // "permanently delete" prompts for one gesture and ran the discard twice.
    // The context-menu surfaces elsewhere are exempt because they close their
    // menu synchronously; these controls do not.
    // Reports its refusal. Returning bare here meant a discard requested while
    // "Discard all selected" was still running over hundreds of files did
    // NOTHING visible — no toast, no error, not even a console line — because
    // this check sat above the one that speaks.
    if (this.discarding) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    // discard_changes does its own forced checkout against the same working
    // tree every other destructive surface mutates, and the backend takes no
    // per-repo lock — so this must join the shared one rather than guard only
    // itself. Claimed before the confirm, like its siblings.
    if (!tryAcquireRefOp(repoPath)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.discarding = true;
    try {
      if (!(await this.confirmDiscard([file]))) return;

      const result = await gitService.discardChanges(repoPath, [file.path]);
      if (result.success) {
        await this.loadStatus();
      } else {
        showToast(result.error?.message ?? 'Failed to discard changes', 'error');
      }
    } finally {
      this.discarding = false;
      releaseRefOp(repoPath);
    }
  }

  /**
   * "Stage/unstage everything the list is showing" — for EVERY surface.
   *
   * Three of them reach this pair: the section header buttons, the global
   * s / u shortcuts, and the palette's "Stage all changes" / "Unstage all
   * changes" (both of which arrive as the `stage-all` / `unstage-all` window
   * events). They used to disagree — the buttons honoured the path filter and
   * the other two ignored it — so in the same repo at the same moment "stage
   * all" staged 1 file from the button and 4 from the keyboard, with nothing
   * on screen to say which one had happened.
   *
   * The filtered set wins because it is the only one the user can see, and
   * because the alternative silently stages files the filter is hiding. The
   * two surfaces whose labels still say ALL are invoked from outside this
   * panel and cannot know a filter is on, so `reportFilteredScope` says what
   * "all" meant this time.
   */
  private handleStageAllShown = (): Promise<void> =>
    this.stageFileSet(this.filteredUnstagedFiles);

  private handleUnstageAllShown = (): Promise<void> =>
    this.unstageFileSet(this.filteredStagedFiles);

  /**
   * Report a bulk stage/unstage the filter narrowed.
   *
   * Silent when no filter is active, and silent when the filter happens to
   * show everything: there is then nothing surprising to explain.
   *
   * The gate is what the FILTER withheld (`visible` vs `total`), not what was
   * acted on (`acted`): the staging path also drops conflicted files, and
   * those already have their own warning. Gating on the acted count made this
   * toast blame the filter for a conflict it never hid — two toasts at once,
   * one of them false. `acted` still supplies the number in the message so it
   * keeps agreeing with that warning.
   */
  private reportFilteredScope(
    verb: 'Staged' | 'Unstaged',
    acted: number,
    visible: number,
    total: number,
  ): void {
    if (!this.isFiltering || visible >= total) return;
    showToast(
      `${verb} ${acted} of ${total} file${total === 1 ? '' : 's'} — the filter "${this.filterQuery.trim()}" is hiding the rest`,
      'info',
    );
  }

  /**
   * The same honesty for the empty case: with a filter that matches nothing,
   * the shortcut and the palette entry would otherwise do nothing at all and
   * say nothing at all. An unfiltered panel with no files stays silent — there
   * is no hidden state to explain there.
   */
  private reportEmptyFilteredScope(verb: 'stage' | 'unstage', total: number): void {
    if (!this.isFiltering || total === 0) return;
    showToast(
      `Nothing to ${verb} — no file matches the filter "${this.filterQuery.trim()}"`,
      'info',
    );
  }

  private async stageFileSet(files: StatusEntry[]): Promise<void> {
    const total = this.unstagedFiles.length;
    const paths = this.stageablePaths(files);
    if (paths.length === 0) {
      // Only when the FILTER emptied the set: stageablePaths has already
      // spoken when conflicts are what is left.
      if (files.length === 0) this.reportEmptyFilteredScope('stage', total);
      return;
    }

    const result = await gitService.stageFiles(this.repositoryPath, { paths });
    if (result.success) {
      // Before loadStatus, which rewrites unstagedFiles out from under `total`.
      // `paths` — not `files` — is what was actually staged: stageablePaths has
      // already dropped conflicted entries, and counting them here would have
      // the toast claim files the separate "conflicted file skipped" warning
      // says were left alone. `files` is what the filter left visible, which is
      // the only thing that can decide whether the filter hid anything at all.
      this.reportFilteredScope('Staged', paths.length, files.length, total);
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to stage files', 'error');
    }
  }

  private async unstageFileSet(files: StatusEntry[]): Promise<void> {
    const total = this.stagedFiles.length;
    const paths = files.map((f) => f.path);
    if (paths.length === 0) {
      this.reportEmptyFilteredScope('unstage', total);
      return;
    }

    const result = await gitService.unstageFiles(this.repositoryPath, {
      paths,
    });
    if (result.success) {
      // `paths` is the set actually sent AND the whole visible set — nothing
      // is dropped on this path — so neither count can drift from what was
      // unstaged (as they did for the staging path above).
      this.reportFilteredScope('Unstaged', paths.length, files.length, total);
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to unstage files', 'error');
    }
  }

  // Multi-select helper methods
  /**
   * Selected files in a section, read from the FILTERED list. setFilterQuery
   * already prunes the selection, so this is belt and braces: no batch button
   * can count — or act on — a file the filter is hiding.
   */
  private getSelectedFilesInSection(staged: boolean): StatusEntry[] {
    const files = staged ? this.filteredStagedFiles : this.filteredUnstagedFiles;
    return files.filter((f) => this.selectedFiles.has(f.path));
  }

  private handleFileClick(file: StatusEntry, e?: MouseEvent): void {
    const allFiles = this.getAllVisibleFiles();
    const clickedIndex = allFiles.findIndex((f) => f.path === file.path);

    if (e?.ctrlKey || e?.metaKey) {
      // Toggle selection
      const newSelected = new Set(this.selectedFiles);
      if (newSelected.has(file.path)) {
        newSelected.delete(file.path);
      } else {
        newSelected.add(file.path);
      }
      this.selectedFiles = newSelected;
    } else if (e?.shiftKey && this.lastSelectedFile) {
      // Range select
      const lastIndex = allFiles.findIndex(
        (f) => f.path === this.lastSelectedFile,
      );
      if (lastIndex !== -1 && clickedIndex !== -1) {
        const start = Math.min(lastIndex, clickedIndex);
        const end = Math.max(lastIndex, clickedIndex);
        const newSelected = new Set(this.selectedFiles);
        for (let i = start; i <= end; i++) {
          newSelected.add(allFiles[i].path);
        }
        this.selectedFiles = newSelected;
      }
    } else {
      // Single select (clear others)
      this.selectedFiles = new Set([file.path]);
    }

    this.lastSelectedFile = file.path;
    this.focusedIndex = clickedIndex;

    // Dispatch event with selected files
    this.dispatchEvent(
      new CustomEvent("file-selected", {
        detail: { file, selectedFiles: Array.from(this.selectedFiles), isPartiallyStaged: this.isPartiallyStaged(file.path) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // Batch operation handlers
  private async handleStageSelected(): Promise<void> {
    const paths = this.stageablePaths(
      this.filteredUnstagedFiles.filter((f) => this.selectedFiles.has(f.path))
    );
    if (paths.length === 0) return;

    const result = await gitService.stageFiles(this.repositoryPath, { paths });
    if (result.success) {
      // Remove staged files from selection
      const newSelected = new Set(this.selectedFiles);
      paths.forEach((p) => newSelected.delete(p));
      this.selectedFiles = newSelected;
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to stage files', 'error');
    }
  }

  private async handleUnstageSelected(): Promise<void> {
    const paths = this.filteredStagedFiles
      .filter((f) => this.selectedFiles.has(f.path))
      .map((f) => f.path);
    if (paths.length === 0) return;

    const result = await gitService.unstageFiles(this.repositoryPath, {
      paths,
    });
    if (result.success) {
      const newSelected = new Set(this.selectedFiles);
      paths.forEach((p) => newSelected.delete(p));
      this.selectedFiles = newSelected;
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to unstage files', 'error');
    }
  }

  private async handleDiscardSelected(): Promise<void> {
    const entries = this.discardableEntries(
      this.filteredUnstagedFiles.filter((f) => this.selectedFiles.has(f.path))
    );
    if (entries.length === 0) return;
    const paths = entries.map((f) => f.path);

    // Captured BEFORE the confirm await: discarding is irreversible and must
    // target the repo it was invoked on, even if the user switches tabs (which
    // rebinds this.repositoryPath) while the confirm is up.
    const repoPath = this.repositoryPath;
    // Claimed BEFORE the confirm. showConfirm is an IPC round trip before the
    // native dialog opens and takes focus, and the row × / toolbar button stay
    // on screen through that window — so a double-click stacked two
    // "permanently delete" prompts for one gesture and ran the discard twice.
    // The context-menu surfaces elsewhere are exempt because they close their
    // menu synchronously; these controls do not.
    // Reports its refusal. Returning bare here meant a discard requested while
    // "Discard all selected" was still running over hundreds of files did
    // NOTHING visible — no toast, no error, not even a console line — because
    // this check sat above the one that speaks.
    if (this.discarding) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    // discard_changes does its own forced checkout against the same working
    // tree every other destructive surface mutates, and the backend takes no
    // per-repo lock — so this must join the shared one rather than guard only
    // itself. Claimed before the confirm, like its siblings.
    if (!tryAcquireRefOp(repoPath)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.discarding = true;
    try {
      if (!(await this.confirmDiscard(entries))) return;

      const result = await gitService.discardChanges(repoPath, paths);
      if (result.success) {
        const newSelected = new Set(this.selectedFiles);
        paths.forEach((p) => newSelected.delete(p));
        this.selectedFiles = newSelected;
        await this.loadStatus();
      } else {
        showToast(result.error?.message ?? 'Failed to discard changes', 'error');
      }
    } finally {
      this.discarding = false;
      releaseRefOp(repoPath);
    }
  }

  // Context menu handlers
  private handleContextMenu(
    e: MouseEvent,
    file: StatusEntry,
    isStaged: boolean,
  ): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      file,
      isStaged,
    };
  }

  private async handleContextStage(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (file.isConflicted) {
      this.redirectConflictedToMergeEditor(file);
      return;
    }
    const result = await gitService.stageFiles(this.repositoryPath, {
      paths: [file.path],
    });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to stage file', 'error');
    }
  }

  private async handleContextUnstage(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    const result = await gitService.unstageFiles(this.repositoryPath, {
      paths: [file.path],
    });
    if (result.success) {
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? 'Failed to unstage file', 'error');
    }
  }

  /**
   * Write a .gitignore rule for the context-menu file.
   *
   * Shaped like every sibling handler: the menu closes synchronously before the
   * await, the working tree is reloaded on success, and a failure speaks
   * through a toast rather than the console.
   */
  private async handleContextIgnore(pattern: string): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    const result = await gitService.addToGitignore(this.repositoryPath, [
      pattern,
    ]);
    if (result.success) {
      // add_to_gitignore skips a pattern that is already present, so this reads
      // true whether the rule was written now or was already in the file.
      showToast(`"${file.path}" is now ignored`, "success");
      await this.loadStatus();
    } else {
      showToast(result.error?.message ?? "Failed to update .gitignore", "error");
    }
  }

  private handleContextViewDiff(): void {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(
      new CustomEvent("file-selected", {
        detail: { file, isPartiallyStaged: this.isPartiallyStaged(file.path) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * True when the row's path is already in HEAD, and so has something for the
   * history and blame views to read.
   *
   * An untracked row obviously has none. Neither does a path staged as new:
   * `get_status` reports that as a staged "new" entry, and if the file was
   * edited again after `git add` it ALSO produces an unstaged "modified" row
   * for the same path — that second row is just as historyless, so both are
   * judged by the same test rather than by the row's own status alone.
   */
  private fileHasHistory(file: StatusEntry): boolean {
    if (file.status === "untracked") return false;
    return !this.stagedFiles.some(
      (f) => f.path === file.path && f.status === "new",
    );
  }

  /**
   * Blame renders the working copy, so a file that is gone from the worktree
   * has nothing to render — the same reason the commit file list hides blame
   * for a deleted path.
   */
  private fileCanBlame(file: StatusEntry): boolean {
    return this.fileHasHistory(file) && file.status !== "deleted";
  }

  /**
   * Open the file-history pane for a working-tree row.
   *
   * Same event and detail shape the commit file list raises, so app-shell's
   * existing `show-file-history` handler serves both. The right panel that
   * hosts this component already listens for it.
   */
  private requestFileHistory(file: StatusEntry): void {
    if (!this.fileHasHistory(file)) {
      showToast(`"${file.path}": ${NO_HISTORY_REASON}`, "warning");
      return;
    }
    this.dispatchEvent(
      new CustomEvent("show-file-history", {
        detail: { filePath: file.path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Open blame for a working-tree row.
   *
   * No `commitOid` on purpose: `get_file_blame` without one blames the working
   * copy against HEAD and attributes uncommitted lines to the zero OID, which
   * is exactly what a Changes row is asking about. The commit file list passes
   * its commit instead, and the detail shape is otherwise identical.
   */
  private requestBlame(file: StatusEntry): void {
    if (!this.fileHasHistory(file)) {
      showToast(`"${file.path}": ${NO_HISTORY_REASON}`, "warning");
      return;
    }
    if (file.status === "deleted") {
      showToast(
        `"${file.path}" is deleted from the working tree, so there is nothing to blame`,
        "warning",
      );
      return;
    }
    this.dispatchEvent(
      new CustomEvent("show-blame", {
        detail: { filePath: file.path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleContextViewHistory(): void {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.requestFileHistory(file);
  }

  private handleContextViewBlame(): void {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.requestBlame(file);
  }

  private async handleContextOpenInEditor(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      const fullPath = await join(this.repositoryPath, file.path);
      await shellOpen(fullPath);
    } catch (err) {
      console.error("Failed to open file:", err);
      showToast("Failed to open file in editor", "error");
    }
  }

  private async handleContextRevealInFinder(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      const fullPath = await join(this.repositoryPath, file.path);
      const result = await gitService.revealInFileManager(fullPath);
      if (!result.success) {
        showToast(result.error?.message ?? "Failed to reveal file in file manager", "error");
      }
    } catch (err) {
      console.error("Failed to reveal:", err);
      showToast("Failed to reveal file in file manager", "error");
    }
  }

  private async handleContextCopyPath(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(file.path);
    } catch (err) {
      console.error("Failed to copy:", err);
      showToast("Failed to copy file path to clipboard", "error");
    }
  }

  private async handleContextDiscard(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (file.isConflicted) {
      this.redirectConflictedToMergeEditor(file);
      return;
    }
    // Captured BEFORE the confirm await: discarding is irreversible and must
    // target the repo it was invoked on, even if the user switches tabs (which
    // rebinds this.repositoryPath) while the confirm is up.
    const repoPath = this.repositoryPath;
    // Claimed BEFORE the confirm. showConfirm is an IPC round trip before the
    // native dialog opens and takes focus, and the row × / toolbar button stay
    // on screen through that window — so a double-click stacked two
    // "permanently delete" prompts for one gesture and ran the discard twice.
    // The context-menu surfaces elsewhere are exempt because they close their
    // menu synchronously; these controls do not.
    // Reports its refusal. Returning bare here meant a discard requested while
    // "Discard all selected" was still running over hundreds of files did
    // NOTHING visible — no toast, no error, not even a console line — because
    // this check sat above the one that speaks.
    if (this.discarding) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    // discard_changes does its own forced checkout against the same working
    // tree every other destructive surface mutates, and the backend takes no
    // per-repo lock — so this must join the shared one rather than guard only
    // itself. Claimed before the confirm, like its siblings.
    if (!tryAcquireRefOp(repoPath)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.discarding = true;
    try {
      if (!(await this.confirmDiscard([file]))) return;

      const result = await gitService.discardChanges(repoPath, [file.path]);
      if (result.success) {
        await this.loadStatus();
      } else {
        showToast(result.error?.message ?? 'Failed to discard changes', 'error');
      }
    } finally {
      this.discarding = false;
      releaseRefOp(repoPath);
    }
  }

  private getFileNameAndDir(path: string): { name: string; dir: string } {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) {
      return { name: path, dir: "" };
    }
    return {
      name: path.slice(lastSlash + 1),
      dir: path.slice(0, lastSlash),
    };
  }

  private renderFileItem(file: StatusEntry, staged: boolean, index: number) {
    const isFocused = this.focusedIndex === index;
    const isSelected = this.selectedFiles.has(file.path);
    const isPartial = this.isPartiallyStaged(file.path);
    const { name, dir } = this.getFileNameAndDir(file.path);

    return html`
      <li
        class="file-item ${isSelected ? "selected" : ""} ${isFocused
          ? "focused"
          : ""} ${isPartial ? "partial-staged" : ""}"
        @click=${(e: MouseEvent) => this.handleFileClick(file, e)}
        @contextmenu=${(e: MouseEvent) =>
          this.handleContextMenu(e, file, staged)}
        title="${file.path}${isPartial ? " (partially staged)" : ""}"
        data-index="${index}"
      >
        ${isPartial ? html`<span class="partial-indicator"></span>` : nothing}
        <span class="file-status ${file.status}"
          >${this.getStatusLabel(file.status)}</span
        >
        <span class="file-name-container">
          <span class="file-name">${name}</span>
          ${dir ? html`<span class="file-dir">${dir}</span>` : nothing}
          ${isPartial ? html`<span class="partial-badge" title="This file has both staged and unstaged changes">partial</span>` : nothing}
        </span>
        <div class="file-actions">
          ${staged
            ? html`
                <button
                  class="file-action"
                  title="Unstage"
                  aria-label="Unstage ${name}"
                  @click=${(e: Event) => this.handleUnstageFile(file, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
              `
            : html`
                <button
                  class="file-action"
                  title="Stage"
                  aria-label="Stage ${name}"
                  @click=${(e: Event) => this.handleStageFile(file, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <button
                  class="file-action"
                  title="Discard changes"
                  aria-label="Discard changes for ${name}"
                  ?disabled=${this.discarding || isRefOpRunning(this.repositoryPath)}
                  @click=${(e: Event) => this.handleDiscardFile(file, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              `}
        </div>
      </li>
    `;
  }

  private renderTreeNode(
    name: string,
    node: { file?: StatusEntry; children: Map<string, unknown> },
    path: string,
    depth: number,
    staged: boolean,
    indexOffset: number,
  ): unknown {
    // If this node has a file, render it as a file item
    if (node.file) {
      const file = node.file;
      const index = indexOffset;
      const isFocused = this.focusedIndex === index;
      const isSelected = this.selectedFiles.has(file.path);
      const isPartial = this.isPartiallyStaged(file.path);

      return html`
        <li
          class="file-item tree-file-item ${isSelected
            ? "selected"
            : ""} ${isFocused ? "focused" : ""} ${isPartial ? "partial-staged" : ""}"
          style="--tree-depth: ${depth}"
          @click=${(e: MouseEvent) => this.handleFileClick(file, e)}
          @contextmenu=${(e: MouseEvent) =>
            this.handleContextMenu(e, file, staged)}
          title="${file.path}${isPartial ? " (partially staged)" : ""}"
          data-index="${index}"
        >
          ${isPartial ? html`<span class="partial-indicator"></span>` : nothing}
          <span class="file-status ${file.status}"
            >${this.getStatusLabel(file.status)}</span
          >
          <span class="file-name"><span>${name}</span>${isPartial ? html`<span class="partial-badge">partial</span>` : nothing}</span>
          <div class="file-actions">
            ${staged
              ? html`
                  <button
                    class="file-action"
                    title="Unstage"
                    @click=${(e: Event) => this.handleUnstageFile(file, e)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                `
              : html`
                  <button
                    class="file-action"
                    title="Stage"
                    @click=${(e: Event) => this.handleStageFile(file, e)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button
                    class="file-action"
                    title="Discard changes"
                    ?disabled=${this.discarding || isRefOpRunning(this.repositoryPath)}
                    @click=${(e: Event) => this.handleDiscardFile(file, e)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                `}
          </div>
        </li>
      `;
    }

    // Otherwise, render as a folder with children
    const isExpanded = this.expandedFolders.has(path);
    const children = Array.from(node.children.entries());
    const fileCount = this.countTreeNodeFiles(node);
    let currentIndex = indexOffset;

    return html`
      <li
        class="folder-item"
        style="--tree-depth: ${depth}"
        @click=${() => this.toggleFolder(path)}
        title="${path} (${fileCount} file${fileCount !== 1 ? "s" : ""})"
      >
        <svg
          class="chevron ${isExpanded ? "expanded" : ""}"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor">
          ${isExpanded
            ? html`<path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              ></path>`
            : html`<path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"
              ></path>`}
        </svg>
        <span class="folder-name">${name}</span>
        <span class="folder-count">${fileCount}</span>
        <div class="folder-actions">
          ${staged
            ? html`
                <button
                  class="file-action"
                  title="Unstage directory"
                  aria-label="Unstage directory ${path}"
                  @click=${(e: Event) => this.handleUnstageDirectory(path, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
              `
            : html`
                <button
                  class="file-action"
                  title="Stage directory"
                  aria-label="Stage directory ${path}"
                  @click=${(e: Event) => this.handleStageDirectory(path, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <button
                  class="file-action"
                  title="Discard directory changes"
                  aria-label="Discard changes for directory ${path}"
                  ?disabled=${this.discarding || isRefOpRunning(this.repositoryPath)}
                  @click=${(e: Event) => this.handleDiscardDirectory(path, e)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              `}
        </div>
      </li>
      ${isExpanded
        ? html`
            <ul class="folder-children">
              ${children.map(([childName, childNode]) => {
                const childPath = path ? `${path}/${childName}` : childName;
                const result = this.renderTreeNode(
                  childName,
                  childNode as {
                    file?: StatusEntry;
                    children: Map<string, unknown>;
                  },
                  childPath,
                  depth + 1,
                  staged,
                  currentIndex,
                );
                currentIndex += this.countVisibleTreeNodeFiles(
                  childNode as {
                    file?: StatusEntry;
                    children: Map<string, unknown>;
                  },
                  childPath,
                );
                return result;
              })}
            </ul>
          `
        : nothing}
    `;
  }

  private renderSelectionActions(staged: boolean) {
    const selectedInSection = this.getSelectedFilesInSection(staged);
    if (selectedInSection.length === 0) return nothing;

    return html`
      <div class="selection-actions">
        <span class="selection-count"
          >${selectedInSection.length} selected</span
        >
        ${staged
          ? html`
              <button
                class="selection-action-btn"
                @click=${() => this.handleUnstageSelected()}
                title="Unstage selected files"
              >
                Unstage
              </button>
            `
          : html`
              <button
                class="selection-action-btn"
                @click=${() => this.handleStageSelected()}
                title="Stage selected files"
              >
                Stage
              </button>
              <button
                class="selection-action-btn danger"
                ?disabled=${this.discarding || isRefOpRunning(this.repositoryPath)}
                @click=${() => this.handleDiscardSelected()}
                title="Discard selected files"
              >
                Discard
              </button>
            `}
      </div>
    `;
  }

  private renderFileList(
    files: StatusEntry[],
    staged: boolean,
    indexOffset: number,
    prebuiltTree?: Map<
      string,
      { file?: StatusEntry; children: Map<string, unknown> }
    >,
  ) {
    if (this.viewMode === "tree") {
      const tree = prebuiltTree ?? this.buildFileTree(files);
      let currentIndex = indexOffset;

      return html`
        <ul class="file-list" role="list">
          ${Array.from(tree.entries()).map(([name, node]) => {
            const result = this.renderTreeNode(
              name,
              node,
              name,
              0,
              staged,
              currentIndex,
            );
            currentIndex += this.countVisibleTreeNodeFiles(node, name);
            return result;
          })}
        </ul>
      `;
    }

    return html`
      <ul class="file-list" role="list">
        ${files.map((f, i) => this.renderFileItem(f, staged, indexOffset + i))}
      </ul>
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.file) return nothing;

    const { x, y, isStaged } = this.contextMenu;
    // Non-null past the early return above.
    const file = this.contextMenu.file;
    const extensionPattern = gitignoreExtensionPattern(file.path);
    // Untracked (and staged-new) paths are not in HEAD: both views would come
    // back empty or error, so the items stay visible — they are part of the
    // menu's vocabulary — but are marked unavailable and say why.
    const hasHistory = this.fileHasHistory(file);
    const canBlame = this.fileCanBlame(file);

    return html`
      <div class="context-menu" role="menu" aria-label="File actions" style="left: ${x}px; top: ${y}px"
        @keydown=${(e: KeyboardEvent) => this.handleContextMenuKeydown(e)}
      >
        ${isStaged
          ? html`
              <button
                class="context-menu-item"
                role="menuitem"
                @click=${this.handleContextUnstage}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Unstage
              </button>
            `
          : html`
              <button
                class="context-menu-item"
                role="menuitem"
                @click=${this.handleContextStage}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Stage
              </button>
            `}
        <button class="context-menu-item" role="menuitem" @click=${this.handleContextViewDiff}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 3v18M3 12h18"></path>
          </svg>
          View diff
        </button>
        <button
          class="context-menu-item ${hasHistory ? "" : "disabled"}"
          role="menuitem"
          aria-disabled=${hasHistory ? "false" : "true"}
          title=${hasHistory ? "Show every commit that touched this file (H)" : NO_HISTORY_REASON}
          @click=${this.handleContextViewHistory}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          File history
        </button>
        ${file.status !== "deleted"
          ? html`<button
              class="context-menu-item ${canBlame ? "" : "disabled"}"
              role="menuitem"
              aria-disabled=${canBlame ? "false" : "true"}
              title=${canBlame ? "Show who last changed each line (B)" : NO_HISTORY_REASON}
              @click=${this.handleContextViewBlame}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Blame
            </button>`
          : nothing}
        <button
          class="context-menu-item"
          role="menuitem"
          @click=${this.handleContextOpenInEditor}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
            ></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          Open in editor
        </button>
        ${file.status !== "deleted"
          ? html`<button
              class="context-menu-item"
              role="menuitem"
              @click=${this.handleContextRevealInFinder}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                ></path>
              </svg>
              ${navigator.userAgent.includes("Win")
                ? "Reveal in Explorer"
                : navigator.userAgent.includes("Linux")
                  ? "Reveal in File Manager"
                  : "Reveal in Finder"}
            </button>`
          : nothing}
        <button class="context-menu-item" role="menuitem" @click=${this.handleContextCopyPath}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path
              d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
            ></path>
          </svg>
          Copy file path
        </button>
        ${!isStaged && file.status === "untracked"
          ? html`
              <div class="context-menu-divider" role="separator"></div>
              <button
                class="context-menu-item"
                role="menuitem"
                @click=${() =>
                  this.handleContextIgnore(gitignorePatternForPath(file.path))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="4.9" y1="4.9" x2="19.1" y2="19.1"></line>
                </svg>
                Add to .gitignore
              </button>
              ${extensionPattern
                ? html`
                    <button
                      class="context-menu-item"
                      role="menuitem"
                      @click=${() => this.handleContextIgnore(extensionPattern)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                      >
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="4.9" y1="4.9" x2="19.1" y2="19.1"></line>
                      </svg>
                      Ignore all ${extensionPattern} files
                    </button>
                  `
                : nothing}
            `
          : nothing}
        ${isStaged
          ? nothing
          : html`
        <div class="context-menu-divider" role="separator"></div>
        <button
          class="context-menu-item danger"
          role="menuitem"
          @click=${this.handleContextDiscard}
          ?disabled=${this.discarding || isRefOpRunning(this.repositoryPath)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="3 6 5 6 21 6"></polyline>
            <path
              d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
            ></path>
          </svg>
          Discard changes
        </button>
        `}
      </div>
    `;
  }

  /**
   * The path filter. Rendered from its own method at a FIXED position in the
   * outer template so Lit keeps the same <input> element across every list
   * change — re-cloning it mid-render would drop focus on the keystroke that
   * emptied the list.
   */
  private renderFilterBar() {
    return html`
      <div class="filter-bar">
        <svg
          class="filter-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          class="filter-input"
          type="text"
          placeholder="Filter changed files..."
          aria-label="Filter changed files by path"
          .value=${this.filterQuery}
          @input=${this.handleFilterInput}
          @keydown=${this.handleFilterKeydown}
        />
        ${this.filterQuery
          ? html`
              <button
                class="filter-clear"
                aria-label="Clear filter"
                title="Clear filter (Esc)"
                @click=${() => this.clearFilter()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            `
          : nothing}
      </div>
    `;
  }

  /** Polite announcement of what the filter did, for screen readers. */
  private filterAnnouncement(matches: number, total: number): string {
    if (!this.isFiltering) return "";
    if (matches === 0) {
      return `No files match ${this.filterQuery.trim()}`;
    }
    return `${matches} of ${total} file${total === 1 ? "" : "s"} match ${this.filterQuery.trim()}`;
  }

  private renderNoMatches() {
    return html`
      <div class="no-match-state">
        <div>
          No files match
          <span class="no-match-query">${this.filterQuery.trim()}</span>
        </div>
        <button class="no-match-clear" @click=${() => this.clearFilter()}>
          Clear filter
        </button>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading changes...</div>`;
    }

    if (this.error) {
      return html`<div class="error">${this.error}</div>`;
    }

    if (this.stagedFiles.length === 0 && this.unstagedFiles.length === 0) {
      return html`
        <div class="clean-state">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div class="title">Working tree clean</div>
          <div class="subtitle">No changes to commit</div>
        </div>
      `;
    }

    // Everything below renders the FILTERED view. Building the trees from the
    // filtered lists is what keeps ancestor directories of a match (and only
    // those) in tree view: a directory exists in the tree only because a
    // matching file underneath put it there, so no empty folders appear.
    const staged = this.filteredStagedFiles;
    const unstaged = this.filteredUnstagedFiles;
    const filtering = this.isFiltering;
    const noMatches = filtering && staged.length === 0 && unstaged.length === 0;

    // The staged tree is needed twice below — once to render the staged rows,
    // once to count them for the unstaged section's index offset. Build it once.
    const stagedTree =
      this.viewMode === "tree" ? this.buildFileTree(staged) : undefined;

    return html`
      <!-- Toolbar -->
      <div class="toolbar">
        <button
          class="view-toggle ${this.viewMode === "tree" ? "active" : ""}"
          title="${this.viewMode === "tree"
            ? "Switch to flat view"
            : "Switch to tree view"}"
          @click=${() => this.toggleViewMode()}
        >
          ${this.viewMode === "tree"
            ? html`<svg viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                ></path>
              </svg>`
            : html`<svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>`}
          <span>${this.viewMode === "tree" ? "Tree" : "Flat"}</span>
        </button>
      </div>

      ${this.renderFilterBar()}

      <div class="visually-hidden" role="status" aria-live="polite">
        ${this.filterAnnouncement(
          staged.length + unstaged.length,
          this.stagedFiles.length + this.unstagedFiles.length,
        )}
      </div>

      ${noMatches ? this.renderNoMatches() : nothing}

      <!-- Staged changes -->
      <div class="section" ?hidden=${noMatches}>
        <div
          class="section-header"
          role="button"
          tabindex="0"
          aria-expanded=${this.stagedExpanded}
          aria-label=${filtering
            ? `Staged changes, ${staged.length} of ${this.stagedFiles.length} files match the filter`
            : `Staged changes, ${this.stagedFiles.length} files`}
          @click=${() => (this.stagedExpanded = !this.stagedExpanded)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.stagedExpanded = !this.stagedExpanded; } }}
        >
          <svg
            class="chevron ${this.stagedExpanded ? "expanded" : ""}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="section-title">Staged</span>
          <span
            class="section-count"
            title=${filtering
              ? `${staged.length} of ${this.stagedFiles.length} staged files match the filter`
              : `${this.stagedFiles.length} staged files`}
            >${filtering
              ? `${staged.length} of ${this.stagedFiles.length}`
              : this.stagedFiles.length}</span
          >
          ${staged.length > 0
            ? html`
                <div
                  class="section-actions"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  <button
                    class="section-action"
                    title=${filtering
                      ? `Unstage ${staged.length} file${staged.length === 1 ? "" : "s"} matching the filter`
                      : "Unstage all"}
                    aria-label=${filtering
                      ? `Unstage ${staged.length} file${staged.length === 1 ? "" : "s"} matching the filter`
                      : "Unstage all files"}
                    @click=${this.handleUnstageAllShown}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                </div>
              `
            : nothing}
        </div>
        ${this.stagedExpanded ? this.renderSelectionActions(true) : nothing}
        ${staged.length > 0 && this.stagedExpanded
          ? this.renderFileList(staged, true, 0, stagedTree)
          : nothing}
      </div>

      <!-- Unstaged changes -->
      <div class="section" ?hidden=${noMatches}>
        <div
          class="section-header"
          role="button"
          tabindex="0"
          aria-expanded=${this.unstagedExpanded}
          aria-label=${filtering
            ? `Unstaged changes, ${unstaged.length} of ${this.unstagedFiles.length} files match the filter`
            : `Unstaged changes, ${this.unstagedFiles.length} files`}
          @click=${() => (this.unstagedExpanded = !this.unstagedExpanded)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.unstagedExpanded = !this.unstagedExpanded; } }}
        >
          <svg
            class="chevron ${this.unstagedExpanded ? "expanded" : ""}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="section-title">Changes</span>
          <span
            class="section-count"
            title=${filtering
              ? `${unstaged.length} of ${this.unstagedFiles.length} changed files match the filter`
              : `${this.unstagedFiles.length} changed files`}
            >${filtering
              ? `${unstaged.length} of ${this.unstagedFiles.length}`
              : this.unstagedFiles.length}</span
          >
          ${unstaged.length > 0
            ? html`
                <div
                  class="section-actions"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  <button
                    class="section-action"
                    title=${filtering
                      ? `Stage ${unstaged.length} file${unstaged.length === 1 ? "" : "s"} matching the filter`
                      : "Stage all"}
                    aria-label=${filtering
                      ? `Stage ${unstaged.length} file${unstaged.length === 1 ? "" : "s"} matching the filter`
                      : "Stage all files"}
                    @click=${this.handleStageAllShown}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                </div>
              `
            : nothing}
        </div>
        ${this.unstagedExpanded ? this.renderSelectionActions(false) : nothing}
        ${unstaged.length > 0 && this.unstagedExpanded
          ? this.renderFileList(
              unstaged,
              false,
              this.stagedExpanded
                ? this.visibleFileCount(staged, stagedTree)
                : 0,
            )
          : nothing}
      </div>

      ${this.renderContextMenu()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lv-file-status": LvFileStatus;
  }
}
