/**
 * Repository Health Dialog
 * Shows repository health information and provides maintenance actions
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import {
  tryAcquireMaintenance,
  tryAcquireMaintenanceReadOnly,
  releaseMaintenance,
  isMaintenanceBlocked,
  isMaintenanceRunning,
} from '../../utils/maintenance-confirms.ts';
import {
  confirmGarbageCollection,
  confirmPrune,
  summariseFsck,
} from '../../utils/maintenance-confirms.ts';
import { subscribeRefOps, warnRepositoryBusy } from '../../utils/ref-lock.ts';

interface HealthStats {
  objectCount: number;
  packCount: number;
  looseObjectCount: number;
  sizeKb: number;
  branchCount: number;
  tagCount: number;
  stashCount: number;
  lastGcDate: string | null;
  recommendations: string[];
  // Overview stats from getRepoStats
  totalCommits: number | null;
  totalContributors: number | null;
  firstCommitDate: number | null;
  latestCommitDate: number | null;
}

@customElement('gn-repository-health-dialog')
export class GnRepositoryHealthDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        width: 500px;
      }

      .content {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .stat-card {
        padding: 12px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .stat-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .stat-value {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .stat-value.warning {
        color: var(--color-warning);
      }

      .stat-value.success {
        color: var(--color-success);
      }

      .section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: 8px;
        border-bottom: 1px solid var(--color-border);
        padding-bottom: 8px;
      }

      .recommendations {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .recommendation {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border-left: 3px solid var(--color-warning);
      }

      .recommendation-icon {
        width: 16px;
        height: 16px;
        color: var(--color-warning);
        flex-shrink: 0;
        margin-top: 2px;
      }

      .recommendation-text {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .no-recommendations {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border-left: 3px solid var(--color-success);
        color: var(--color-success);
        font-size: var(--font-size-sm);
      }

      .actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .action-btn {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        cursor: pointer;
        transition: all var(--transition-fast);
        font-size: var(--font-size-sm);
      }

      .action-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        border-color: var(--color-primary);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .action-icon {
        width: 18px;
        height: 18px;
        color: var(--color-text-muted);
      }

      .action-info {
        flex: 1;
      }

      .action-title {
        font-weight: var(--font-weight-medium);
      }

      .action-desc {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: 2px;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px;
        color: var(--color-text-muted);
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 16px;
        border-top: 1px solid var(--color-border);
      }

      button.primary {
        background: var(--color-primary);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      button.primary:hover {
        opacity: 0.9;
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  @state() private loading = false;
  @state() private runningAction: string | null = null;
  @state() private stats: HealthStats | null = null;

  /**
   * Repo captured when the dialog opened. app-shell recreates this element on
   * every open, so connectedCallback IS the open moment. `repositoryPath` is
   * live-bound to the ACTIVE repository and rebinds the instant the user
   * Ctrl+Tabs — a document-level shortcut this dialog's overlay does not
   * block — while the stats on screen still describe the repo that was active
   * at open. Reading the live prop ran `git gc`/`git prune` against a
   * different repository than the one whose loose-object count justified it,
   * destroying unreachable objects the user never chose to expire.
   */
  private pinnedRepoPath = '';
  private unsubscribeRefOps?: () => void;
  /** Bumped by the ref-lock subscription; read by `repositoryBusy` so Lit
   * re-renders when another surface claims or releases this repo. */
  @state() private refOpsVersion = 0;

  /**
   * True while a working-tree operation holds this repo.
   *
   * Maintenance takes that lock too now (see maintenance-confirms.ts), so
   * without this the buttons would stay enabled and then refuse on click.
   */
  /**
   * True when an EXCLUSIVE maintenance claim would be refused.
   *
   * Mirrors tryAcquireMaintenance rather than just the ref lock. After the
   * claim was split into exclusive (gc/prune) and read-only (fsck), one shared
   * predicate described the wrong condition in BOTH directions: fsck greyed
   * out by a lock it deliberately does not take, and gc/prune left clickable
   * when they were going to refuse. A gate that does not mirror its own claim
   * is how "grey out rather than refuse on click" quietly stops holding.
   */
  private get maintenanceBlocked(): boolean {
    void this.refOpsVersion;
    return isMaintenanceBlocked(this.pinnedRepoPath);
  }

  /**
   * True while gc / prune / fsck is running. The host must refuse to close on
   * it: this dialog is inside an `${cond ? html : ''}` block, so dismissing it
   * DESTROYS the element rather than hiding it — an aggressive gc kept running
   * with no surface, and reopening built a fresh element with runningAction
   * null, re-enabling every button for a second concurrent gc on the same repo.
   */
  public get isRunning(): boolean {
    return this.runningAction !== null;
  }

  /**
   * The pinned repo's tab was closed while an action was in flight. We cannot
   * close now — that destroys the element and orphans the running gc — so
   * refuse any FURTHER action and dismiss as soon as the current one lands.
   * Without this the host's refusal merely deferred the problem: the dialog
   * stayed open pinned to a repo with no tab, and its guard
   * (`!pinnedRepoPath || runningAction`) happily allowed a second gc on it
   * once the first finished.
   */
  @state() private closePending = false;

  public closeWhenIdle(): void {
    if (!this.runningAction) {
      this.handleClose();
      return;
    }
    this.closePending = true;
  }

  /** Called from every action's finally: honour a deferred close. */
  private settleClosePending(): void {
    if (this.closePending && !this.runningAction) {
      this.closePending = false;
      this.handleClose();
    }
  }

  /**
   * The ONE way an action stops running.
   *
   * settleClosePending used to be wired only into the `finally` blocks, on the
   * assumption that the operation's own completion was the only exit from
   * "running". It is not: gc and prune claim `runningAction` BEFORE the confirm
   * (so a double-click cannot stack two warnings), and so they also clear it on
   * a declined confirm and on a lost claim race. Closing the pinned repo's tab
   * during that window left closePending stuck true with nothing running — the
   * dialog stayed open pinned to a repo with no tab, promising in a toast that
   * it would close, with every action button rendering enabled and silently
   * no-opping against the `closePending` guard.
   */
  private clearRunningAction(): void {
    this.runningAction = null;
    this.settleClosePending();
  }

  /** The repo this dialog is pinned to, for the host's tab-close sweep. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.pinnedRepoPath || null;
  }

  /**
   * The shared name the host's tab-close sweep reads. Aliases `isRunning` so
   * this dialog participates in the one sweep rather than a bespoke arm.
   */
  public get operationInFlight(): boolean {
    return this.isRunning;
  }

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
    this.pinnedRepoPath = this.repositoryPath;
    await this.loadHealthStats();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
  }

  private async loadHealthStats(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    this.loading = true;

    try {
      // Get repository statistics
      const [countResult, packsResult, branchesResult, tagsResult, stashesResult, repoStatsResult] = await Promise.all([
        gitService.getRepositoryStats(this.pinnedRepoPath),
        gitService.getPackInfo(this.pinnedRepoPath),
        gitService.getBranches(this.pinnedRepoPath),
        gitService.getTags(this.pinnedRepoPath),
        gitService.getStashes(this.pinnedRepoPath),
        gitService.getRepoStats(this.pinnedRepoPath, 10000),
      ]);

      // Calculate recommendations
      const recommendations: string[] = [];
      let looseObjectCount = 0;
      let totalObjects = 0;
      let sizeKb = 0;
      let packCount = 0;

      if (countResult.success && countResult.data) {
        totalObjects = countResult.data.count;
        looseObjectCount = countResult.data.loose;
        sizeKb = countResult.data.sizeKb;

        // Recommend GC if too many loose objects
        if (looseObjectCount > 500) {
          recommendations.push('Many loose objects detected. Running garbage collection will improve performance.');
        }
      }

      if (packsResult.success && packsResult.data) {
        packCount = packsResult.data.packCount;

        // Recommend repack if too many pack files
        if (packCount > 10) {
          recommendations.push('Multiple pack files detected. Repacking will consolidate data and save space.');
        }
      }

      const branchCount = branchesResult.success && branchesResult.data
        ? branchesResult.data.length
        : 0;

      // Recommend cleanup if many branches
      if (branchCount > 50) {
        recommendations.push('Many branches detected. Consider cleaning up merged branches.');
      }

      const tagCount = tagsResult.success && tagsResult.data
        ? tagsResult.data.length
        : 0;

      const stashCount = stashesResult.success && stashesResult.data
        ? stashesResult.data.length
        : 0;

      // Recommend stash cleanup if many stashes
      if (stashCount > 10) {
        recommendations.push('Many stashes detected. Consider cleaning up old stashes.');
      }

      // Extract overview stats
      const totalCommits = repoStatsResult.success && repoStatsResult.data
        ? repoStatsResult.data.totalCommits
        : null;
      const totalContributors = repoStatsResult.success && repoStatsResult.data
        ? repoStatsResult.data.totalContributors
        : null;
      const firstCommitDate = repoStatsResult.success && repoStatsResult.data
        ? repoStatsResult.data.firstCommitDate
        : null;
      const latestCommitDate = repoStatsResult.success && repoStatsResult.data
        ? repoStatsResult.data.latestCommitDate
        : null;

      this.stats = {
        objectCount: totalObjects,
        packCount,
        looseObjectCount,
        sizeKb,
        branchCount,
        tagCount,
        stashCount,
        lastGcDate: null, // Would need to check git logs
        recommendations,
        totalCommits,
        totalContributors,
        firstCommitDate,
        latestCommitDate,
      };
    } catch (error) {
      console.error('Failed to load health stats:', error);
      showToast('Failed to load repository health information', 'error');
    } finally {
      this.loading = false;
    }
  }

  private async runGc(aggressive: boolean): Promise<void> {
    if (!this.pinnedRepoPath || this.runningAction || this.closePending) return;

    // Checked BEFORE the confirm. The claim below is what actually
    // serialises, but taking it only after the prompt meant the user read a
    // full "this permanently deletes unreachable objects" warning, clicked
    // through it, and only then got told the run was refused.
    if (isMaintenanceBlocked(this.pinnedRepoPath)) {
      warnRepositoryBusy();
      return;
    }

    // Pinned before the confirm await: this dialog is bound to the active
    // repository and rebinds live on a tab switch.
    const repoPath = this.pinnedRepoPath;

    // Claimed BEFORE the confirm, not just checked. showConfirm is an IPC round
    // trip before the native dialog takes focus, and the button stays live
    // through it — so a double-click read and dismissed the same "permanently
    // deletes unreachable objects" warning twice for one gesture, the second
    // then refused by the cross-surface lock. Released on decline so a
    // declined run does not hold the slot.
    this.runningAction = aggressive ? 'gc-aggressive' : 'gc';

    // Same gate as the command palette (shared helper) — this dialog reaches
    // the identical irreversible command and must not be the unguarded route.
    if (!(await confirmGarbageCollection(aggressive))) {
      this.clearRunningAction();
      return;
    }

    // Shared with the command palette, which reaches these same three
    // commands: runningAction only ever covered THIS dialog, so a palette run
    // could start a second maintenance command against the same repo.
    if (!tryAcquireMaintenance(repoPath)) {
      this.clearRunningAction();
      warnRepositoryBusy();
      return;
    }

    try {
      const result = await gitService.runGc({
        path: repoPath,
        aggressive,
        // silent: the service toasts by default; this dialog owns the message.
        silent: true,
      });

      if (result.success) {
        showToast(aggressive ? 'Aggressive garbage collection completed' : 'Garbage collection completed', 'success');
        await this.loadHealthStats();
      } else {
        showToast(`Garbage collection failed: ${result.error?.message}`, 'error');
      }
    } finally {
      releaseMaintenance(repoPath);
      this.clearRunningAction();
    }
  }

  private async runFsck(): Promise<void> {
    if (!this.pinnedRepoPath || this.runningAction || this.closePending) return;

    // Checked BEFORE the confirm. The claim below is what actually
    // serialises, but taking it only after the prompt meant the user read a
    // full "this permanently deletes unreachable objects" warning, clicked
    // through it, and only then got told the run was refused.
    if (isMaintenanceRunning(this.pinnedRepoPath)) {
      warnRepositoryBusy();
      return;
    }

    const repoPath = this.pinnedRepoPath;
    // Shared with the command palette, which reaches these same three
    // commands: runningAction only ever covered THIS dialog, so a palette run
    // could start a second maintenance command against the same repo.
    // Read-only: fsck writes nothing, so it must not take the exclusive
    // working-tree lock — see tryAcquireMaintenanceReadOnly.
    if (!tryAcquireMaintenanceReadOnly(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.runningAction = 'fsck';

    try {
      const result = await gitService.runFsck({
        path: this.pinnedRepoPath,
        full: true,
        // silent: the service toasts by default; this dialog owns the message.
        silent: true,
      });

      if (result.success) {
        // `git fsck` exits 0 while reporting dangling/unreachable objects, so
        // show its actual output rather than asserting "no issues found" —
        // summarised, because that output can run to dozens of lines.
        showToast(summariseFsck(result.data?.message), 'success');
      } else {
        showToast(`File system check failed: ${result.error?.message}`, 'error');
      }
    } finally {
      releaseMaintenance(repoPath);
      this.clearRunningAction();
    }
  }

  private async runPrune(): Promise<void> {
    if (!this.pinnedRepoPath || this.runningAction || this.closePending) return;

    // Checked BEFORE the confirm. The claim below is what actually
    // serialises, but taking it only after the prompt meant the user read a
    // full "this permanently deletes unreachable objects" warning, clicked
    // through it, and only then got told the run was refused.
    if (isMaintenanceBlocked(this.pinnedRepoPath)) {
      warnRepositoryBusy();
      return;
    }

    const repoPath = this.pinnedRepoPath;

    // Claimed before the confirm — see runGc.
    this.runningAction = 'prune';

    if (!(await confirmPrune())) {
      this.clearRunningAction();
      return;
    }

    // Shared with the command palette, which reaches these same three
    // commands: runningAction only ever covered THIS dialog, so a palette run
    // could start a second maintenance command against the same repo.
    if (!tryAcquireMaintenance(repoPath)) {
      this.clearRunningAction();
      warnRepositoryBusy();
      return;
    }

    try {
      const result = await gitService.runPrune({
        path: repoPath,
        // silent: the service toasts by default; this dialog owns the message.
        silent: true,
      });

      if (result.success) {
        showToast('Pruned unreachable objects', 'success');
        await this.loadHealthStats();
      } else {
        showToast(`Prune failed: ${result.error?.message}`, 'error');
      }
    } finally {
      releaseMaintenance(repoPath);
      this.clearRunningAction();
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private formatSize(kb: number): string {
    if (kb < 1024) return `${kb} KB`;
    if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
    return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
  }

  render() {
    if (this.loading) {
      return html`
        <div class="loading">Loading repository health information...</div>
      `;
    }

    if (!this.stats) {
      return html`
        <div class="loading">Failed to load health information</div>
      `;
    }

    return html`
      <div class="content">
        <!-- Statistics -->
        <div>
          <div class="section-title">Repository Statistics</div>
          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-label">Total Commits</span>
              <span class="stat-value">${this.stats.totalCommits != null ? this.stats.totalCommits.toLocaleString() : '—'}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Contributors</span>
              <span class="stat-value">${this.stats.totalContributors != null ? this.stats.totalContributors.toLocaleString() : '—'}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Total Objects</span>
              <span class="stat-value">${this.stats.objectCount.toLocaleString()}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Repository Size</span>
              <span class="stat-value">${this.formatSize(this.stats.sizeKb)}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Loose Objects</span>
              <span class="stat-value ${this.stats.looseObjectCount > 500 ? 'warning' : ''}">${this.stats.looseObjectCount.toLocaleString()}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Pack Files</span>
              <span class="stat-value ${this.stats.packCount > 10 ? 'warning' : ''}">${this.stats.packCount}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Branches</span>
              <span class="stat-value">${this.stats.branchCount}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Tags</span>
              <span class="stat-value">${this.stats.tagCount}</span>
            </div>
          </div>
        </div>

        <!-- Recommendations -->
        <div>
          <div class="section-title">Recommendations</div>
          ${this.stats.recommendations.length > 0 ? html`
            <div class="recommendations">
              ${this.stats.recommendations.map(rec => html`
                <div class="recommendation">
                  <svg class="recommendation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span class="recommendation-text">${rec}</span>
                </div>
              `)}
            </div>
          ` : html`
            <div class="no-recommendations">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
              Repository is healthy - no maintenance needed
            </div>
          `}
        </div>

        <!-- Maintenance Actions -->
        <div>
          <div class="section-title">Maintenance Actions</div>
          <div class="actions">
            <button
              class="action-btn"
              @click=${() => this.runGc(false)}
              ?disabled=${!!this.runningAction || this.maintenanceBlocked}
            >
              <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              </svg>
              <div class="action-info">
                <div class="action-title">
                  ${this.runningAction === 'gc' ? 'Running...' : 'Garbage Collection'}
                </div>
                <div class="action-desc">Clean up loose objects and optimize repository</div>
              </div>
            </button>

            <button
              class="action-btn"
              @click=${() => this.runGc(true)}
              ?disabled=${!!this.runningAction || this.maintenanceBlocked}
            >
              <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div class="action-info">
                <div class="action-title">
                  ${this.runningAction === 'gc-aggressive' ? 'Running...' : 'Aggressive GC'}
                </div>
                <div class="action-desc">Thorough cleanup - may take longer</div>
              </div>
            </button>

            <button
              class="action-btn"
              @click=${this.runFsck}
              ?disabled=${!!this.runningAction || isMaintenanceRunning(this.pinnedRepoPath)}
            >
              <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="12" y1="18" x2="12" y2="12"></line>
                <line x1="9" y1="15" x2="15" y2="15"></line>
              </svg>
              <div class="action-info">
                <div class="action-title">
                  ${this.runningAction === 'fsck' ? 'Running...' : 'File System Check'}
                </div>
                <div class="action-desc">Verify repository integrity</div>
              </div>
            </button>

            <button
              class="action-btn"
              @click=${this.runPrune}
              ?disabled=${!!this.runningAction || this.maintenanceBlocked}
            >
              <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <div class="action-info">
                <div class="action-title">
                  ${this.runningAction === 'prune' ? 'Running...' : 'Prune Unreachable Objects'}
                </div>
                <div class="action-desc">Remove orphaned objects not reachable from any ref</div>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div class="footer">
        <!-- Disabled while an action runs: the host refuses to close mid-gc
             (closing destroys this element and would orphan the operation), so
             an enabled Done was a button that silently did nothing. NOT gated
             on repositoryBusy: Done destroys nothing, and greying it out
             because something elsewhere touched the repo kills the button the
             user aims at for a reason that has nothing to do with it — the
             same copy-paste reverted on gn-clean-dialog's Cancel. -->
        <button
          class="primary"
          ?disabled=${!!this.runningAction}
          @click=${this.handleClose}
        >Done</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-repository-health-dialog': GnRepositoryHealthDialog;
  }
}
