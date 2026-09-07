/**
 * Scan for Repositories Dialog
 *
 * Two entry points:
 *  - the welcome screen's "Scan" action, which picks a folder and opens this
 *    dialog straight into the scan;
 *  - a folder dropped on the window that is not a repository, which opens this
 *    dialog on its offer step ("scan it, or initialise it here?").
 *
 * Everything found is opened through `openRepositoryPath`, so tabs, the recent
 * list and persistence behave exactly as they do for the Open button.
 */

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import {
  scanForRepositories,
  cancelRepositoryScan,
  onRepositoryScanProgress,
  type DiscoveredRepository,
  type RepositoryScanResult,
  type RepositoryScanProgress,
} from '../../services/repo-scan.service.ts';
import { openRepositoryPath } from '../../services/repository-open.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { repositoryStore } from '../../stores/index.ts';
import type { UnlistenFn } from '@tauri-apps/api/event';
import './lv-modal.ts';

type ScanPhase = 'offer' | 'scanning' | 'results' | 'error';

/** Last path segment, for toasts that must not print a whole absolute path. */
function folderName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

@customElement('lv-scan-repositories-dialog')
export class LvScanRepositoriesDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: 420px;
        max-width: 620px;
      }

      .folder-path {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        word-break: break-all;
      }

      .explanation {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .offer-actions {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .progress {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 3s;
        }
      }

      .results-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .toolbar-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .link-btn {
        background: none;
        border: none;
        color: var(--color-primary);
        cursor: pointer;
        font-size: var(--font-size-xs);
        padding: 0;
      }

      .link-btn:hover {
        text-decoration: underline;
      }

      .results-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 320px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-xs);
      }

      .result-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }

      .result-item:hover {
        background: var(--color-bg-hover);
      }

      .result-info {
        min-width: 0;
        flex: 1;
      }

      .result-name {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .result-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .badge {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: 0 var(--spacing-xs);
      }

      .notice {
        font-size: var(--font-size-xs);
        padding: var(--spacing-sm);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-secondary);
      }

      .notice.warning {
        color: var(--color-warning);
      }

      .error-message {
        font-size: var(--font-size-sm);
        color: var(--color-error);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-lg);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
      }

      .btn-primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border: none;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
      }

      .btn-secondary:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .btn-secondary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  /** Controlled by the shell, like every other top-level dialog. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** The folder to scan (or the dropped folder being offered). */
  @property({ type: String }) scanPath = '';

  /**
   * `scan` starts scanning as soon as the dialog opens (the user already chose
   * the folder); `offer` first asks what to do with a dropped folder that is
   * not a repository.
   */
  @property({ type: String }) mode: 'scan' | 'offer' = 'scan';

  /**
   * Bumped by the shell for every request to show this dialog.
   *
   * Dropping the SAME folder again while the dialog is open changes neither
   * `scanPath` nor `mode`, and `open` is already true, so nothing else here can
   * tell that the drop happened — and the drop said nothing at all, the one
   * drop outcome in the app that was silent.
   */
  @property({ type: Number }) requestId = 0;

  @state() private phase: ScanPhase = 'offer';
  @state() private progress: RepositoryScanProgress | null = null;
  @state() private result: RepositoryScanResult | null = null;
  @state() private selected: Set<string> = new Set();
  @state() private error = '';
  @state() private isOpening = false;
  @state() private isCancelling = false;
  /** Paths already open, so the list can mark them instead of implying a new tab. */
  @state() private openPaths: string[] = [];

  private progressUnlisten?: UnlistenFn;
  /**
   * Bumped for every scan (and every close). A scan that resolves after the
   * dialog was closed — or after a second scan started — must not write its
   * results over what the user is looking at now.
   */
  private scanToken = 0;
  /**
   * Set by Cancel. The backend clears its own cancellation flag when a scan
   * STARTS, so a cancel pressed in the gap between "scanning" appearing and
   * the scan command actually being sent would be thrown away and the dialog
   * would sit on "Cancelling…" for the length of a full scan. Cancelling in
   * that gap stops the scan before it is ever sent.
   */
  private cancelRequested = false;
  /** True once the scan command has actually been sent to the backend. */
  private scanIssued = false;
  /**
   * What the last `activate()` pointed the dialog at, so a re-drop of the same
   * folder can be told apart from a drop of a different one and reported for
   * what it is.
   */
  private activatedPath: string | null = null;
  private activatedMode: 'scan' | 'offer' | null = null;

  updated(changed: PropertyValues): void {
    // An OS folder drop is not blocked by an in-page modal, so a second folder
    // can be dropped while this dialog is already open. The shell re-points the
    // dialog by writing `scanPath`/`mode` and asking the dialog store to open a
    // dialog that is open already — `open` never changes, so reacting only to
    // `open` would leave the user looking at the FIRST folder while every
    // action here (Initialize, the re-scan) silently used the second one.
    const retargeted =
      this.open &&
      !changed.has('open') &&
      (changed.has('scanPath') || changed.has('mode') || changed.has('requestId'));
    if (!changed.has('open') && !retargeted) return;

    if (this.open) {
      void this.activate(retargeted);
    } else {
      this.abortScan();
    }
  }

  /**
   * Stop any running scan and make sure neither its results nor its progress
   * events can land on whatever the dialog shows next.
   */
  private abortScan(): void {
    // Closing (or re-pointing) mid-scan must stop the backend walk, not leave
    // it running against a dialog nobody can see.
    if (this.phase === 'scanning') {
      this.cancelRequested = true;
      if (this.scanIssued) void cancelRepositoryScan();
    }
    this.scanToken++;
    this.detachProgress();
  }

  /** Point the dialog at `scanPath`, whether it just opened or was re-targeted. */
  private async activate(retargeted: boolean): Promise<void> {
    const cancelInFlight = retargeted && this.phase === 'scanning' && this.scanIssued;
    // The same folder dropped a second time. Re-scanning it is what the user is
    // asking for — they have just created, cloned or moved something in it, and
    // a re-drop is the only way to refresh results from inside the dialog. The
    // untouched offer step is the exception: it is a question the user has not
    // answered yet, so re-asking it (and saying why) beats scanning behind their
    // back.
    const sameFolder =
      retargeted && this.scanPath === this.activatedPath && this.mode === this.activatedMode;
    const rescanSameFolder = sameFolder && this.phase !== 'offer';
    this.activatedPath = this.scanPath;
    this.activatedMode = this.mode;
    this.abortScan();
    const token = this.scanToken;

    this.reset();
    this.openPaths = repositoryStore
      .getState()
      .openRepositories.map((repo) => repo.repository.path);

    if (retargeted) {
      // The dialog was already on screen: say what the drop just did, or it
      // looks like it did nothing.
      showToast(this.retargetMessage(sameFolder, rescanSameFolder), 'info');
    }

    if (cancelInFlight) {
      // Wait for the backend to acknowledge the cancellation before asking for
      // the next scan: the backend clears its cancellation flag when a scan
      // STARTS, so a cancel still in flight could otherwise stop the new scan.
      await cancelRepositoryScan();
      // Re-targeted again while we waited; that pass owns the dialog now.
      if (token !== this.scanToken) return;
    }

    if ((this.mode === 'scan' || rescanSameFolder) && this.scanPath) {
      void this.startScan();
    }
  }

  /** What a drop onto the already-open dialog just did. */
  private retargetMessage(sameFolder: boolean, rescanSameFolder: boolean): string {
    const name = folderName(this.scanPath);
    if (rescanSameFolder) return `Rescanning ${name}`;
    // Re-dropped onto its own unanswered offer: nothing changed, so say why the
    // same question is still on screen rather than leaving the drop unexplained.
    if (sameFolder) return `${name} is still not a Git repository`;
    return this.mode === 'scan' ? `Now scanning ${name}` : `Now showing ${name}`;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scanToken++;
    this.detachProgress();
  }

  private reset(): void {
    this.phase = this.mode === 'scan' ? 'scanning' : 'offer';
    this.progress = null;
    this.result = null;
    this.selected = new Set();
    this.error = '';
    this.isOpening = false;
    this.isCancelling = false;
  }

  private detachProgress(): void {
    const unlisten = this.progressUnlisten;
    this.progressUnlisten = undefined;
    unlisten?.();
  }

  private async startScan(): Promise<void> {
    if (!this.scanPath) {
      this.phase = 'error';
      this.error = 'No folder was chosen to scan';
      return;
    }

    this.phase = 'scanning';
    this.progress = null;
    this.error = '';
    this.isCancelling = false;

    const token = ++this.scanToken;
    this.cancelRequested = false;
    this.scanIssued = false;
    this.detachProgress();
    this.progressUnlisten = await onRepositoryScanProgress((progress) => {
      // A late event from a scan the user already cancelled must not reanimate
      // the progress line under the results.
      if (token === this.scanToken && this.phase === 'scanning') this.progress = progress;
    });

    // Closed, reopened, or rescanned while the listener was being attached.
    if (token !== this.scanToken) {
      this.detachProgress();
      return;
    }
    if (this.cancelRequested) {
      // Cancelled before the walk was even asked for: report it as the empty
      // cancelled scan it is rather than starting one nobody wants.
      this.detachProgress();
      this.result = {
        root: this.scanPath,
        repositories: [],
        scannedDirectories: 0,
        truncated: false,
        cancelled: true,
      };
      this.phase = 'results';
      return;
    }

    this.scanIssued = true;
    const response = await scanForRepositories(this.scanPath);
    this.detachProgress();
    // Closed, reopened, or rescanned while this scan was running.
    if (token !== this.scanToken) return;

    if (!response.success || !response.data) {
      this.phase = 'error';
      this.error = response.error?.message ?? 'Failed to scan for repositories';
      return;
    }

    this.result = response.data;
    // Nothing is pre-selected: a scan can return hundreds of repositories and
    // "Open selected" must never be a one-click way to open all of them.
    this.selected = new Set();
    this.phase = 'results';
  }

  private async handleCancelScan(): Promise<void> {
    this.isCancelling = true;
    this.cancelRequested = true;
    // Nothing is running in the backend yet; startScan will stop on its own.
    if (!this.scanIssued) return;
    const result = await cancelRepositoryScan();
    if (!result.success) {
      this.isCancelling = false;
      showToast(result.error?.message ?? 'Failed to cancel the scan', 'error');
    }
  }

  /** The folder the dialog currently names on screen. */
  private get displayedPath(): string {
    return this.phase === 'results' ? (this.result?.root ?? this.scanPath) : this.scanPath;
  }

  private handleScanFromOffer(): void {
    void this.startScan();
  }

  private handleInitialize(): void {
    // The init dialog lives in the shell (or on the welcome screen); it owns
    // the branch-name settings and the error handling for init.
    this.dispatchEvent(
      new CustomEvent<{ path: string }>('initialize-repository', {
        // The empty-results screen names `result.root`, so initialise THAT and
        // never a path the user cannot see.
        detail: { path: this.displayedPath },
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  }

  private toggleSelection(path: string): void {
    const next = new Set(this.selected);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.selected = next;
  }

  private selectAll(): void {
    this.selected = new Set((this.result?.repositories ?? []).map((repo) => repo.path));
  }

  private clearSelection(): void {
    this.selected = new Set();
  }

  private async handleOpenSelected(): Promise<void> {
    const paths = (this.result?.repositories ?? [])
      .map((repo) => repo.path)
      .filter((path) => this.selected.has(path));
    if (paths.length === 0) return;

    // Opening a repository takes seconds, and an OS folder drop is not blocked
    // by the modal: the dialog can be closed or re-pointed at another folder
    // while this loop is still running. The same token that keeps a stale scan
    // off the screen keeps this loop's outcome off it too.
    const token = this.scanToken;
    this.isOpening = true;
    let opened = 0;
    let alreadyOpen = 0;
    const failures: string[] = [];

    try {
      for (const path of paths) {
        const outcome = await openRepositoryPath(path);
        if (outcome.status === 'opened') opened++;
        else if (outcome.status === 'already-open') alreadyOpen++;
        else failures.push(`${outcome.path}: ${outcome.message ?? 'failed to open'}`);
      }
    } finally {
      // `reset()` already cleared this for the folder that replaced ours; only
      // release the guard if this loop still owns the dialog, or Escape would
      // be let through for a pass that never armed it.
      if (token === this.scanToken) this.isOpening = false;
    }

    if (token !== this.scanToken) {
      this.reportAbandonedOpen(opened, failures);
      return;
    }

    if (failures.length > 0) {
      // Keep the dialog open so the user can retry the ones that worked or
      // deselect the ones that did not.
      this.error =
        failures.length === 1
          ? `Could not open ${failures[0]}`
          : `Could not open ${failures.length} of ${paths.length} repositories: ${failures.join('; ')}`;
      showToast(
        opened > 0
          ? `Opened ${opened} of ${paths.length} repositories`
          : 'Could not open the selected repositories',
        opened > 0 ? 'warning' : 'error',
      );
      this.openPaths = repositoryStore
        .getState()
        .openRepositories.map((repo) => repo.repository.path);
      return;
    }

    if (opened > 0) {
      showToast(
        opened === 1 ? 'Opened 1 repository' : `Opened ${opened} repositories`,
        'success',
      );
    } else if (alreadyOpen > 0) {
      showToast(
        alreadyOpen === 1
          ? 'That repository is already open'
          : 'Those repositories are already open',
        'info',
      );
    }
    this.close();
  }

  /**
   * Report an open loop that finished after the dialog was closed or re-pointed
   * at another folder.
   *
   * The repositories really did open, so saying nothing would lose the outcome
   * of an action the user asked for. It is reported as toasts only: the screen
   * now belongs to another folder (or to nothing), so writing an error message
   * into it, or closing it, would take away the drop the user just made.
   */
  private reportAbandonedOpen(opened: number, failures: string[]): void {
    if (opened > 0) {
      showToast(
        opened === 1 ? 'Opened 1 repository' : `Opened ${opened} repositories`,
        'success',
      );
    }
    for (const failure of failures) {
      showToast(`Could not open ${failure}`, 'error');
    }
    // Anything that did open belongs in the "already open" badges of whatever
    // the dialog is showing now.
    this.openPaths = repositoryStore
      .getState()
      .openRepositories.map((repo) => repo.repository.path);
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private handleModalClose(): void {
    // Cancel is disabled while repositories are being opened; Escape, the
    // overlay and the × must honour the same rule.
    if (this.isOpening) return;
    this.close();
  }

  private renderOffer() {
    return html`
      <div class="body">
        <div class="explanation">This folder is not a Git repository.</div>
        <div class="folder-path">${this.scanPath}</div>
        <div class="offer-actions">
          <button class="btn btn-primary" @click=${this.handleScanFromOffer}>
            Scan it for repositories
          </button>
          <button class="btn btn-secondary" @click=${this.handleInitialize}>
            Initialize a repository here
          </button>
        </div>
      </div>
    `;
  }

  private renderScanning() {
    return html`
      <div class="body">
        <div class="folder-path">${this.scanPath}</div>
        <div class="progress">
          <span class="spinner" aria-hidden="true"></span>
          <span role="status">
            ${this.progress
              ? `Searched ${this.progress.scannedDirectories} folders — found ${this.progress.found} ${this.progress.found === 1 ? 'repository' : 'repositories'}`
              : 'Searching for repositories…'}
          </span>
        </div>
      </div>
    `;
  }

  private renderResultItem(repo: DiscoveredRepository) {
    const isOpen = this.openPaths.includes(repo.path);
    return html`
      <label class="result-item">
        <input
          type="checkbox"
          .checked=${this.selected.has(repo.path)}
          aria-label="Select ${repo.name}"
          @change=${() => this.toggleSelection(repo.path)}
        />
        <div class="result-info">
          <div class="result-name">${repo.name}</div>
          <div class="result-path">${repo.path}</div>
        </div>
        ${repo.isBare ? html`<span class="badge">bare</span>` : ''}
        ${isOpen ? html`<span class="badge">already open</span>` : ''}
      </label>
    `;
  }

  private renderResults() {
    const result = this.result;
    if (!result) return html``;
    const repositories = result.repositories;

    if (repositories.length === 0) {
      return html`
        <div class="body">
          <div class="explanation">
            No Git repositories were found in this folder
            ${result.cancelled ? ' before the scan was cancelled' : ''}.
          </div>
          <div class="folder-path">${result.root}</div>
          <div class="notice">
            Searched ${result.scannedDirectories}
            ${result.scannedDirectories === 1 ? 'folder' : 'folders'}. Nested folders more than a
            few levels deep, hidden folders and dependency folders such as node_modules are
            skipped.
          </div>
          <div class="offer-actions">
            <button class="btn btn-secondary" @click=${this.handleInitialize}>
              Initialize a repository here
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="body">
        <div class="folder-path">${result.root}</div>
        <div class="results-toolbar">
          <span>
            ${repositories.length}
            ${repositories.length === 1 ? 'repository' : 'repositories'} found in
            ${result.scannedDirectories}
            ${result.scannedDirectories === 1 ? 'folder' : 'folders'}
          </span>
          <span class="toolbar-actions">
            <button class="link-btn" @click=${this.selectAll}>Select all</button>
            <button class="link-btn" @click=${this.clearSelection}>Clear</button>
          </span>
        </div>
        ${result.cancelled
          ? html`<div class="notice warning">
              Scan cancelled — showing what was found before you stopped it.
            </div>`
          : ''}
        ${result.truncated
          ? html`<div class="notice warning">
              The scan stopped early because this folder is very large. Choose a folder closer to
              your repositories to see the rest.
            </div>`
          : ''}
        <div class="results-list" role="group" aria-label="Repositories found">
          ${repositories.map((repo) => this.renderResultItem(repo))}
        </div>
        ${this.error ? html`<div class="error-message">${this.error}</div>` : ''}
      </div>
    `;
  }

  private renderError() {
    return html`
      <div class="body">
        <div class="error-message">${this.error}</div>
        <div class="folder-path">${this.scanPath}</div>
      </div>
    `;
  }

  private renderFooter() {
    if (this.phase === 'scanning') {
      return html`
        <button
          class="btn btn-secondary"
          @click=${this.handleCancelScan}
          ?disabled=${this.isCancelling}
        >
          ${this.isCancelling ? 'Cancelling…' : 'Cancel scan'}
        </button>
      `;
    }

    if (this.phase === 'results' && (this.result?.repositories.length ?? 0) > 0) {
      return html`
        <button class="btn btn-secondary" @click=${this.close} ?disabled=${this.isOpening}>
          Close
        </button>
        <button
          class="btn btn-primary"
          @click=${this.handleOpenSelected}
          ?disabled=${this.selected.size === 0 || this.isOpening}
        >
          ${this.isOpening ? 'Opening…' : `Open selected (${this.selected.size})`}
        </button>
      `;
    }

    // A failed scan used to offer nothing but Close: the folder was gone from
    // the dialog, so recovering meant Close, the welcome screen, Scan and
    // picking the same folder again in an OS picker. Retrying needs a folder to
    // retry against, so the empty-path failure keeps Close alone.
    if (this.phase === 'error' && this.scanPath) {
      return html`
        <button class="btn btn-secondary" @click=${this.close}>Close</button>
        <button class="btn btn-primary" @click=${this.handleScanFromOffer}>Try again</button>
      `;
    }

    return html`<button class="btn btn-secondary" @click=${this.close}>Close</button>`;
  }

  render() {
    return html`
      <lv-modal
        modalTitle="Scan for Repositories"
        ?open=${this.open}
        @close=${this.handleModalClose}
      >
        ${this.phase === 'offer' ? this.renderOffer() : ''}
        ${this.phase === 'scanning' ? this.renderScanning() : ''}
        ${this.phase === 'results' ? this.renderResults() : ''}
        ${this.phase === 'error' ? this.renderError() : ''}
        <div slot="footer">${this.renderFooter()}</div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-scan-repositories-dialog': LvScanRepositoriesDialog;
  }
}
