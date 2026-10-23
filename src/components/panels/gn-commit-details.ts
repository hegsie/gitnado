/**
 * Commit Details Panel
 * Shows detailed information about a selected commit
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { parseIssueReferences, isClosingKeyword } from '../../services/git.service.ts';
import type { IssueReference } from '../../services/git.service.ts';
import type { Commit, RefInfo, CommitFileEntry, FileStatus } from '../../types/git.types.ts';
import type { GitNote } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { loggers, openExternalUrl } from '../../utils/index.ts';
import { restoreFileFromCommit } from '../../utils/restore-file.ts';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { join } from '@tauri-apps/api/path';

const log = loggers.ui;

/**
 * Ref git writes notes to unless told otherwise. `get_notes_refs` reports it
 * even when the ref does not exist yet, so it is always a valid write target.
 */
const DEFAULT_NOTES_REF = 'refs/notes/commits';

/** What a `notes-changed` event says happened to the commit's note. */
export type NotesChangeAction = 'added' | 'updated' | 'removed';

interface FileContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  file: CommitFileEntry | null;
}

@customElement('gn-commit-details')
export class GnCommitDetails extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .header {
        display: none; /* Hidden - using tabbed interface now */
        padding: 6px 12px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
      }

      .header-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0 6px 10px;
      }

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .section {
        margin-bottom: 8px;
        padding-right: 10px;
      }

      .section:last-child {
        margin-bottom: 0;
      }

      .section-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 4px;
      }

      .commit-message {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: 4px;
        line-height: 1.3;
      }

      .commit-body {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .commit-oid {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        display: inline-block;
        user-select: all;
      }

      .commit-sha-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .copy-sha-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .copy-sha-btn:hover {
        background: var(--color-primary);
        color: white;
        border-color: var(--color-primary);
      }

      .copy-sha-btn svg {
        width: 14px;
        height: 14px;
      }

      .meta-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin-bottom: 2px;
        font-size: var(--font-size-sm);
      }

      .meta-label {
        color: var(--color-text-muted);
        min-width: 80px;
        flex-shrink: 0;
      }

      .meta-value {
        color: var(--color-text-primary);
        word-break: break-word;
      }

      .refs {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .ref-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .ref-badge.local-branch {
        background: var(--color-success-bg, #dcfce7);
        color: var(--color-success, #16a34a);
      }

      .ref-badge.remote-branch {
        background: var(--color-info-bg, #dbeafe);
        color: var(--color-info, #2563eb);
      }

      .ref-badge.tag {
        background: var(--color-warning-bg, #fef3c7);
        color: var(--color-warning, #d97706);
      }

      /* A detached HEAD is not a branch, so it must not wear the branch
         colour — without a case of its own getRefClass returned '' and the
         badge rendered unstyled, indistinguishable from nothing at all. */
      .ref-badge.detached-head {
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
      }

      .ref-badge.head {
        border: 1px solid currentColor;
      }

      .ref-icon {
        width: 12px;
        height: 12px;
      }

      .parents {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .parent-oid {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        cursor: pointer;
      }

      .parent-oid:hover {
        color: var(--color-primary);
        text-decoration: underline;
      }

      .timestamp {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      /* File list styles */
      .file-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        margin: 0 -6px;
        cursor: default;
        font-size: var(--font-size-xs);
        border-radius: var(--radius-sm);
        min-height: 26px;
      }

      .file-item:hover {
        background: var(--color-bg-hover);
      }

      .file-item.selected {
        background: var(--color-primary-bg);
      }

      .file-status {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: var(--font-weight-bold);
        border-radius: 3px;
        flex-shrink: 0;
      }

      .file-status.new {
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

      .file-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-family-mono);
        font-size: 11px;
        direction: rtl;
        text-align: left;
      }

      .file-renamed-from {
        margin-left: var(--spacing-sm);
        color: var(--color-text-secondary);
        font-size: 10px;
        opacity: 0.85;
      }

      .file-stats {
        display: flex;
        gap: var(--spacing-sm);
        font-size: 12px;
        font-family: var(--font-family-mono);
      }

      .file-stats .additions {
        color: var(--color-success);
      }

      .file-stats .deletions {
        color: var(--color-error);
      }

      .file-actions {
        display: flex;
        gap: 4px;
        margin-left: auto;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .file-item:hover .file-actions {
        opacity: 1;
      }

      .file-action {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .file-action:hover {
        background: var(--color-primary);
        color: white;
        border-color: var(--color-primary);
      }

      .loading-files {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        font-style: italic;
      }

      /* Linked Issues */
      .linked-issues {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .issue-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
        text-decoration: none;
      }

      .issue-badge:hover {
        opacity: 0.8;
      }

      .issue-badge.closes {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .issue-badge.references {
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
      }

      .issue-badge .issue-icon {
        width: 12px;
        height: 12px;
      }

      /* Git Notes */
      .notes-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        margin-bottom: 4px;
      }

      .notes-header .section-title {
        margin-bottom: 0;
      }

      .notes-ref-select {
        max-width: 60%;
        padding: 1px var(--spacing-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        font-family: var(--font-family-mono);
        font-size: 10px;
        cursor: pointer;
      }

      .notes-ref-select:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .note-body {
        margin: 0;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .note-empty,
      .note-loading {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        font-style: italic;
      }

      .note-error {
        color: var(--color-error);
        font-size: var(--font-size-xs);
        margin-bottom: 4px;
        word-break: break-word;
      }

      .note-editor {
        width: 100%;
        box-sizing: border-box;
        min-height: 72px;
        resize: vertical;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
      }

      .note-editor:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .note-actions {
        display: flex;
        gap: var(--spacing-xs);
        margin-top: 4px;
      }

      .note-btn {
        padding: 2px var(--spacing-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .note-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .note-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .note-btn.primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .note-btn.primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .note-btn.danger {
        color: var(--color-error);
      }

      .notes-overview-toggle {
        margin-top: 6px;
        padding: 0;
        border: none;
        background: none;
        color: var(--color-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .notes-overview-toggle:hover {
        text-decoration: underline;
      }

      .notes-overview-list {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        max-height: 160px;
        overflow-y: auto;
      }

      .notes-overview-item {
        display: flex;
        gap: var(--spacing-sm);
        align-items: baseline;
        padding: 2px var(--spacing-xs);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--font-size-xs);
      }

      .notes-overview-item:hover {
        background: var(--color-bg-hover);
      }

      .notes-overview-item.current {
        background: var(--color-bg-tertiary);
      }

      .notes-overview-oid {
        font-family: var(--font-family-mono);
        color: var(--color-primary);
      }

      .notes-overview-text {
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';
  @property({ type: Object }) commit: Commit | null = null;
  @property({ type: Array }) refs: RefInfo[] = [];
  @property({ type: String }) githubOwner: string = '';
  @property({ type: String }) githubRepo: string = '';

  @state() private files: CommitFileEntry[] = [];
  @state() private loadingFiles = false;
  @state() private filesError: string | null = null;
  @state() private selectedFilePath: string | null = null;
  @state() private issueReferences: IssueReference[] = [];
  @state() private contextMenu: FileContextMenuState = { visible: false, x: 0, y: 0, file: null };

  // --- Git notes ---
  @state() private notesRefs: string[] = [DEFAULT_NOTES_REF];
  @state() private notesRef: string = DEFAULT_NOTES_REF;
  @state() private note: GitNote | null = null;
  @state() private loadingNote = false;
  /** Set when the note read itself failed, so we offer Retry instead of
   *  claiming — wrongly — that the commit has no note. */
  @state() private noteLoadFailed = false;
  @state() private noteError: string | null = null;
  @state() private editingNote = false;
  @state() private noteDraft = '';
  /**
   * Commit+ref keys with a note write (save or remove) in flight. Keyed
   * rather than a single flag: a write started against one commit must not
   * leave the *next* commit's controls looking busy just because the user
   * clicked away before it settled — only the write's own commit+ref is
   * disabled, so a double click on it still cannot issue two writes.
   */
  @state() private busyNoteKeys: Set<string> = new Set();
  @state() private allNotes: GitNote[] = [];
  @state() private notesOverviewError: string | null = null;
  @state() private showNotesOverview = false;

  private currentCommitOid: string | null = null;

  /**
   * Unsaved note text, keyed by ref + commit. Clicking another commit in the
   * graph swaps this panel's commit out from under an open editor, and the
   * click cannot be intercepted — so the draft is parked here and restored
   * when the user comes back, instead of being silently thrown away.
   */
  private noteDrafts: Map<string, string> = new Map();

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.handleDocumentClick);
    log.debug('connectedCallback - initial state:', {
      repositoryPath: this.repositoryPath,
      commitOid: this.commit?.oid,
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick);
  }

  updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);

    // Debug: log all property changes
    log.debug('updated called, changedProperties:', [...changedProperties.keys()]);
    log.debug('current state:', {
      repositoryPath: this.repositoryPath,
      commitOid: this.commit?.oid,
      currentCommitOid: this.currentCommitOid,
    });

    // A different repository means a different set of notes refs, so the
    // whole notes surface is rebuilt from scratch — otherwise the previous
    // repo's ref selection and overview would linger over the new one.
    const repositoryChanged =
      changedProperties.has('repositoryPath') && this.repositoryPath !== '';
    if (repositoryChanged) {
      // The file menu acts on the entry it was opened over but resolves the
      // repo from `this.repositoryPath` at click time. A keyboard tab switch
      // produces no document click, and the panel merely renders its empty
      // state while `commit` is null — so an armed menu would come back over
      // the NEW repo the moment a commit is selected, and Restore/Open would
      // join repo B's path with repo A's file.
      this.contextMenu = { ...this.contextMenu, visible: false };
      this.resetNotesState();
      this.refreshNotes();
    }

    // Load files when commit changes
    if (changedProperties.has('commit') && this.commit && this.repositoryPath) {
      if (this.commit.oid !== this.currentCommitOid) {
        log.debug('commit changed, loading files for:', this.commit.oid);
        this.stashNoteDraft();
        this.currentCommitOid = this.commit.oid;
        this.selectedFilePath = null;
        this.loadFiles();
        this.parseIssueRefs();
        // The refresh above already reloads the note for the new commit, so
        // only load it here when the repository stayed the same.
        if (!repositoryChanged) {
          this.resetNoteEditorState();
          this.loadNote();
        }
      }
    }
  }

  private parseIssueRefs(): void {
    if (!this.commit) {
      this.issueReferences = [];
      return;
    }

    // Parse from summary + body
    const fullMessage = this.commit.body
      ? `${this.commit.summary}\n\n${this.commit.body}`
      : this.commit.summary;

    this.issueReferences = parseIssueReferences(fullMessage);
  }

  private async loadFiles(): Promise<void> {
    if (!this.repositoryPath || !this.commit) {
      log.debug('loadFiles: missing repositoryPath or commit', { repositoryPath: this.repositoryPath, commit: this.commit?.oid });
      return;
    }

    log.debug('loadFiles: loading files for commit', this.commit.oid);
    this.loadingFiles = true;
    this.files = [];
    this.filesError = null;

    try {
      const result = await gitService.getCommitFiles(this.repositoryPath, this.commit.oid);
      log.debug('loadFiles: result', result);
      if (result.success && result.data) {
        this.files = result.data;
        log.debug('loadFiles: loaded', this.files.length, 'files');
      } else {
        console.error('loadFiles: failed', result.error);
        this.filesError = result.error?.message ?? 'Failed to load changed files';
      }
    } catch (err) {
      console.error('Failed to load commit files:', err);
      this.filesError = err instanceof Error ? err.message : 'Failed to load changed files';
    } finally {
      this.loadingFiles = false;
    }
  }


  // ---------------------------------------------------------------------------
  // Git notes
  //
  // Notes live in their own refs (refs/notes/*) and are invisible to the graph,
  // so a note write never triggers a repository refresh — the section reloads
  // only what it owns and reports the change with a `notes-changed` event.
  // ---------------------------------------------------------------------------

  private noteDraftKey(commitOid: string, notesRef: string): string {
    return `${notesRef}\u0000${commitOid}`;
  }

  /** Park the open editor's text under the commit it was written for. */
  private stashNoteDraft(): void {
    if (!this.editingNote || !this.currentCommitOid) return;
    const key = this.noteDraftKey(this.currentCommitOid, this.notesRef);
    // Nothing typed, or nothing changed: there is no work to preserve.
    if (this.noteDraft.trim() === '' || this.noteDraft === (this.note?.message ?? '')) {
      this.noteDrafts.delete(key);
    } else {
      this.noteDrafts.set(key, this.noteDraft);
    }
  }

  private clearNoteDraft(commitOid: string, notesRef: string): void {
    this.noteDrafts.delete(this.noteDraftKey(commitOid, notesRef));
  }

  /** Whether the commit+ref currently on screen — not necessarily the one a
   *  write was started against — has a write in flight. Every render and
   *  guard checks this instead of a single flag, so switching commit or ref
   *  while a write is still settling shows the new selection as idle. */
  private get noteBusy(): boolean {
    if (!this.commit) return false;
    return this.busyNoteKeys.has(this.noteDraftKey(this.commit.oid, this.notesRef));
  }

  private setNoteBusy(commitOid: string, notesRef: string, busy: boolean): void {
    const key = this.noteDraftKey(commitOid, notesRef);
    if (this.busyNoteKeys.has(key) === busy) return;
    const next = new Set(this.busyNoteKeys);
    if (busy) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.busyNoteKeys = next;
  }

  /** Drop every trace of the previous repository's notes. */
  private resetNotesState(): void {
    this.notesRefs = [DEFAULT_NOTES_REF];
    this.notesRef = DEFAULT_NOTES_REF;
    this.allNotes = [];
    this.notesOverviewError = null;
    this.showNotesOverview = false;
    this.noteDrafts.clear();
    // A commit+ref key is not unique across repositories, so a write left in
    // flight in the previous repo could otherwise be mistaken for one on the
    // new repo's identically-keyed commit.
    this.busyNoteKeys = new Set();
    this.resetNoteEditorState();
  }

  /** Clear the per-commit note view: a new commit starts with no editor open
   *  and no stale error from the commit before it. */
  private resetNoteEditorState(): void {
    this.note = null;
    this.noteError = null;
    this.noteLoadFailed = false;
    this.editingNote = false;
    this.noteDraft = '';
  }

  /** Reload the ref list first — the note read depends on which ref is
   *  selected, and a stale selection would read the wrong ref. */
  private async refreshNotes(): Promise<void> {
    await this.loadNotesRefs();
    await Promise.all([this.loadNote(), this.loadNotesOverview()]);
  }

  private async loadNotesRefs(): Promise<void> {
    if (!this.repositoryPath) return;
    const repoPath = this.repositoryPath;

    try {
      const result = await gitService.getNotesRefs(repoPath);
      if (repoPath !== this.repositoryPath) return;

      if (result.success && result.data && result.data.length > 0) {
        this.notesRefs = result.data;
        // A ref can disappear when its last note is removed; fall back to the
        // first one left rather than reading from a ref that no longer exists.
        if (!this.notesRefs.includes(this.notesRef)) {
          this.notesRef = this.notesRefs[0];
        }
      } else {
        // Not fatal on its own — the default ref is always a valid write
        // target, and a real backend failure surfaces on the note read.
        this.notesRefs = [DEFAULT_NOTES_REF];
        this.notesRef = DEFAULT_NOTES_REF;
      }
    } catch (err) {
      console.error('Failed to load notes refs:', err);
      this.notesRefs = [DEFAULT_NOTES_REF];
      this.notesRef = DEFAULT_NOTES_REF;
    }
  }

  private async loadNote(): Promise<void> {
    if (!this.repositoryPath || !this.commit) return;

    const repoPath = this.repositoryPath;
    const commitOid = this.commit.oid;
    const notesRef = this.notesRef;
    const isStale = (): boolean =>
      repoPath !== this.repositoryPath ||
      commitOid !== this.commit?.oid ||
      notesRef !== this.notesRef;

    this.loadingNote = true;
    this.noteLoadFailed = false;
    this.noteError = null;

    try {
      const result = await gitService.getNote(repoPath, commitOid, notesRef);
      if (isStale()) return;

      if (result.success) {
        this.note = result.data ?? null;
        this.restoreNoteDraft(commitOid, notesRef);
      } else {
        this.note = null;
        this.noteLoadFailed = true;
        this.noteError = result.error?.message ?? 'Failed to load note';
      }
    } catch (err) {
      console.error('Failed to load note:', err);
      if (isStale()) return;
      this.note = null;
      this.noteLoadFailed = true;
      this.noteError = err instanceof Error ? err.message : 'Failed to load note';
    } finally {
      if (!isStale()) {
        this.loadingNote = false;
      }
    }
  }

  /** Reopen the editor on the text the user left here earlier. */
  private restoreNoteDraft(commitOid: string, notesRef: string): void {
    const draft = this.noteDrafts.get(this.noteDraftKey(commitOid, notesRef));
    if (draft === undefined) return;
    this.noteDraft = draft;
    this.editingNote = true;
  }

  /**
   * Bulk-load every note in the selected ref. It backs the "show all notes"
   * list — the only way to find annotated commits without visiting them one by
   * one — and its length is the note count shown next to the toggle.
   */
  private async loadNotesOverview(): Promise<void> {
    if (!this.repositoryPath) {
      this.allNotes = [];
      return;
    }

    const repoPath = this.repositoryPath;
    const notesRef = this.notesRef;
    const isStale = (): boolean =>
      repoPath !== this.repositoryPath || notesRef !== this.notesRef;

    this.notesOverviewError = null;

    try {
      const result = await gitService.getNotes(repoPath, notesRef);
      if (isStale()) return;

      if (result.success) {
        this.allNotes = result.data ?? [];
      } else {
        this.allNotes = [];
        this.notesOverviewError = result.error?.message ?? 'Failed to load notes';
      }
    } catch (err) {
      console.error('Failed to load notes:', err);
      if (isStale()) return;
      this.allNotes = [];
      this.notesOverviewError = err instanceof Error ? err.message : 'Failed to load notes';
    }
  }

  private emitNotesChanged(action: NotesChangeAction, commitOid: string, notesRef: string): void {
    this.dispatchEvent(
      new CustomEvent('notes-changed', {
        detail: { action, commitOid, notesRef },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleNotesRefChange(e: Event): void {
    const notesRef = (e.target as HTMLSelectElement).value;
    if (notesRef === this.notesRef) return;
    this.stashNoteDraft();
    this.notesRef = notesRef;
    this.resetNoteEditorState();
    this.showNotesOverview = false;
    this.loadNote();
    this.loadNotesOverview();
  }

  private async handleAddNote(): Promise<void> {
    this.noteDraft = '';
    this.noteError = null;
    this.editingNote = true;
    await this.focusNoteEditor();
  }

  private async handleEditNote(): Promise<void> {
    this.noteDraft = this.note?.message ?? '';
    this.noteError = null;
    this.editingNote = true;
    await this.focusNoteEditor();
  }

  private async focusNoteEditor(): Promise<void> {
    await this.updateComplete;
    const editor = this.shadowRoot?.querySelector<HTMLTextAreaElement>('.note-editor');
    editor?.focus();
  }

  private handleNoteDraftInput(e: Event): void {
    this.noteDraft = (e.target as HTMLTextAreaElement).value;
  }

  /** Escape closes the whole diff/details surface app-wide and gets pressed
   *  reflexively, so unsaved note text is confirmed away, never dropped. */
  private async handleCancelNoteEdit(): Promise<void> {
    const original = this.note?.message ?? '';
    if (this.noteDraft !== original) {
      const confirmed = await showConfirm(
        'Discard note edits?',
        'The changes to this note have not been saved.',
        'warning'
      );
      if (!confirmed) return;
    }
    this.editingNote = false;
    this.noteDraft = '';
    this.noteError = null;
    if (this.commit) {
      this.clearNoteDraft(this.commit.oid, this.notesRef);
    }
  }

  private async handleSaveNote(): Promise<void> {
    if (!this.repositoryPath || !this.commit || this.noteBusy) return;

    const message = this.noteDraft.trim();
    if (!message) {
      this.noteError = 'A note cannot be empty';
      return;
    }

    const repoPath = this.repositoryPath;
    const commitOid = this.commit.oid;
    const notesRef = this.notesRef;
    const wasExisting = this.note !== null;
    // A click in the graph swaps the panel's commit out from under a slow
    // write, so the response may no longer describe what is on screen.
    const isStale = (): boolean =>
      repoPath !== this.repositoryPath ||
      commitOid !== this.commit?.oid ||
      notesRef !== this.notesRef;

    this.setNoteBusy(commitOid, notesRef, true);
    this.noteError = null;

    try {
      // force: overwriting is the point of the Edit button, and git2 refuses
      // to replace an existing note without it.
      const result = await gitService.setNote(repoPath, commitOid, message, notesRef, true);

      if (result.success && result.data) {
        // The write landed on `commitOid`, so its parked draft is spent and
        // the change is worth announcing whatever the panel shows now.
        this.clearNoteDraft(commitOid, notesRef);
        this.emitNotesChanged(wasExisting ? 'updated' : 'added', commitOid, notesRef);
        // The view, though, is commit-scoped: adopting this note after the
        // user moved on would show one commit's note under another and aim
        // Remove at the wrong commit.
        if (!isStale()) {
          this.note = result.data;
          this.noteLoadFailed = false;
          this.editingNote = false;
          this.noteDraft = '';
        }
        // The first note in a ref creates that ref, so the selector list can
        // have grown; the overview count changed either way. Re-reading the
        // note as well keeps the panel showing what the repository actually
        // holds rather than what we asked it to hold. It reads whatever is
        // selected now, so it is correct on the stale path too.
        this.refreshNotes();
      } else if (!isStale()) {
        // Keep the editor open so the typed note survives the failure.
        this.noteError = result.error?.message ?? 'Failed to save note';
      }
    } catch (err) {
      console.error('Failed to save note:', err);
      if (isStale()) return;
      this.noteError = err instanceof Error ? err.message : 'Failed to save note';
    } finally {
      this.setNoteBusy(commitOid, notesRef, false);
    }
  }

  private async handleRemoveNote(): Promise<void> {
    if (!this.repositoryPath || !this.commit || !this.note || this.noteBusy) return;

    const repoPath = this.repositoryPath;
    const commitOid = this.commit.oid;
    const notesRef = this.notesRef;
    const isStale = (): boolean =>
      repoPath !== this.repositoryPath ||
      commitOid !== this.commit?.oid ||
      notesRef !== this.notesRef;

    // Claimed before the confirm, not after: showConfirm is an IPC round trip,
    // so a claim taken afterwards would not serialize a double click.
    this.setNoteBusy(commitOid, notesRef, true);
    this.noteError = null;

    try {
      const confirmed = await showConfirm(
        'Remove note?',
        `The note on ${commitOid.substring(0, 7)} will be deleted from ${notesRef}.`,
        'warning'
      );
      if (!confirmed) return;

      const result = await gitService.removeNote(repoPath, commitOid, notesRef);

      if (result.success) {
        this.clearNoteDraft(commitOid, notesRef);
        this.emitNotesChanged('removed', commitOid, notesRef);
        // Same commit-scoped view as the save path: the removal happened on
        // `commitOid`, so it may not clear the note of whatever is shown now.
        if (!isStale()) {
          this.note = null;
          this.noteLoadFailed = false;
          this.editingNote = false;
          this.noteDraft = '';
        }
        // Removing the last note in a ref removes the ref itself, so the
        // selection can land on a different ref — reload all of it, not just
        // the list, or the panel would describe the ref that just vanished.
        this.refreshNotes();
      } else if (!isStale()) {
        this.noteError = result.error?.message ?? 'Failed to remove note';
      }
    } catch (err) {
      console.error('Failed to remove note:', err);
      if (isStale()) return;
      this.noteError = err instanceof Error ? err.message : 'Failed to remove note';
    } finally {
      this.setNoteBusy(commitOid, notesRef, false);
    }
  }

  private handleRetryLoadNote(): void {
    this.loadNote();
    this.loadNotesOverview();
  }

  private toggleNotesOverview(): void {
    this.showNotesOverview = !this.showNotesOverview;
  }

  private handleNotesOverviewSelect(commitOid: string): void {
    if (commitOid === this.commit?.oid) return;
    this.dispatchEvent(
      new CustomEvent('show-commit', {
        detail: { oid: commitOid },
        bubbles: true,
        composed: true,
      })
    );
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp * 1000;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 30) {
      return this.formatDate(timestamp);
    } else if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
      return 'just now';
    }
  }

  private handleParentClick(oid: string): void {
    this.dispatchEvent(
      new CustomEvent('select-commit', {
        detail: { oid },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleFileClick(file: CommitFileEntry): void {
    this.selectedFilePath = file.path;
    this.dispatchEvent(
      new CustomEvent('commit-file-selected', {
        detail: {
          commitOid: this.commit?.oid,
          filePath: file.path,
          status: file.status,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleBlameClick(file: CommitFileEntry, e: Event): void {
    e.stopPropagation();
    // Don't show blame for deleted files
    if (file.status === 'deleted') return;

    this.dispatchEvent(
      new CustomEvent('show-blame', {
        detail: {
          filePath: file.path,
          commitOid: this.commit?.oid,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleHistoryClick(file: CommitFileEntry, e: Event): void {
    e.stopPropagation();

    this.dispatchEvent(
      new CustomEvent('show-file-history', {
        detail: {
          filePath: file.path,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleIssueClick(issueNumber: number): void {
    if (!this.githubOwner || !this.githubRepo) return;

    const url = `https://github.com/${this.githubOwner}/${this.githubRepo}/issues/${issueNumber}`;
    openExternalUrl(url);
  }

  private async copyFullSha(): Promise<void> {
    if (!this.commit) return;
    try {
      await navigator.clipboard.writeText(this.commit.oid);
      // Dispatch toast event
      this.dispatchEvent(
        new CustomEvent('copy-sha', {
          detail: { sha: this.commit.oid.substring(0, 7) },
          bubbles: true,
          composed: true,
        })
      );
    } catch (err) {
      console.error('Failed to copy SHA:', err);
      showToast('Failed to copy SHA to clipboard', 'error');
    }
  }

  // Context menu handlers
  private handleFileContextMenu(e: MouseEvent, file: CommitFileEntry): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, file };
  }

  private handleContextViewDiff(): void {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.handleFileClick(file);
  }

  private handleContextViewBlame(): void {
    const file = this.contextMenu.file;
    if (!file || file.status === 'deleted') return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('show-blame', {
      detail: { filePath: file.path, commitOid: this.commit?.oid },
      bubbles: true,
      composed: true,
    }));
  }

  private handleContextViewHistory(): void {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('show-file-history', {
      detail: { filePath: file.path },
      bubbles: true,
      composed: true,
    }));
  }

  private async handleContextRestoreFile(): Promise<void> {
    const file = this.contextMenu.file;
    const commit = this.commit;
    // A file the commit DELETED is not in its tree, so find_blob_in_commit
    // would fail. The menu hides the item for those; this guards the handler.
    if (!file || !commit || !this.repositoryPath || file.status === 'deleted') return;
    // Closed synchronously, like every sibling: the confirm is an IPC round
    // trip, and a menu left on screen through it takes a second click.
    this.contextMenu = { ...this.contextMenu, visible: false };
    await restoreFileFromCommit(this.repositoryPath, file.path, commit.oid, commit.shortId);
  }

  private async handleContextOpenInEditor(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file || file.status === 'deleted') return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      const fullPath = await join(this.repositoryPath, file.path);
      await shellOpen(fullPath);
    } catch (err) {
      console.error('Failed to open file:', err);
      showToast('Failed to open file in editor', 'error');
    }
  }

  private async handleContextCopyPath(): Promise<void> {
    const file = this.contextMenu.file;
    if (!file) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(file.path);
    } catch (err) {
      console.error('Failed to copy path:', err);
      showToast('Failed to copy path to clipboard', 'error');
    }
  }

  private renderLinkedIssues() {
    if (this.issueReferences.length === 0) return nothing;
    if (!this.githubOwner || !this.githubRepo) return nothing;

    return html`
      <div class="section">
        <div class="section-title">Linked Issues</div>
        <div class="linked-issues">
          ${this.issueReferences.map(ref => {
            const closes = isClosingKeyword(ref.keyword);
            return html`
              <span
                class="issue-badge ${closes ? 'closes' : 'references'}"
                @click=${() => this.handleIssueClick(ref.number)}
                title="${closes ? `Closes issue #${ref.number}` : `References issue #${ref.number}`}"
              >
                <svg class="issue-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                #${ref.number}
                ${closes ? html`<span style="font-size: 10px; opacity: 0.8;">(closes)</span>` : ''}
              </span>
            `;
          })}
        </div>
      </div>
    `;
  }

  private getRefClass(refType: string): string {
    switch (refType) {
      case 'localBranch':
        return 'local-branch';
      case 'remoteBranch':
        return 'remote-branch';
      case 'tag':
        return 'tag';
      case 'detachedHead':
        return 'detached-head';
      default:
        return '';
    }
  }

  private getStatusLabel(status: FileStatus): string {
    const labels: Record<FileStatus, string> = {
      new: 'A',
      modified: 'M',
      deleted: 'D',
      renamed: 'R',
      copied: 'C',
      ignored: 'I',
      untracked: '?',
      typechange: 'T',
      conflicted: '!',
    };
    return labels[status] || '?';
  }

  private renderFileItem(file: CommitFileEntry) {
    const filename = file.path.split('/').pop() || file.path;
    const canBlame = file.status !== 'deleted';
    // For a rename/copy, show where the file came from (git shows "old -> new").
    const renamedFrom =
      (file.status === 'renamed' || file.status === 'copied') && file.oldPath
        ? file.oldPath
        : null;

    return html`
      <li
        class="file-item ${this.selectedFilePath === file.path ? 'selected' : ''}"
        @click=${() => this.handleFileClick(file)}
        @contextmenu=${(e: MouseEvent) => this.handleFileContextMenu(e, file)}
        title="${renamedFrom ? `${renamedFrom} → ${file.path}` : file.path}"
      >
        <span class="file-status ${file.status}">${this.getStatusLabel(file.status)}</span>
        <span class="file-name">
          ${filename}
          ${renamedFrom
            ? html`<span class="file-renamed-from">from ${renamedFrom}</span>`
            : nothing}
        </span>
        <span class="file-stats">
          ${file.additions > 0 ? html`<span class="additions">+${file.additions}</span>` : nothing}
          ${file.deletions > 0 ? html`<span class="deletions">-${file.deletions}</span>` : nothing}
        </span>
        <div class="file-actions">
          <button
            class="file-action"
            title="View file history"
            @click=${(e: Event) => this.handleHistoryClick(file, e)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </button>
          ${canBlame ? html`
            <button
              class="file-action"
              title="View file blame"
              @click=${(e: Event) => this.handleBlameClick(file, e)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          ` : nothing}
        </div>
      </li>
    `;
  }

  private renderNoteBody() {
    if (this.editingNote) {
      const original = this.note?.message ?? '';
      return html`
        <textarea
          class="note-editor"
          .value=${this.noteDraft}
          ?disabled=${this.noteBusy}
          placeholder="Write a note for this commit…"
          aria-label="Commit note"
          @input=${this.handleNoteDraftInput}
        ></textarea>
        <div class="note-actions">
          <button
            class="note-btn primary"
            ?disabled=${this.noteBusy || this.noteDraft.trim() === '' || this.noteDraft === original}
            @click=${this.handleSaveNote}
          >
            ${this.noteBusy ? 'Saving…' : 'Save note'}
          </button>
          <button class="note-btn" ?disabled=${this.noteBusy} @click=${this.handleCancelNoteEdit}>
            Cancel
          </button>
        </div>
      `;
    }

    if (this.loadingNote) {
      return html`<div class="note-loading">Loading note…</div>`;
    }

    if (this.noteLoadFailed) {
      return html`
        <div class="note-actions">
          <button class="note-btn" @click=${this.handleRetryLoadNote}>Retry</button>
        </div>
      `;
    }

    if (this.note) {
      return html`
        <pre class="note-body">${this.note.message}</pre>
        <div class="note-actions">
          <button class="note-btn" ?disabled=${this.noteBusy} @click=${this.handleEditNote}>
            Edit
          </button>
          <button class="note-btn danger" ?disabled=${this.noteBusy} @click=${this.handleRemoveNote}>
            ${this.noteBusy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      `;
    }

    return html`
      <div class="note-empty">No note on this commit in ${this.notesRef}</div>
      <div class="note-actions">
        <button class="note-btn primary" ?disabled=${this.noteBusy} @click=${this.handleAddNote}>
          Add note
        </button>
      </div>
    `;
  }

  private renderNotesOverview() {
    if (this.notesOverviewError) {
      return html`<div class="note-error" role="alert">${this.notesOverviewError}</div>`;
    }

    const count = this.allNotes.length;
    if (count === 0) return nothing;

    return html`
      <button
        class="notes-overview-toggle"
        aria-expanded=${this.showNotesOverview ? 'true' : 'false'}
        @click=${this.toggleNotesOverview}
      >
        ${this.showNotesOverview ? 'Hide' : 'Show'} all ${count} note${count === 1 ? '' : 's'} in this ref
      </button>
      ${this.showNotesOverview
        ? html`
            <ul class="notes-overview-list">
              ${this.allNotes.map(
                (n) => html`
                  <li
                    class="notes-overview-item ${n.commitOid === this.commit?.oid ? 'current' : ''}"
                    title=${n.message}
                    @click=${() => this.handleNotesOverviewSelect(n.commitOid)}
                  >
                    <span class="notes-overview-oid">${n.commitOid.substring(0, 7)}</span>
                    <span class="notes-overview-text">${n.message.split('\n')[0]}</span>
                  </li>
                `
              )}
            </ul>
          `
        : nothing}
    `;
  }

  private renderNotesSection() {
    return html`
      <div class="section notes-section">
        <div class="notes-header">
          <div class="section-title">Notes</div>
          <select
            class="notes-ref-select"
            aria-label="Notes ref"
            title="Notes ref"
            ?disabled=${this.noteBusy || this.editingNote}
            @change=${this.handleNotesRefChange}
          >
            ${this.notesRefs.map(
              (ref) => html`<option value=${ref} ?selected=${ref === this.notesRef}>${ref}</option>`
            )}
          </select>
        </div>
        ${this.noteError ? html`<div class="note-error" role="alert">${this.noteError}</div>` : nothing}
        ${this.renderNoteBody()}
        ${this.renderNotesOverview()}
      </div>
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.file) return nothing;

    const { x, y, file } = this.contextMenu;
    const canBlame = file.status !== 'deleted';
    const canOpen = file.status !== 'deleted';
    // Restoring needs the blob to exist in THIS commit's tree, which it does
    // not for a file the commit deleted.
    const canRestore = file.status !== 'deleted' && !!this.commit;

    return html`
      <div class="context-menu" style="left: ${x}px; top: ${y}px">
        <button class="context-menu-item" @click=${this.handleContextViewDiff}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v18M3 12h18"></path>
          </svg>
          View diff
        </button>
        ${canBlame ? html`
          <button class="context-menu-item" @click=${this.handleContextViewBlame}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            View blame
          </button>
        ` : nothing}
        <button class="context-menu-item" @click=${this.handleContextViewHistory}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          View history
        </button>
        ${canRestore ? html`
          <button class="context-menu-item" @click=${this.handleContextRestoreFile}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
              <polyline points="3 3 3 8 8 8"></polyline>
            </svg>
            Restore this version
          </button>
        ` : nothing}
        <div class="context-menu-divider"></div>
        ${canOpen ? html`
          <button class="context-menu-item" @click=${this.handleContextOpenInEditor}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            Open current version
          </button>
        ` : nothing}
        <button class="context-menu-item" @click=${this.handleContextCopyPath}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy file path
        </button>
      </div>
    `;
  }

  render() {
    if (!this.commit) {
      return html`
        <div class="header">
          <span class="header-title">Commit Details</span>
        </div>
        <div class="empty-state">Select a commit to view details</div>
      `;
    }

    return html`
      <div class="header">
        <span class="header-title">Commit Details</span>
      </div>

      <div class="content">
        <div class="section">
          <div class="commit-message">${this.commit.summary}</div>
          ${this.commit.body
            ? html`<div class="commit-body">${this.commit.body}</div>`
            : ''}
        </div>

        ${this.refs.length > 0
          ? html`
              <div class="section">
                <div class="section-title">Refs</div>
                <div class="refs">
                  ${this.refs.map(
                    (ref) => html`
                      <span class="ref-badge ${this.getRefClass(ref.refType)} ${ref.isHead ? 'head' : ''}">
                        ${ref.refType === 'tag'
                          ? html`<svg class="ref-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                              <line x1="7" y1="7" x2="7.01" y2="7"></line>
                            </svg>`
                          : html`<svg class="ref-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="6" y1="3" x2="6" y2="15"></line>
                              <circle cx="18" cy="6" r="3"></circle>
                              <circle cx="6" cy="18" r="3"></circle>
                              <path d="M18 9a9 9 0 0 1-9 9"></path>
                            </svg>`}
                        ${ref.shorthand}
                      </span>
                    `
                  )}
                </div>
              </div>
            `
          : ''}

        ${this.renderLinkedIssues()}

        <div class="section">
          <div class="section-title">Files Changed (${this.files.length})</div>
          ${this.loadingFiles
            ? html`<div class="loading-files">Loading files...</div>`
            : this.filesError
              ? html`<div class="loading-files files-error">${this.filesError}</div>`
              : this.files.length > 0
                ? html`
                    <ul class="file-list">
                      ${this.files.map((f) => this.renderFileItem(f))}
                    </ul>
                  `
                : html`<div class="loading-files">No files changed</div>`}
        </div>

        ${this.renderNotesSection()}

        <div class="section">
          <div class="section-title">SHA</div>
          <div class="commit-sha-row">
            <code class="commit-oid">${this.commit.oid.slice(0, 7)}</code>
            <button
              class="copy-sha-btn"
              @click=${this.copyFullSha}
              title="Copy full SHA (${this.commit.oid})"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
              </svg>
            </button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Author</div>
          <div class="meta-row">
            <span class="meta-value">${this.commit.author.name}</span>
          </div>
          <div class="meta-row">
            <span class="meta-value" style="color: var(--color-text-muted);">
              &lt;${this.commit.author.email}&gt;
            </span>
          </div>
          <div class="timestamp">
            ${this.formatRelativeTime(this.commit.author.timestamp)} &bull;
            ${this.formatDate(this.commit.author.timestamp)}
          </div>
        </div>

        ${this.commit.committer.email !== this.commit.author.email
          ? html`
              <div class="section">
                <div class="section-title">Committer</div>
                <div class="meta-row">
                  <span class="meta-value">${this.commit.committer.name}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-value" style="color: var(--color-text-muted);">
                    &lt;${this.commit.committer.email}&gt;
                  </span>
                </div>
              </div>
            `
          : ''}

        ${this.commit.parentIds.length > 0
          ? html`
              <div class="section">
                <div class="section-title">
                  Parent${this.commit.parentIds.length > 1 ? 's' : ''}
                </div>
                <div class="parents">
                  ${this.commit.parentIds.map(
                    (oid) => html`
                      <code
                        class="parent-oid"
                        @click=${() => this.handleParentClick(oid)}
                      >
                        ${oid.substring(0, 7)}
                      </code>
                    `
                  )}
                </div>
              </div>
            `
          : ''}
      </div>

      ${this.renderContextMenu()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-commit-details': GnCommitDetails;
  }
}
