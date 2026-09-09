/**
 * Export / Import Dialog Component
 *
 * The archive, patch and bundle commands were fully implemented in the
 * backend and fully wrapped in git.service.ts, but nothing in the UI ever
 * called them: no dialog, no context-menu item, no palette entry. A user
 * could not export an archive, produce or apply a patch, or create/verify/
 * import a bundle at all. This dialog is the missing surface, and it is one
 * dialog rather than three because the three flows share the same shape —
 * pick a ref/commit/file, pick a destination, run one command — and because a
 * single instance keeps the tab-close sweep and the working-tree lock in one
 * place instead of three.
 */

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type { BundleRef, BundleVerifyResult } from '../../services/git.service.ts';
import { openDialog, saveDialog } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { Branch, Commit } from '../../types/git.types.ts';
import './lv-modal.ts';
import type { LvModal } from './lv-modal.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  warnRepositoryBusy,
  RefLockController,
} from '../../utils/ref-lock.ts';

export type ExportImportTab = 'archive' | 'patch' | 'bundle';
export type PatchMode = 'create' | 'apply';
export type BundleMode = 'create' | 'import';
type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';
type PatchTarget = 'worktree' | 'index';

export interface ExportImportOpenOptions {
  tab?: ExportImportTab;
  patchMode?: PatchMode;
  bundleMode?: BundleMode;
  /** Pre-select this ref on the Archive tab (from the graph ref menu). */
  ref?: string;
  /** Pre-check this commit on the Patch tab (from the commit menu). */
  commitOid?: string;
  /**
   * Pre-check a whole set on the Patch tab (from the graph's multi-selection
   * menu). Deep-linked exactly like `commitOid`: each row is pinned visible so
   * the filter and the row cap cannot hide a commit the dialog says is ticked.
   */
  commitOids?: string[];
}

/** How many rows of a potentially huge list are rendered at once. */
const MAX_ROWS = 200;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'repository';
}

/** Make a ref safe to drop into a suggested filename. */
function sanitizeForFilename(ref: string): string {
  return ref.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'HEAD';
}

