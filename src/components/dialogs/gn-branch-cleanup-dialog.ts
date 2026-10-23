/**
 * Branch Cleanup Dialog Component
 * Provides a unified dialog for cleaning up merged, stale, and gone-upstream branches
 * with risk assessment and branch protection checks.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, property, query } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import type { Branch, CleanupCandidate } from '../../types/git.types.ts';
import './gn-modal.ts';
import type { GnModal } from './gn-modal.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  RefLockController,
} from '../../utils/ref-lock.ts';

type CleanupTab = 'merged' | 'stale' | 'gone';
type RiskLevel = 'safe' | 'warning' | 'danger';

interface CleanupBranch {
  branch: Branch;
  risk: RiskLevel;
  riskReason: string;
  isProtected: boolean;
  protectedReason?: string;
}

const BUILTIN_PROTECTED = ['main', 'master', 'develop', 'development', 'staging', 'production'];

/** Most branch names spelled out in the delete confirm; the rest collapse to a count. */
const MAX_CONFIRM_NAMES = 10;

@customElement('gn-branch-cleanup-dialog')
export class GnBranchCleanupDialog extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .tabs {
        display: flex;
        border-bottom: 1px solid var(--color-border);
        padding: 0 var(--spacing-md);
        gap: 0;
      }

      .tab {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: all var(--transition-fast);
      }

      .tab:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .tab.active {
        color: var(--color-primary);
        border-bottom-color: var(--color-primary);
      }

      .tab-badge {
        font-size: 10px;
        font-weight: var(--font-weight-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .tab.active .tab-badge {
        background: var(--color-primary-bg);
        color: var(--color-primary);
      }

      .content-area {
        min-width: 500px;
        min-height: 300px;
        max-height: 400px;
        overflow-y: auto;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        gap: var(--spacing-sm);
      }

      .empty-state svg {
        width: 32px;
        height: 32px;
        opacity: 0.5;
      }

      .select-all {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .select-all label {
        cursor: pointer;
        user-select: none;
      }

      .select-all input[type="checkbox"] {
        accent-color: var(--color-primary);
      }

      .branch-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .branch-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: var(--font-size-sm);
        border-bottom: 1px solid var(--color-border-light, var(--color-border));
      }

      .branch-item:last-child {
        border-bottom: none;
      }

      .branch-item.protected {
        opacity: 0.5;
      }

      .branch-item input[type="checkbox"] {
        flex-shrink: 0;
        accent-color: var(--color-primary);
      }

      .branch-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .branch-name {
        font-weight: var(--font-weight-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .branch-detail {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .risk-badge {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        padding: 2px 8px;
        border-radius: var(--radius-full);
      }

      .risk-badge.safe {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .risk-badge.warning {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .risk-badge.danger {
        background: var(--color-error-bg, var(--color-warning-bg));
        color: var(--color-error);
      }

      .risk-badge svg {
        width: 12px;
        height: 12px;
      }

      .protected-badge {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--color-bg-tertiary);
      }

      .protected-badge svg {
        width: 12px;
        height: 12px;
      }

      .footer-content {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        gap: var(--spacing-md);
      }

      .footer-summary {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .footer-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .btn-danger {
        background: var(--color-error);
        color: var(--color-text-inverse, #fff);
      }

      .btn-danger:hover:not(:disabled) {
        opacity: 0.9;
      }

      .prune-option {
        display: flex;
        align-items: center;
        padding: var(--spacing-xs) var(--spacing-md);
        border-top: 1px solid var(--color-border);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .prune-option label {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        cursor: pointer;
        user-select: none;
      }

      .prune-option input[type="checkbox"] {
        accent-color: var(--color-primary);
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  /**
   * Observe the shared working-tree lock, not just claim it.
   *
   * The handlers below already refuse when another surface holds the lock, but
   * the action buttons were bound to this dialog's own flag alone — so while a
   * checkout, reset or gc ran elsewhere they stayed lit and did nothing except
   * raise a refusal toast.
   */
  private lock = new RefLockController(this, () => this.pinnedRepoPath || this.repositoryPath);

  /** The repo this dialog was opened for, captured at open(). repositoryPath is
   * bound live to the active tab, so a tab switch while the modal is open would
   * otherwise make the irreversible force-deletes / remote prune target the
   * wrong repo. */
  private pinnedRepoPath = '';
  private isOpen = false;

  /** The pinned repo while the dialog is open, else null — lets the host
   * self-close the dialog when that repo's tab is closed (a Delete on a closed
   * repo would otherwise force-delete branches in a repo not in the tab bar). */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /**
   * True while the force-delete + prune loop is running. `handleModalClose()`
   * re-asserts the modal open on this; the host's tab-close sweep must consult
   * it too, because `close()` bypasses that guard.
   */
  public get operationInFlight(): boolean {
    return this.deleting;
  }

  @state() private loading = true;
  /** The candidate scan failed — render that, not "nothing to clean up". */
  @state() private loadFailed = false;
  @state() private mergedBranches: CleanupBranch[] = [];
  @state() private staleBranches: CleanupBranch[] = [];
  @state() private goneUpstreamBranches: CleanupBranch[] = [];
  @state() private selectedBranches = new Set<string>();
  @state() private activeTab: CleanupTab = 'merged';
  @state() private deleting = false;
  @state() private pruneRemotes = true;

  @query('gn-modal') private modal!: GnModal;

  public async open(): Promise<void> {
    // Re-entry while a delete loop is running would reset() away `deleting`
    // (re-enabling the Delete button mid-flight, so a second concurrent loop
    // can start), clear the selection, and re-pin pinnedRepoPath from the live
    // prop. The command palette can dispatch open-branch-cleanup over the open
    // modal, so this is reachable.
    if (this.deleting) return;

    this.reset();
    this.pinnedRepoPath = this.repositoryPath;
    this.isOpen = true;
    this.modal.open = true;
    await this.loadCleanupData();
  }

  public close(): void {
    this.isOpen = false;
    this.modal.open = false;
  }

  private reset(): void {
    this.loading = true;
    this.mergedBranches = [];
    this.staleBranches = [];
    this.goneUpstreamBranches = [];
    this.selectedBranches = new Set();
    this.activeTab = 'merged';
    this.deleting = false;
    this.pruneRemotes = true;
  }

  private async loadCleanupData(preserveSelection = false): Promise<void> {
    this.loading = true;

    try {
      const { staleBranchDays } = settingsStore.getState();
      const result = await gitService.getCleanupCandidates(
        this.pinnedRepoPath,
        staleBranchDays,
      );

      if (!result.success || !result.data) {
        showToast('Failed to load cleanup candidates', 'error');
        // Distinct from "no candidates": leaving the three lists empty made
        // every tab assert "No merged branches found", i.e. claim there is
        // nothing to clean up when the scan simply could not tell us. The
        // sidebar badge stopped telling that lie; the surface it opens must
        // not repeat it.
        this.loadFailed = true;
        this.loading = false;
        return;
      }
      this.loadFailed = false;

      // Build CleanupBranch entries from backend candidates
      const merged: CleanupBranch[] = [];
      const stale: CleanupBranch[] = [];
      const gone: CleanupBranch[] = [];

      // Group by branch name FIRST. The backend emits the same branch once per
      // category it qualifies for (merged AND stale is common for an old
      // finished feature branch), but risk is a property of the BRANCH, not of
      // the tab it happens to be listed under. Assessing each entry separately
      // gave one branch two different badges — green on Merged, amber on Stale
      // — and let the delete gate fire on a label the deletion path had already
      // deduplicated away.
      const byName = new Map<string, CleanupCandidate[]>();
      for (const candidate of result.data) {
        const group = byName.get(candidate.name);
        if (group) {
          group.push(candidate);
        } else {
          byName.set(candidate.name, [candidate]);
        }
      }

      for (const candidate of result.data) {
        const branch: Branch = {
          name: candidate.name,
          shorthand: candidate.shorthand,
          isHead: false,
          isRemote: false,
          upstream: candidate.upstream,
          targetOid: '',
          aheadBehind: candidate.aheadBehind ?? undefined,
          lastCommitTimestamp: candidate.lastCommitTimestamp ?? undefined,
          isStale: candidate.category === 'stale',
        };

        const isProtected = candidate.isProtected || this.isBuiltinProtected(candidate.name);
        const protectedReason = isProtected ? this.getProtectedReason(candidate) : undefined;
        const risk = this.assessRisk(byName.get(candidate.name)!);

        const entry: CleanupBranch = {
          branch,
          ...risk,
          isProtected,
          protectedReason,
        };

        switch (candidate.category) {
          case 'merged':
            merged.push(entry);
            break;
          case 'stale':
            stale.push(entry);
            break;
          case 'gone':
            gone.push(entry);
            break;
        }
      }

      this.mergedBranches = merged;
      this.staleBranches = stale;
      this.goneUpstreamBranches = gone;

      if (preserveSelection) {
        // Reload of an ALREADY-OPEN dialog. Auto-select must not run: it only
        // ever adds, so it would silently re-check a branch the user
        // deliberately unchecked, and the delete confirm names the snapshot it
        // is about to delete — a silently re-checked branch would be listed
        // there but was never chosen. Keep exactly what the user chose, minus
        // anything no longer listed.
        const stillListed = new Set(
          [...this.mergedBranches, ...this.staleBranches, ...this.goneUpstreamBranches].map(
            (cb) => cb.branch.name,
          ),
        );
        this.selectedBranches = new Set(
          [...this.selectedBranches].filter((name) => stillListed.has(name)),
        );
      } else {
        // Auto-select safe branches in merged and gone categories
        for (const cb of this.mergedBranches) {
          if (!cb.isProtected && cb.risk === 'safe') {
            this.selectedBranches.add(cb.branch.name);
          }
        }
        for (const cb of this.goneUpstreamBranches) {
          if (!cb.isProtected && cb.risk === 'safe') {
            this.selectedBranches.add(cb.branch.name);
          }
        }
        // Don't auto-select stale branches (they require more deliberate action)
      }

      // Select the first non-empty tab — only on a fresh open(). On a reload
      // the user is mid-task on a tab they chose; snapping back to 'merged'
      // showed them an empty selection while the footer still counted it, and
      // the next Delete would act on branches they could not see.
      if (!preserveSelection) {
        if (this.mergedBranches.length > 0) {
          this.activeTab = 'merged';
        } else if (this.staleBranches.length > 0) {
          this.activeTab = 'stale';
        } else if (this.goneUpstreamBranches.length > 0) {
          this.activeTab = 'gone';
        }
      }

      this.requestUpdate();
    } catch (err) {
      console.error('Failed to load cleanup data:', err);
      showToast('Failed to load cleanup data', 'error');
    } finally {
      this.loading = false;
    }
  }

  /**
   * Canonical risk for a branch, computed from EVERY category the backend
   * listed it under.
   *
   * Takes the whole group rather than one entry because the backend emits a
   * branch once per qualifying category, and risk belongs to the branch: a
   * branch that is both merged and stale is still merged, and deleting it
   * loses nothing.
   */
  private assessRisk(group: CleanupCandidate[]): { risk: RiskLevel; riskReason: string } {
    // The backend proved this merged — HEAD descends from its tip, or the two
    // are equal (branch_cleanup.rs). Every commit on it is therefore reachable
    // from HEAD and deleting the ref loses nothing. That proof outranks any
    // upstream comparison, measured or missing: `ahead` counts distance from
    // the UPSTREAM, which says nothing about whether local deletion loses work.
    if (group.some((c) => c.category === 'merged')) {
      return { risk: 'safe', riskReason: 'Fully merged into current branch' };
    }

    // branch_cleanup.rs computes ahead_behind once per branch and clones it
    // into every category entry, so any entry of the group carries it.
    const candidate = group[0];

    // aheadBehind is null when divergence could not be measured at all — a
    // branch that neither tracks an upstream nor is "gone". Coercing that to 0
    // would claim "fully merged" about work we simply cannot see.
    if (!candidate.aheadBehind) {
      return {
        risk: 'warning',
        riskReason: candidate.upstream
          ? 'Unpushed work unknown — no upstream comparison available'
          : 'No upstream configured — may contain unmerged work',
      };
    }

    const ahead = candidate.aheadBehind.ahead;
    const isGone = group.some((c) => c.category === 'gone');

    if (ahead === 0) {
      // A 'gone' branch with ahead === 0 is measured against HEAD, so it is
      // also emitted as 'merged' and the early return above already fired —
      // reaching here always means "nothing left to push to the upstream".
      return { risk: 'safe', riskReason: 'No unpushed work' };
    }

    if (isGone) {
      return {
        risk: 'danger',
        riskReason: `Remote deleted with ${ahead} unpushed commit${ahead !== 1 ? 's' : ''}`,
      };
    }

    return {
      risk: 'warning',
      riskReason: `Has ${ahead} unpushed commit${ahead !== 1 ? 's' : ''}`,
    };
  }

  private isBuiltinProtected(name: string): boolean {
    return BUILTIN_PROTECTED.includes(name);
  }

  private getProtectedReason(candidate: CleanupCandidate): string {
    if (BUILTIN_PROTECTED.includes(candidate.shorthand)) return 'Built-in protected branch';
    if (candidate.isProtected) return 'Protected by branch rule';
    return 'Protected';
  }

  private getActiveTabBranches(): CleanupBranch[] {
    switch (this.activeTab) {
      case 'merged':
        return this.mergedBranches;
      case 'stale':
        return this.staleBranches;
      case 'gone':
        return this.goneUpstreamBranches;
    }
  }

  private getSelectableBranches(): CleanupBranch[] {
    return this.getActiveTabBranches().filter((cb) => !cb.isProtected);
  }

  private isAllSelected(): boolean {
    const selectable = this.getSelectableBranches();
    if (selectable.length === 0) return false;
    return selectable.every((cb) => this.selectedBranches.has(cb.branch.name));
  }

  private handleSelectAll(): void {
    const selectable = this.getSelectableBranches();
    const allSelected = this.isAllSelected();

    if (allSelected) {
      for (const cb of selectable) {
        this.selectedBranches.delete(cb.branch.name);
      }
    } else {
      for (const cb of selectable) {
        this.selectedBranches.add(cb.branch.name);
      }
    }
    this.requestUpdate();
  }

  private handleToggleBranch(branchName: string): void {
    if (this.selectedBranches.has(branchName)) {
      this.selectedBranches.delete(branchName);
    } else {
      this.selectedBranches.add(branchName);
    }
    this.requestUpdate();
  }

  private handleTabChange(tab: CleanupTab): void {
    this.activeTab = tab;
  }

  private get totalSelected(): number {
    // Derived from the branches actually listed, not the raw Set: after a
    // reload the Set can hold names that are no longer candidates, and a
    // Delete click on those would run an empty loop and report nothing.
    return this.selectedForDeletion().length;
  }

  /**
   * The selected branches, one entry per branch.
   *
   * Single source of truth for the delete flow: the confirm gate, the confirm
   * text, and the force flag are all derived from THIS list. Deriving the gate
   * from the un-deduplicated union while the message used the deduplicated set
   * let them disagree, producing a confirm with an empty clause.
   */
  private selectedForDeletion(): CleanupBranch[] {
    const allBranches = [
      ...this.mergedBranches,
      ...this.staleBranches,
      ...this.goneUpstreamBranches,
    ];

    const selectedMap = new Map<string, CleanupBranch>();
    for (const cb of allBranches) {
      if (this.selectedBranches.has(cb.branch.name) && !selectedMap.has(cb.branch.name)) {
        selectedMap.set(cb.branch.name, cb);
      }
    }
    return Array.from(selectedMap.values());
  }

  private async handleDelete(): Promise<void> {
    // The prune is a tail step of THIS handler, so returning here whenever
    // nothing is selected made a ticked "Also prune remote tracking branches"
    // unrunnable — and it is ticked by default. That is the exact state the
    // dialog exists for: a repo whose upstreams were deleted server-side shows
    // "No branches with deleted upstreams found" precisely because the prune
    // that would reveal them has not run.
    if (this.deleting) return;
    if (this.totalSelected === 0 && !this.pruneRemotes) return;
    // Claimed BEFORE the confirm, not after. showConfirm is an IPC round trip
    // before the native dialog opens and takes focus, and the button stays
    // enabled through that window — so a double-click stacked two prompts for
    // the same target and, if both were accepted, ran the operation twice.
    // Same claim-before-confirm the abort banner and the clean dialog use.
    //
    // `deleting` only guards THIS dialog. The sidebar lists and the graph menu
    // gate on the shared working-tree lock, so without claiming it a checkout
    // of a branch this loop is about to delete stayed clickable. Held across
    // the WHOLE loop, not per branch: what is being serialized is the
    // repository's working tree, not an individual ref.
    const lockedRepo = this.pinnedRepoPath;
    if (!tryAcquireRefOp(lockedRepo)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.deleting = true;

    const toDelete = this.selectedForDeletion();

    // Confirm the exact snapshot this invocation will delete. Safe branches
    // still remove refs and may be difficult to recover, so they need the same
    // explicit count/scope gate as risky branches.
    const risky = toDelete.filter((cb) => cb.risk === 'warning' || cb.risk === 'danger');

    if (toDelete.length > 0) {
      const unpushed = risky.filter((cb) => (cb.branch.aheadBehind?.ahead ?? 0) > 0).length;
      const unknown = risky.length - unpushed;
      const parts: string[] = [];
      if (unpushed > 0) {
        parts.push(
          `${unpushed} ${unpushed === 1 ? 'has' : 'have'} unpushed commits that will be lost`,
        );
      }
      if (unknown > 0) {
        parts.push(
          `${unknown} could not be checked for unmerged work (no upstream to compare against)`,
        );
      }
      const count = toDelete.length;
      // Cap the enumeration. Open auto-selects every safe merged and gone
      // branch, so on the long-lived repo this dialog exists for the list is
      // routinely dozens of refs — enough to push the loss warning and the
      // final question off the bottom of a native message dialog. The count
      // above already carries the exact scope; the names are orientation.
      //
      // Risky branches are listed FIRST so the cap drops safe names before
      // risky ones; only a selection holding more than MAX_CONFIRM_NAMES risky
      // branches can truncate a name the loss clause is about. Slicing
      // `toDelete` in its own order put the auto-selected safe merged/gone
      // branches at the front, so the very branches the loss clause is about
      // were the ones collapsed into "and N more" — the user was told commits
      // would be destroyed and never told which branch carried them. `risk` is
      // exactly 'safe' | 'warning' | 'danger', so these two halves partition
      // `toDelete` with no duplicates and `count` is unchanged.
      const ordered = [...risky, ...toDelete.filter((cb) => cb.risk === 'safe')];
      const shown = ordered.slice(0, MAX_CONFIRM_NAMES).map((cb) => cb.branch.name);
      const names =
        count > MAX_CONFIRM_NAMES
          ? `${shown.join(', ')}, and ${count - MAX_CONFIRM_NAMES} more`
          : shown.join(', ');
      const riskSummary =
        parts.length > 0
          ? `\n\nOf ${count === 1 ? 'this branch' : 'these branches'}, ${parts.join(', and ')}.`
          : count === 1
            ? '\n\nThis branch was reported as fully merged or otherwise safe to delete.'
            : '\n\nAll selected branches were reported as fully merged or otherwise safe to delete.';
      const pruneSummary = this.pruneRemotes
        ? '\n\nRemote-tracking branches will also be pruned.'
        : '';

      // Risk clause BEFORE the name list: the list is the part that can grow
      // without bound, so anything after it is what a clipped dialog hides.
      const confirmed = await showConfirm(
        `Delete ${count} Local Branch${count === 1 ? '' : 'es'}?`,
        `${count} selected local branch${count === 1 ? '' : 'es'} will be deleted.` +
          riskSummary +
          `\n\n${names}.` +
          pruneSummary +
          '\n\nThis action cannot be undone. Continue?',
        'warning',
      );
      if (!confirmed) {
        this.deleting = false;
        releaseRefOp(lockedRepo);
        return;
      }
    }

    let deleted = 0;
    let failed = 0;
    let kept = 0;
    const failures: string[] = [];

    // Pinned at open(): these irreversible force-deletes and the remote prune
    // must target the repo the cleanup was invoked on, even if the user
    // switches tabs during the confirm or across the delete loop's awaits
    // (which rebinds the live repositoryPath prop).
    const repoPath = this.pinnedRepoPath;
    // Branches the backend refused as unmerged. Force was withheld because we
    // could not measure their divergence, so the refusal is the SAFE outcome —
    // but leaving it there strands the user with an error telling them to force
    // and no way to do it. Collect them and offer one escalation below.
    const unmergedRefusals: CleanupBranch[] = [];

    for (const cb of toDelete) {
      // NEVER force a branch the dialog labelled Safe. Two reasons: a merged
      // branch deletes fine without force, and withholding force keeps
      // delete_branch's merged-check, which is the only thing that catches the
      // label having gone stale (an external reset or checkout while this modal
      // sat open). The confirm above no longer distinguishes safe from risky,
      // so it is not what protects this.
      //
      // Among risky branches, force only on MEASURED unpushed commits. Deriving
      // it from the label alone would force-delete a branch labelled 'warning'
      // precisely BECAUSE its divergence could not be measured, turning the
      // backend's safe refusal into permanent commit loss.
      const force =
        cb.risk !== 'safe' &&
        (cb.risk === 'danger' || (cb.branch.aheadBehind?.ahead ?? 0) > 0);
      const result = await gitService.deleteBranch(repoPath, cb.branch.name, force);
      if (result.success) {
        deleted++;
      } else if (!force && /not fully merged/i.test(result.error?.message ?? '')) {
        unmergedRefusals.push(cb);
      } else {
        failed++;
        // Keep the reason: a bare "Failed to delete N branches" leaves the user
        // with no idea why and no way forward.
        failures.push(`${cb.branch.name}: ${result.error?.message ?? 'unknown error'}`);
        console.error(`Failed to delete ${cb.branch.name}:`, result.error);
      }
    }

    // Escalation, mirroring the sidebar's force path (gn-branch-list.ts): the
    // user already confirmed the delete, so ask once about the subset git
    // refused rather than reporting a failure they cannot act on.
    if (unmergedRefusals.length > 0) {
      // State each branch's ACTUAL exposure. "not fully merged" is measured
      // against HEAD, while the Safe/Warning badge is measured against the
      // UPSTREAM, so this set mixes three genuinely different situations and a
      // single blanket sentence is wrong for two of them:
      //   - no upstream at all  -> the commits exist on no other ref (total loss)
      //   - upstream, ahead === 0 -> the commits are on the remote (recoverable)
      //   - upstream, unmeasured  -> unknown; never coerce that to "pushed"
      // Overstating trains users to dismiss confirms; understating loses work.
      const names = unmergedRefusals
        .map((cb) => {
          const { upstream, aheadBehind } = cb.branch;
          if (upstream && aheadBehind && aheadBehind.ahead === 0) {
            return `${cb.branch.name} (pushed to ${upstream})`;
          }
          if (!upstream) {
            return `${cb.branch.name} (no remote copy)`;
          }
          // Measured and non-zero: say how much is at risk rather than
          // falling through to "unknown", which understates a loss we can
          // quantify. Reachable when the Safe label went stale (e.g. an
          // external reset while this modal sat open) and the backend then
          // refused the delete — exactly the case the withheld force exists
          // to catch.
          if (aheadBehind && aheadBehind.ahead > 0) {
            const n = aheadBehind.ahead;
            return `${cb.branch.name} (${n} commit${n === 1 ? '' : 's'} not on ${upstream})`;
          }
          return `${cb.branch.name} (unpushed work unknown)`;
        })
        .join(', ');
      const plural = unmergedRefusals.length !== 1;
      const anyWithoutRemoteCopy = unmergedRefusals.some(
        (cb) => !cb.branch.upstream || !cb.branch.aheadBehind || cb.branch.aheadBehind.ahead > 0,
      );
      // showConfirm is the only throw source inside the `deleting` window
      // (invokeCommand never throws). An unhandled rejection here would unwind
      // with `deleting` stuck true, and since open() refuses to re-show the
      // dialog while that is set, Branch Cleanup would be dead for the rest of
      // the session with no error anywhere. Treat a failed prompt as declined.
      let forceConfirmed = false;
      try {
        forceConfirmed = await showConfirm(
        'Branches Not Fully Merged',
        `${unmergedRefusals.length} branch${plural ? 'es' : ''} (${names}) ` +
          `${plural ? 'are' : 'is'} not merged into the current branch.\n\n` +
          (anyWithoutRemoteCopy
            ? `Commits that are not on a remote will be discarded permanently and ` +
              `cannot be recovered.`
            : `Their commits are on their upstreams, so the branches can be restored ` +
              `from the remote.`) +
          `\n\nForce delete anyway?`,
        'warning',
        );
      } catch {
        forceConfirmed = false;
      }

      for (const cb of unmergedRefusals) {
        if (!forceConfirmed) {
          // Declining is the safe choice the dialog just offered — counting it
          // as a failure would report the user's own decision back to them as
          // a red error.
          kept++;
          continue;
        }
        const retry = await gitService.deleteBranch(repoPath, cb.branch.name, true);
        if (retry.success) {
          deleted++;
        } else {
          failed++;
          failures.push(`${cb.branch.name}: ${retry.error?.message ?? 'unknown error'}`);
        }
      }
    }

    // Prune remote tracking branches if requested.
    //
    // invokeCommand NEVER throws — it resolves to { success: false, error } —
    // so a try/catch here is dead code and the outcome must be read off the
    // result. Without that, an offline or auth-failed prune reported success.
    let pruned = false;
    if (this.pruneRemotes) {
      const pruneResult = await gitService.pruneRemoteTrackingBranches(repoPath);
      // Ok with an empty list means there was nothing to prune — reporting
      // "remotes pruned" for that overstates, and it forced a reload after
      // every zero-delete attempt.
      pruned = pruneResult.success && (pruneResult.data?.branchesPruned.length ?? 0) > 0;
      if (!pruneResult.success && !gitService.isNetworkGateRefusal(pruneResult.error)) {
        showToast(
          `Failed to prune remote branches: ${pruneResult.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
    }

    this.deleting = false;
    releaseRefOp(lockedRepo);

    // ONE composite message covering every combination. Reporting deleted /
    // failed / kept in mutually exclusive branches silently dropped whichever
    // outcomes did not match the arm that fired — e.g. a branch the user chose
    // to keep went unmentioned whenever any other branch also failed, so they
    // reasonably concluded it had been deleted.
    // `pruned` is gated on the actual prune result, not on the checkbox.
    const notes: string[] = [];
    if (deleted > 0) notes.push(`Deleted ${deleted} branch${deleted !== 1 ? 'es' : ''}`);
    if (failed > 0) notes.push(`${failed} failed — ${failures.join('; ')}`);
    if (kept > 0) notes.push(`${kept} kept (not fully merged)`);
    if (pruned) notes.push('remotes pruned');

    if (notes.length > 0) {
      showToast(notes.join(', '), failed > 0 ? 'error' : kept > 0 ? 'warning' : 'success');
    }

    // The prune mutates the repo on its own, so the refresh must fire for it
    // too — not only when a branch was deleted. Otherwise the sidebar keeps
    // listing remote-tracking refs that no longer exist.
    if (deleted > 0 || pruned) {
      this.dispatchEvent(
        new CustomEvent('cleanup-complete', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }),
      );
    }

    if (deleted > 0) {
      this.close();
      return;
    }

    // The dialog stays open, so refresh what it shows. A successful prune
    // removes remote-tracking refs that the risk badges and the Gone Upstream
    // tab are derived from, and a failure may have been caused by state that
    // has since changed — either way the list on screen is no longer what the
    // next Delete click would act on.
    if (pruned || failed > 0) {
      await this.loadCleanupData(true);
    }
  }

  private handleModalClose(): void {
    // Cancel is disabled while deleting; Escape, the overlay and the × must
    // honour the same rule. Dismissing mid-loop left it force-deleting and
    // pruning with no visible surface, and open() now refuses to re-show the
    // dialog while `deleting`, so the user could not get back to it.
    if (this.deleting) {
      this.modal.open = true;
      return;
    }

    this.isOpen = false;
    this.reset();
  }

  private formatTimeAgo(timestamp: number): string {
    const daysAgo = Math.floor((Date.now() / 1000 - timestamp) / (24 * 60 * 60));
    if (daysAgo < 1) return 'today';
    if (daysAgo === 1) return '1 day ago';
    if (daysAgo < 30) return `${daysAgo} days ago`;
    const months = Math.floor(daysAgo / 30);
    if (months === 1) return '1 month ago';
    if (months < 12) return `${months} months ago`;
    const years = Math.floor(months / 12);
    return years === 1 ? '1 year ago' : `${years} years ago`;
  }

  private renderTab(tab: CleanupTab, label: string, count: number) {
    return html`
      <button
        class="tab ${this.activeTab === tab ? 'active' : ''}"
        @click=${() => this.handleTabChange(tab)}
      >
        ${label}
        <span class="tab-badge">${count}</span>
      </button>
    `;
  }

  private renderRiskBadge(risk: RiskLevel, reason: string) {
    const icons = {
      safe: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      warning: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
      danger: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    };

    return html`
      <span class="risk-badge ${risk}" title=${reason}>
        ${icons[risk]}
        ${risk === 'safe' ? 'Safe' : risk === 'warning' ? 'Warning' : 'Danger'}
      </span>
    `;
  }

  private renderBranchItem(cb: CleanupBranch) {
    const { branch, risk, riskReason, isProtected, protectedReason } = cb;
    const isSelected = this.selectedBranches.has(branch.name);

    const detail = branch.lastCommitTimestamp
      ? `Last commit: ${this.formatTimeAgo(branch.lastCommitTimestamp)}`
      : '';

    return html`
      <li class="branch-item ${isProtected ? 'protected' : ''}">
        <input
          type="checkbox"
          .checked=${isSelected}
          ?disabled=${isProtected || this.deleting}
          @change=${() => this.handleToggleBranch(branch.name)}
          aria-label="Select ${branch.shorthand}"
        />
        <div class="branch-info">
          <span class="branch-name">${branch.shorthand}</span>
          ${detail ? html`<span class="branch-detail">${detail}</span>` : nothing}
          ${riskReason && !isProtected
            ? html`<span class="branch-detail">${riskReason}</span>`
            : nothing}
        </div>
        ${isProtected
          ? html`
              <span class="protected-badge" title=${protectedReason ?? 'Protected'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0110 0v4"></path>
                </svg>
                Protected
              </span>
            `
          : this.renderRiskBadge(risk, riskReason)}
      </li>
    `;
  }

  private renderBranchList(branches: CleanupBranch[]) {
    if (this.loadFailed) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>Could not load cleanup candidates</span>
          <button class="btn btn-secondary" @click=${() => void this.loadCleanupData()}>
            Retry
          </button>
        </div>
      `;
    }

    if (branches.length === 0) {
      const messages: Record<CleanupTab, string> = {
        merged: 'No merged branches found',
        stale: 'No stale branches found',
        gone: 'No branches with deleted upstreams found',
      };

      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>${messages[this.activeTab]}</span>
        </div>
      `;
    }

    const selectable = branches.filter((cb) => !cb.isProtected);
    const allSelected = this.isAllSelected();

    return html`
      ${selectable.length > 0
        ? html`
            <div class="select-all">
              <input
                type="checkbox"
                .checked=${allSelected}
                @change=${this.handleSelectAll}
                ?disabled=${this.deleting}
                id="select-all-checkbox"
              />
              <label for="select-all-checkbox">
                ${allSelected ? 'Deselect all' : 'Select all'} (${selectable.length})
              </label>
            </div>
          `
        : nothing}
      <ul class="branch-list">
        ${branches.map((cb) => this.renderBranchItem(cb))}
      </ul>
    `;
  }

  render() {
    return html`
      <gn-modal modalTitle="Branch Cleanup" @close=${this.handleModalClose}>
        <div class="tabs">
          ${this.renderTab('merged', 'Merged', this.mergedBranches.length)}
          ${this.renderTab('stale', 'Stale', this.staleBranches.length)}
          ${this.renderTab('gone', 'Gone Upstream', this.goneUpstreamBranches.length)}
        </div>

        <div class="content-area">
          ${this.loading
            ? html`<div class="loading">Loading branches...</div>`
            : this.renderBranchList(this.getActiveTabBranches())}
        </div>

        <div class="prune-option">
          <label>
            <input
              type="checkbox"
              .checked=${this.pruneRemotes}
              @change=${(e: Event) => { this.pruneRemotes = (e.target as HTMLInputElement).checked; }}
              ?disabled=${this.deleting}
            />
            Also prune remote tracking branches
          </label>
        </div>

        <div slot="footer">
          <div class="footer-content">
            <span class="footer-summary">
              ${this.totalSelected > 0
                ? `${this.totalSelected} branch${this.totalSelected !== 1 ? 'es' : ''} selected`
                : 'No branches selected'}
            </span>
            <div class="footer-actions">
              <button class="btn btn-secondary" @click=${this.close} ?disabled=${this.deleting}>
                Cancel
              </button>
              <button
                class="btn btn-danger"
                @click=${this.handleDelete}
                ?disabled=${(this.totalSelected === 0 && !this.pruneRemotes) ||
                this.deleting ||
                this.loading ||
                this.lock.busy}
              >
                ${this.deleting
                  ? 'Working...'
                  : this.totalSelected === 0
                    ? 'Prune Remotes'
                    : `Delete Selected (${this.totalSelected})`}
              </button>
            </div>
          </div>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-branch-cleanup-dialog': GnBranchCleanupDialog;
  }
}