@customElement('lv-export-import-dialog')
export class LvExportImportDialog extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .tabs {
        display: flex;
        border-bottom: 1px solid var(--color-border);
        gap: 0;
        margin-bottom: var(--spacing-md);
      }

      .tab {
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        border-bottom: 2px solid transparent;
      }

      .tab:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .tab.active {
        color: var(--color-primary);
        border-bottom-color: var(--color-primary);
      }

      .body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: 520px;
        max-width: 620px;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .field label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .field select,
      .field input[type='text'] {
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
      }

      .row {
        display: flex;
        gap: var(--spacing-md);
        align-items: flex-end;
      }

      .row > .field {
        flex: 1;
      }

      .list {
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
      }

      .list-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: 4px var(--spacing-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .list-row.pinned {
        background: var(--color-bg-tertiary);
      }

      .mono {
        font-family: var(--font-family-mono, monospace);
        color: var(--color-text-secondary);
      }

      .truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .error {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-md);
        color: var(--color-error);
        font-size: var(--font-size-sm);
        word-break: break-word;
      }

      .warning {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-warning-bg, var(--color-bg-tertiary));
        border: 1px solid var(--color-warning, var(--color-border));
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        word-break: break-word;
      }

      .radio-row {
        display: flex;
        gap: var(--spacing-lg);
      }

      .radio-row label,
      .check-row label {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        cursor: pointer;
      }

      .check-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .chosen-file {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        word-break: break-all;
      }

      .empty {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  /** Bound live to the active tab — never used for IPC, see pinnedRepoPath. */
  @property({ type: String }) repositoryPath = '';
  @property({ type: String }) graphRepositoryPath = '';
  @property({ attribute: false }) branches: Branch[] = [];
  private pinnedBranches: Branch[] = [];
  private pinnedTags: Array<{ name: string; oid: string }> = [];
  private pinnedCommits: Commit[] = [];
  @property({ attribute: false }) tags: Array<{ name: string; oid: string }> = [];
  @property({ attribute: false }) commits: Commit[] = [];

  /**
   * The repo this dialog was opened for, captured at open(). `repositoryPath`
   * follows the active tab, so a tab switch behind the open modal would
   * otherwise make Apply/Import land in the wrong repository.
   */
  private pinnedRepoPath = '';
  private isOpen = false;

  /** The pinned repo while open, else null — lets the host sweep close this
   * dialog when that repo's tab goes away. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /** The one flag dismiss()/handleModalClose() refuse on, so the host sweep
   * can never announce a cancellation that did not happen. */
  public get operationInFlight(): boolean {
    return this.operationRunning;
  }

  /** Observe the shared working-tree lock so Apply/Import go grey while
   * another surface holds it, instead of staying lit and only toasting. */
  private lock = new RefLockController(this, () => this.pinnedRepoPath || this.repositoryPath);

  @state() private tab: ExportImportTab = 'archive';
  @state() private operationRunning = false;
  @state() private error = '';

  // ── Archive ──────────────────────────────────────────────────────────────
  @state() private archiveRef = 'HEAD';
  @state() private archiveFormat: ArchiveFormat = 'zip';
  @state() private archivePrefix = '';
  @state() private previewFiles: string[] = [];
  @state() private previewLoading = false;
  /** A deep-linked ref that is not in branches/tags (a detached or filtered
   * ref) still has to appear in the select, or the deep link would silently
   * fall back to HEAD and export the wrong tree. */
  @state() private extraRef = '';

  // ── Patch ────────────────────────────────────────────────────────────────
  @state() private patchMode: PatchMode = 'create';
  @state() private commitFilter = '';
  @state() private selectedCommits: ReadonlySet<string> = new Set<string>();
  /** Deep-linked commits, kept visible even when the filter or the row cap
   * would otherwise hide the rows the user just right-clicked. */
  @state() private pinnedCommitOids: ReadonlySet<string> = new Set<string>();
  @state() private patchFile = '';
  @state() private patchTarget: PatchTarget = 'worktree';

  // ── Bundle ───────────────────────────────────────────────────────────────
  @state() private bundleMode: BundleMode = 'create';
  @state() private bundleAllRefs = true;
  @state() private selectedRefs: ReadonlySet<string> = new Set<string>();
  @state() private bundleFile = '';
  @state() private bundleHeads: BundleRef[] = [];
  @state() private bundleVerifyResult: BundleVerifyResult | null = null;
  @state() private bundleInspecting = false;
  /** Bumped for every bundle inspection. A slow answer for the file that was
   * chosen first must not land on the file that is chosen now, or a stale
   * `isValid` would enable Import for a bundle nobody verified. */
  private bundleInspectSeq = 0;

  @query('lv-modal') private modal!: LvModal;

  public open(opts: ExportImportOpenOptions = {}): void {
    // An operation already owns this component; reset() would clear
    // `operationRunning` and re-enable the action button for a second
    // concurrent run against the same working tree.
    if (this.operationRunning) return;

    // Re-entering must NOT reset. Several entry points converge on this one
    // instance (two context menus, five palette entries), and Ctrl+P fires
    // even while the user is typing in this dialog — so re-opening would wipe
    // a chosen patch file or a half-built commit selection.
    if (this.isOpen) {
      this.applyOptions(opts);
      return;
    }

    this.reset();
    this.pinnedRepoPath = this.repositoryPath;
    this.pinnedBranches = [...this.branches];
    this.pinnedTags =
      this.graphRepositoryPath === this.repositoryPath ? [...this.tags] : [];
    this.pinnedCommits =
      this.graphRepositoryPath === this.repositoryPath ? [...this.commits] : [];
    this.isOpen = true;
    this.applyOptions(opts);

    // Reveal only AFTER the reset above has rendered, and only while still
    // open, so a close() landing in this window cannot be undone.
    void this.updateComplete.then(() => {
      if (!this.isOpen) return;
      this.modal.open = true;
    });
  }

  private get scopedBranches(): Branch[] {
    return this.repositoryPath === this.pinnedRepoPath ? this.branches : this.pinnedBranches;
  }

  private get scopedTags(): Array<{ name: string; oid: string }> {
    return this.graphRepositoryPath === this.pinnedRepoPath ? this.tags : this.pinnedTags;
  }

  private get scopedCommits(): Commit[] {
    return this.graphRepositoryPath === this.pinnedRepoPath ? this.commits : this.pinnedCommits;
  }

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    if (!this.isOpen) return;
    if (this.repositoryPath === this.pinnedRepoPath && changedProperties.has('branches')) {
      this.pinnedBranches = [...this.branches];
    }
    if (this.graphRepositoryPath === this.pinnedRepoPath) {
      if (changedProperties.has('tags')) this.pinnedTags = [...this.tags];
      if (changedProperties.has('commits')) this.pinnedCommits = [...this.commits];
    }
  }

  public close(): void {
    this.isOpen = false;
    if (this.modal) this.modal.open = false;
  }

  private applyOptions(opts: ExportImportOpenOptions): void {
    if (opts.tab) this.tab = opts.tab;
    if (opts.patchMode) this.patchMode = opts.patchMode;
    if (opts.bundleMode) this.bundleMode = opts.bundleMode;
    if (opts.ref) {
      this.archiveRef = opts.ref;
      this.extraRef = this.knownRefs().includes(opts.ref) ? '' : opts.ref;
    }
    const deepLinked = [...(opts.commitOids ?? []), ...(opts.commitOid ? [opts.commitOid] : [])];
    if (deepLinked.length > 0) {
      this.pinnedCommitOids = new Set([...this.pinnedCommitOids, ...deepLinked]);
      this.selectedCommits = new Set([...this.selectedCommits, ...deepLinked]);
    }
    if (this.tab === 'archive') {
      void this.loadArchivePreview();
    }
  }

  private reset(): void {
    this.tab = 'archive';
    this.operationRunning = false;
    this.error = '';
    this.archiveRef = 'HEAD';
    this.archiveFormat = 'zip';
    this.archivePrefix = '';
    this.previewFiles = [];
    this.previewLoading = false;
    this.extraRef = '';
    this.patchMode = 'create';
    this.commitFilter = '';
    this.selectedCommits = new Set<string>();
    this.pinnedCommitOids = new Set<string>();
    this.patchFile = '';
    this.patchTarget = 'worktree';
    this.bundleMode = 'create';
    this.bundleAllRefs = true;
    this.selectedRefs = new Set<string>();
    this.bundleFile = '';
    this.bundleHeads = [];
    this.bundleVerifyResult = null;
    this.bundleInspecting = false;
    // An inspection still in flight from the previous open must not report
    // into the freshly reset dialog.
    this.bundleInspectSeq++;
  }

  /** Cancel / × / Escape / overlay all honour the same rule. */
  private dismiss(): void {
    if (this.operationRunning) return;
    this.close();
  }

  private handleModalClose(): void {
    // lv-modal.close() sets open=false BEFORE dispatching, so without this the
    // operation would carry on with no visible surface and report its result
    // into a hidden dialog.
    if (this.operationRunning) {
      this.modal.open = true;
      return;
    }
    this.isOpen = false;
  }

  private handleTabChange(tab: ExportImportTab): void {
    this.tab = tab;
    this.error = '';
    if (tab === 'archive' && this.previewFiles.length === 0 && !this.previewLoading) {
      void this.loadArchivePreview();
    }
  }

  // ── Archive ──────────────────────────────────────────────────────────────

  private knownRefs(): string[] {
    const locals = this.scopedBranches.filter((b) => !b.isRemote).map((b) => b.shorthand);
    const remotes = this.scopedBranches.filter((b) => b.isRemote).map((b) => b.shorthand);
    return ['HEAD', ...locals, ...remotes, ...this.scopedTags.map((t) => t.name)];
  }

  private archiveRefOptions(): string[] {
    const known = this.knownRefs();
    return this.extraRef && !known.includes(this.extraRef) ? [this.extraRef, ...known] : known;
  }

  private async loadArchivePreview(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!repoPath) return;
    const ref = this.archiveRef;
    this.previewLoading = true;
    this.error = '';
    try {
      const result = await gitService.getArchiveFiles(repoPath, ref);
      // A ref change while this was in flight must not be overwritten by the
      // stale answer.
      if (this.archiveRef !== ref) return;
      if (result.success) {
        this.previewFiles = result.data ?? [];
      } else {
        this.previewFiles = [];
        this.error = result.error?.message ?? 'Failed to list archive contents';
      }
    } catch (err) {
      if (this.archiveRef !== ref) return;
      this.previewFiles = [];
      this.error = err instanceof Error ? err.message : 'Failed to list archive contents';
    } finally {
      if (this.archiveRef === ref) this.previewLoading = false;
    }
  }

  private handleArchiveRefChange(e: Event): void {
    this.archiveRef = (e.target as HTMLSelectElement).value;
    void this.loadArchivePreview();
  }

  private get archiveExtension(): string {
    return this.archiveFormat;
  }

  private async handleExportArchive(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    const ext = this.archiveExtension;
    const suggested = `${basename(repoPath)}-${sanitizeForFilename(this.archiveRef)}.${ext}`;

    const chosen = await saveDialog({
      title: 'Export Archive',
      defaultPath: suggested,
      filters: [{ name: this.archiveFormat, extensions: [ext] }],
    });
    // Cancelling the picker is not a failure: no invoke, no error banner.
    if (!chosen) return;

    this.operationRunning = true;
    this.error = '';
    try {
      const result = await gitService.createArchive(
        repoPath,
        chosen,
        this.archiveRef,
        this.archiveFormat,
        this.archivePrefix.trim() || undefined,
      );
      if (result.success) {
        showToast(`Archive written to ${chosen}`, 'success');
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to create archive';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create archive';
    } finally {
      this.operationRunning = false;
    }
  }

  // ── Patch ────────────────────────────────────────────────────────────────

  private visibleCommits(): { rows: Commit[]; total: number; pinned: Commit[] } {
    const needle = this.commitFilter.trim().toLowerCase();
    const matches = needle
      ? this.scopedCommits.filter(
          (c) =>
            c.summary.toLowerCase().includes(needle) ||
            c.shortId.toLowerCase().includes(needle) ||
            c.oid.toLowerCase().startsWith(needle),
        )
      : this.scopedCommits;
    const rows = matches.slice(0, MAX_ROWS);
    // Keep the graph's order for the pinned block: the deep link can carry a
    // whole multi-selection, and listing it newest-first matches the rows
    // below it.
    const pinned = this.scopedCommits.filter(
      (c) => this.pinnedCommitOids.has(c.oid) && !rows.some((row) => row.oid === c.oid),
    );
    return { rows, total: matches.length, pinned };
  }

  private toggleCommit(oid: string): void {
    const next = new Set(this.selectedCommits);
    if (next.has(oid)) next.delete(oid);
    else next.add(oid);
    this.selectedCommits = next;
  }

  private async handleCreatePatch(): Promise<void> {
    if (this.selectedCommits.size === 0) return;
    const repoPath = this.pinnedRepoPath;

    const chosen = await openDialog({
      title: 'Choose a folder for the patch files',
      directory: true,
    });
    const dir = Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
    if (!dir) return;

    // The backend numbers the files 0001-, 0002-, ... in the order it is
    // given, and stamps "Subject: [PATCH n/total]" the same way. The graph
    // hands commits over NEWEST-first, so passing the selection through in
    // list order would number the series backwards and make `git am` replay
    // it in reverse. Order by commit time, oldest first.
    //
    // Commit times are second-resolution, so a parent and its child can carry
    // the SAME timestamp (scripted or rapid-fire history). Sort is stable, so
    // those would keep the order they were ticked in and could number a child
    // before its parent, which `git am` cannot replay. Fall back to graph
    // order, which is newest-first, so an ancestor always wins the tie.
    const order = new Map(
      this.scopedCommits.map((c, i) => [c.oid, { timestamp: c.timestamp, index: i }]),
    );
    const oids = [...this.selectedCommits].sort((a, b) => {
      const ea = order.get(a);
      const eb = order.get(b);
      const byTime = (ea?.timestamp ?? 0) - (eb?.timestamp ?? 0);
      if (byTime !== 0) return byTime;
      return (eb?.index ?? Number.MAX_SAFE_INTEGER) - (ea?.index ?? Number.MAX_SAFE_INTEGER);
    });

    this.operationRunning = true;
    this.error = '';
    try {
      const result = await gitService.createPatch(repoPath, oids, dir);
      if (result.success) {
        const files = result.data ?? [];
        showToast(
          `Wrote ${files.length} patch file${files.length === 1 ? '' : 's'} to ${dir}`,
          'success',
        );
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to create patch files';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create patch files';
    } finally {
      this.operationRunning = false;
    }
  }

  private async handleChoosePatchFile(): Promise<void> {
    const chosen = await openDialog({
      title: 'Choose a patch file',
      filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
    });
    const file = Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
    if (!file) return;
    this.patchFile = file;
    this.error = '';
  }

  private async handleCheckPatch(): Promise<void> {
    if (!this.patchFile) return;
    const repoPath = this.pinnedRepoPath;
    this.operationRunning = true;
    this.error = '';
    try {
      // Dry run ONLY. It never falls through to a real apply — the user asked
      // whether it would work, not for it to happen.
      const result = await gitService.applyPatch(repoPath, this.patchFile, true);
      if (result.success) {
        showToast('Patch applies cleanly', 'success');
      } else {
        this.error = result.error?.message ?? 'Patch would not apply cleanly';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Patch would not apply cleanly';
    } finally {
      this.operationRunning = false;
    }
  }

  private async handleApplyPatch(): Promise<void> {
    if (!this.patchFile) return;
    const repoPath = this.pinnedRepoPath;
    // Applying writes the working tree (or the index), so it serializes on the
    // same lock as checkout/reset/clean.
    if (!tryAcquireRefOp(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.operationRunning = true;
    this.error = '';
    const target = this.patchTarget;
    try {
      const result =
        target === 'index'
          ? await gitService.applyPatchToIndex(repoPath, this.patchFile)
          : await gitService.applyPatch(repoPath, this.patchFile);
      if (result.success) {
        showToast(
          target === 'index' ? 'Patch applied to the index' : 'Patch applied to the working tree',
          'success',
        );
        this.dispatchEvent(
          new CustomEvent('patch-applied', {
            detail: { repositoryPath: repoPath, target },
            bubbles: true,
            composed: true,
          }),
        );
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to apply patch';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to apply patch';
    } finally {
      this.operationRunning = false;
      releaseRefOp(repoPath);
    }
  }

  // ── Bundle ───────────────────────────────────────────────────────────────

  private bundleRefOptions(): string[] {
    return [
      ...this.scopedBranches.filter((b) => !b.isRemote).map((b) => `refs/heads/${b.shorthand}`),
      ...this.scopedTags.map((t) => `refs/tags/${t.name}`),
    ];
  }

  private toggleBundleRef(ref: string): void {
    const next = new Set(this.selectedRefs);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    this.selectedRefs = next;
  }

  private async handleCreateBundle(): Promise<void> {
    // The backend rejects "no refs and not --all"; the button is disabled for
    // that combination so the user can never reach the error.
    if (!this.bundleAllRefs && this.selectedRefs.size === 0) return;
    const repoPath = this.pinnedRepoPath;

    const chosen = await saveDialog({
      title: 'Create Bundle',
      defaultPath: `${basename(repoPath)}.bundle`,
      filters: [{ name: 'Git bundle', extensions: ['bundle'] }],
    });
    if (!chosen) return;

    this.operationRunning = true;
    this.error = '';
    try {
      const result = await gitService.bundleCreate(
        repoPath,
        chosen,
        this.bundleAllRefs ? [] : [...this.selectedRefs],
        this.bundleAllRefs,
      );
      if (result.success) {
        const data = result.data;
        showToast(
          `Bundle written — ${data?.refsCount ?? 0} refs, ${data?.objectsCount ?? 0} objects`,
          'success',
        );
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to create bundle';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create bundle';
    } finally {
      this.operationRunning = false;
    }
  }

  private async handleChooseBundleFile(): Promise<void> {
    const chosen = await openDialog({
      title: 'Choose a bundle file',
      filters: [{ name: 'Git bundle', extensions: ['bundle'] }],
    });
    const file = Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
    if (!file) return;

    this.bundleFile = file;
    this.bundleHeads = [];
    this.bundleVerifyResult = null;
    this.bundleInspecting = true;
    this.error = '';
    // The Choose button stays live while this runs, so the user can pick a
    // second bundle before the first answer arrives. Only the newest request
    // is allowed to write the heads / verify result the Import button reads.
    const seq = ++this.bundleInspectSeq;
    try {
      // Two separate questions: what the bundle CONTAINS (readable even when
      // this repo lacks the prerequisites) and whether it can be APPLIED here.
      const [heads, verify] = await Promise.all([
        gitService.bundleListHeads(file),
        gitService.bundleVerify(this.pinnedRepoPath, file),
      ]);
      if (seq !== this.bundleInspectSeq) return;
      if (heads.success) {
        this.bundleHeads = heads.data ?? [];
      } else {
        this.error = heads.error?.message ?? 'Failed to read the bundle';
      }
      if (verify.success) {
        this.bundleVerifyResult = verify.data ?? null;
      } else if (!this.error) {
        this.error = verify.error?.message ?? 'Failed to verify the bundle';
      }
    } catch (err) {
      if (seq !== this.bundleInspectSeq) return;
      this.error = err instanceof Error ? err.message : 'Failed to read the bundle';
    } finally {
      // A superseded request must leave the spinner alone — the newer one owns
      // it and is still running.
      if (seq === this.bundleInspectSeq) this.bundleInspecting = false;
    }
  }

  private async handleImportBundle(): Promise<void> {
    if (!this.bundleFile || !this.bundleVerifyResult?.isValid) return;
    const repoPath = this.pinnedRepoPath;
    // Unbundling writes refs into this repository.
    if (!tryAcquireRefOp(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.operationRunning = true;
    this.error = '';
    try {
      const result = await gitService.bundleUnbundle(repoPath, this.bundleFile);
      if (result.success) {
        const refs = result.data ?? [];
        showToast(`Imported ${refs.length} ref${refs.length === 1 ? '' : 's'}`, 'success');
        this.dispatchEvent(
          new CustomEvent('bundle-imported', {
            detail: { repositoryPath: repoPath, refs },
            bubbles: true,
            composed: true,
          }),
        );
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to import the bundle';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to import the bundle';
    } finally {
      this.operationRunning = false;
      releaseRefOp(repoPath);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  private renderArchive() {
    const shown = this.previewFiles.slice(0, MAX_ROWS);
    return html`
      <div class="row">
        <div class="field">
          <label for="archive-ref">Source ref</label>
          <!-- .selected on each option, not .value on the select: Lit commits
               the select's own bindings BEFORE its children exist, so a .value
               naming a deep-linked ref silently fell back to the first entry. -->
          <select
            id="archive-ref"
            @change=${this.handleArchiveRefChange}
            ?disabled=${this.operationRunning}
          >
            ${this.archiveRefOptions().map(
              (r) => html`<option value=${r} .selected=${r === this.archiveRef}>${r}</option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label for="archive-format">Format</label>
          <select
            id="archive-format"
            @change=${(e: Event) => {
              this.archiveFormat = (e.target as HTMLSelectElement).value as ArchiveFormat;
            }}
            ?disabled=${this.operationRunning}
          >
            ${(['zip', 'tar', 'tar.gz'] as ArchiveFormat[]).map(
              (f) => html`<option value=${f} .selected=${f === this.archiveFormat}>${f}</option>`,
            )}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="archive-prefix">Prefix folder (optional)</label>
        <input
          id="archive-prefix"
          type="text"
          placeholder="my-project"
          .value=${this.archivePrefix}
          @input=${(e: Event) => {
            this.archivePrefix = (e.target as HTMLInputElement).value;
          }}
          ?disabled=${this.operationRunning}
        />
        <span class="hint">Nests every entry under this directory inside the archive.</span>
      </div>

      <div class="field">
        <label>Contents</label>
        ${this.previewLoading
          ? html`<div class="empty">Reading the tree…</div>`
          : html`
              <div class="hint" data-testid="archive-file-count">
                ${this.previewFiles.length} file${this.previewFiles.length === 1 ? '' : 's'}
              </div>
              <div class="list">
                ${shown.length === 0
                  ? html`<div class="empty">No files in this tree</div>`
                  : shown.map((f) => html`<div class="list-row mono truncate">${f}</div>`)}
              </div>
              ${this.previewFiles.length > MAX_ROWS
                ? html`<span class="hint"
                    >Showing first ${MAX_ROWS} of ${this.previewFiles.length}</span
                  >`
                : nothing}
            `}
      </div>
    `;
  }

  private renderPatchCreate() {
    const { rows, total, pinned } = this.visibleCommits();
    const row = (c: Commit, isPinned: boolean) => html`
      <label class="list-row ${isPinned ? 'pinned' : ''}">
        <input
          type="checkbox"
          .checked=${this.selectedCommits.has(c.oid)}
          @change=${() => this.toggleCommit(c.oid)}
          ?disabled=${this.operationRunning}
          data-oid=${c.oid}
        />
        <span class="mono">${c.shortId}</span>
        <span class="truncate">${c.summary}</span>
      </label>
    `;
    return html`
      <div class="field">
        <label for="commit-filter">Commits</label>
        <input
          id="commit-filter"
          type="text"
          placeholder="Filter by summary or id"
          .value=${this.commitFilter}
          @input=${(e: Event) => {
            this.commitFilter = (e.target as HTMLInputElement).value;
          }}
          ?disabled=${this.operationRunning}
        />
        <div class="list">
          ${pinned.map((c) => row(c, true))}
          ${rows.length === 0 && pinned.length === 0
            ? html`<div class="empty">No commits match</div>`
            : rows.map((c) => row(c, false))}
        </div>
        ${total > MAX_ROWS
          ? html`<span class="hint">Showing first ${MAX_ROWS} of ${total}</span>`
          : nothing}
        <span class="hint" data-testid="patch-selected-count"
          >${this.selectedCommits.size} selected — files are numbered oldest first</span
        >
      </div>
    `;
  }

  private renderPatchApply() {
    return html`
      <div class="field">
        <label>Patch file</label>
        <div class="check-row">
          <button
            class="btn btn-secondary"
            data-testid="patch-choose-file"
            @click=${this.handleChoosePatchFile}
            ?disabled=${this.operationRunning}
          >
            Choose patch file…
          </button>
          <span class="chosen-file" data-testid="chosen-patch-file"
            >${this.patchFile || 'No file chosen'}</span
          >
        </div>
      </div>

      <div class="field">
        <label>Apply to</label>
        <div class="radio-row">
          <label>
            <input
              type="radio"
              name="patch-target"
              value="worktree"
              .checked=${this.patchTarget === 'worktree'}
              @change=${() => {
                this.patchTarget = 'worktree';
              }}
              ?disabled=${this.operationRunning}
            />
            Working tree
          </label>
          <label>
            <input
              type="radio"
              name="patch-target"
              value="index"
              .checked=${this.patchTarget === 'index'}
              @change=${() => {
                this.patchTarget = 'index';
              }}
              ?disabled=${this.operationRunning}
            />
            Index (staged)
          </label>
        </div>
      </div>
    `;
  }

  private renderPatch() {
    return html`
      <div class="radio-row">
        <label>
          <input
            type="radio"
            name="patch-mode"
            .checked=${this.patchMode === 'create'}
            @change=${() => {
              this.patchMode = 'create';
              this.error = '';
            }}
            ?disabled=${this.operationRunning}
          />
          Create patch files
        </label>
        <label>
          <input
            type="radio"
            name="patch-mode"
            .checked=${this.patchMode === 'apply'}
            @change=${() => {
              this.patchMode = 'apply';
              this.error = '';
            }}
            ?disabled=${this.operationRunning}
          />
          Apply a patch file
        </label>
      </div>
      ${this.patchMode === 'create' ? this.renderPatchCreate() : this.renderPatchApply()}
    `;
  }

  private renderBundleCreate() {
    return html`
      <div class="check-row">
        <input
          id="bundle-all"
          type="checkbox"
          .checked=${this.bundleAllRefs}
          @change=${(e: Event) => {
            this.bundleAllRefs = (e.target as HTMLInputElement).checked;
          }}
          ?disabled=${this.operationRunning}
        />
        <label for="bundle-all">Include all refs (--all)</label>
      </div>
      ${this.bundleAllRefs
        ? nothing
        : html`
            <div class="field">
              <label>Refs to include</label>
              <div class="list">
                ${this.bundleRefOptions().length === 0
                  ? html`<div class="empty">No local refs to bundle</div>`
                  : this.bundleRefOptions().map(
                      (r) => html`
                        <label class="list-row">
                          <input
                            type="checkbox"
                            .checked=${this.selectedRefs.has(r)}
                            @change=${() => this.toggleBundleRef(r)}
                            ?disabled=${this.operationRunning}
                            data-ref=${r}
                          />
                          <span class="mono truncate">${r}</span>
                        </label>
                      `,
                    )}
              </div>
            </div>
          `}
    `;
  }

  private renderBundleImport() {
    const verify = this.bundleVerifyResult;
    return html`
      <div class="field">
        <label>Bundle file</label>
        <div class="check-row">
          <button
            class="btn btn-secondary"
            data-testid="bundle-choose-file"
            @click=${this.handleChooseBundleFile}
            ?disabled=${this.operationRunning}
          >
            Choose bundle…
          </button>
          <span class="chosen-file" data-testid="chosen-bundle-file"
            >${this.bundleFile || 'No file chosen'}</span
          >
        </div>
      </div>

      ${this.bundleInspecting ? html`<div class="empty">Reading the bundle…</div>` : nothing}
      ${this.bundleFile && !this.bundleInspecting
        ? html`
            <div class="field">
              <label>This bundle contains</label>
              <div class="list">
                ${this.bundleHeads.length === 0
                  ? html`<div class="empty">This bundle contains no refs</div>`
                  : this.bundleHeads.map(
                      (r) => html`
                        <div class="list-row">
                          <span class="mono">${r.oid.substring(0, 7)}</span>
                          <span class="truncate">${r.name}</span>
                        </div>
                      `,
                    )}
              </div>
            </div>
          `
        : nothing}
      ${verify && !verify.isValid
        ? html`
            <div class="warning" data-testid="bundle-unimportable">
              <div>${verify.message ?? 'This bundle cannot be imported into this repository.'}</div>
              ${verify.requires.length > 0
                ? html`
                    <div class="hint">Missing prerequisite commits</div>
                    ${verify.requires.map((oid) => html`<div class="mono">${oid}</div>`)}
                  `
                : nothing}
            </div>
          `
        : nothing}
    `;
  }

  private renderBundle() {
    return html`
      <div class="radio-row">
        <label>
          <input
            type="radio"
            name="bundle-mode"
            .checked=${this.bundleMode === 'create'}
            @change=${() => {
              this.bundleMode = 'create';
              this.error = '';
            }}
            ?disabled=${this.operationRunning}
          />
          Create a bundle
        </label>
        <label>
          <input
            type="radio"
            name="bundle-mode"
            .checked=${this.bundleMode === 'import'}
            @change=${() => {
              this.bundleMode = 'import';
              this.error = '';
            }}
            ?disabled=${this.operationRunning}
          />
          Import a bundle
        </label>
      </div>
      ${this.bundleMode === 'create' ? this.renderBundleCreate() : this.renderBundleImport()}
    `;
  }

  private renderFooterAction() {
    if (this.tab === 'archive') {
      return html`
        <button
          class="btn btn-primary"
          data-testid="archive-export"
          @click=${this.handleExportArchive}
          ?disabled=${this.operationRunning}
        >
          ${this.operationRunning ? 'Exporting…' : 'Export archive'}
        </button>
      `;
    }

    if (this.tab === 'patch') {
      if (this.patchMode === 'create') {
        return html`
          <button
            class="btn btn-primary"
            data-testid="patch-create"
            @click=${this.handleCreatePatch}
            ?disabled=${this.operationRunning || this.selectedCommits.size === 0}
          >
            ${this.operationRunning ? 'Writing…' : 'Create patch files…'}
          </button>
        `;
      }
      return html`
        <button
          class="btn btn-secondary"
          data-testid="patch-check"
          @click=${this.handleCheckPatch}
          ?disabled=${this.operationRunning || !this.patchFile}
        >
          Check
        </button>
        <button
          class="btn btn-primary"
          data-testid="patch-apply"
          @click=${this.handleApplyPatch}
          ?disabled=${this.operationRunning || !this.patchFile || this.lock.busy}
        >
          ${this.operationRunning ? 'Applying…' : 'Apply'}
        </button>
      `;
    }

    if (this.bundleMode === 'create') {
      return html`
        <button
          class="btn btn-primary"
          data-testid="bundle-create"
          @click=${this.handleCreateBundle}
          ?disabled=${this.operationRunning ||
          (!this.bundleAllRefs && this.selectedRefs.size === 0)}
        >
          ${this.operationRunning ? 'Writing…' : 'Create bundle…'}
        </button>
      `;
    }
    return html`
      <button
        class="btn btn-primary"
        data-testid="bundle-import"
        @click=${this.handleImportBundle}
        ?disabled=${this.operationRunning ||
        !this.bundleVerifyResult?.isValid ||
        this.lock.busy}
      >
        ${this.operationRunning ? 'Importing…' : 'Import refs'}
      </button>
    `;
  }

  render() {
    return html`
      <lv-modal modalTitle="Export / Import" @close=${this.handleModalClose}>
        <div class="body">
          <div class="tabs" role="tablist">
            ${(['archive', 'patch', 'bundle'] as ExportImportTab[]).map(
              (t) => html`
                <button
                  class="tab ${this.tab === t ? 'active' : ''}"
                  role="tab"
                  aria-selected=${this.tab === t ? 'true' : 'false'}
                  data-tab=${t}
                  @click=${() => this.handleTabChange(t)}
                  ?disabled=${this.operationRunning}
                >
                  ${t === 'archive' ? 'Archive' : t === 'patch' ? 'Patch' : 'Bundle'}
                </button>
              `,
            )}
          </div>

          ${this.tab === 'archive'
            ? this.renderArchive()
            : this.tab === 'patch'
              ? this.renderPatch()
              : this.renderBundle()}

          ${this.error ? html`<div class="error" data-testid="dialog-error">${this.error}</div>` : nothing}
        </div>

        <div slot="footer">
          <button class="btn btn-secondary" @click=${this.dismiss} ?disabled=${this.operationRunning}>
            Cancel
          </button>
          ${this.renderFooterAction()}
        </div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-export-import-dialog': LvExportImportDialog;
  }
}
