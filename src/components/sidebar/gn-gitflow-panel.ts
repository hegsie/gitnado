/**
 * Git Flow Panel Component
 * Displays git flow status and provides controls for feature/release/hotfix workflows
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showPrompt, showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { GitFlowConfig } from '../../services/git.service.ts';
import type { Branch } from '../../types/git.types.ts';
import type { GitflowFinishContext } from '../dialogs/gn-conflict-resolution-dialog.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

type GitFlowCategory = 'feature' | 'release' | 'hotfix';

interface ActiveItem {
  name: string;
  branch: string;
}

@customElement('gn-gitflow-panel')
export class GnGitflowPanel extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: block;
      }

      .panel {
        padding: var(--spacing-sm);
      }

      .init-section {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        text-align: center;
      }

      .init-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .load-error {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        text-align: center;
      }

      .load-error-message {
        font-size: var(--font-size-sm);
        color: var(--color-error);
      }

      .section {
        margin-bottom: var(--spacing-sm);
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }

      .section-header:hover {
        background: var(--color-bg-hover);
      }

      .section-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        transition: transform var(--transition-fast);
      }

      .section-icon.collapsed {
        transform: rotate(-90deg);
      }

      .section-title {
        flex: 1;
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .section-actions {
        display: flex;
        gap: 2px;
      }

      .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .action-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .action-btn svg {
        width: 14px;
        height: 14px;
      }

      .item-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px 2px 24px;
        font-size: var(--font-size-sm);
      }

      .item:hover {
        background: var(--color-bg-hover);
      }

      .item-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-text-muted);
      }

      .item-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-finish-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .item:hover .item-finish-btn {
        opacity: 1;
      }

      .item-finish-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-success);
      }

      .item-squash-btn:hover {
        color: var(--color-accent, var(--color-primary));
      }

      .item-finish-btn svg {
        width: 12px;
        height: 12px;
      }

      .empty-section {
        padding: 2px 12px 2px 24px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-style: italic;
      }

      .config-summary {
        padding: 4px 8px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        border-top: 1px solid var(--color-border);
        margin-top: var(--spacing-sm);
      }

      .config-row {
        display: flex;
        justify-content: space-between;
        padding: 1px 0;
      }

      .config-label {
        color: var(--color-text-muted);
      }

      .config-value {
        font-family: var(--font-family-mono);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .error {
        padding: var(--spacing-sm);
        color: var(--color-error);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .error-banner {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        margin: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: rgba(var(--color-error-rgb, 239, 68, 68), 0.12);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-sm);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .error-banner-message {
        flex: 1;
      }

      .error-banner-dismiss {
        flex-shrink: 0;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0 4px;
        font-size: var(--font-size-md);
        line-height: 1;
      }

      .error-banner-dismiss:hover {
        opacity: 0.7;
      }

      .category-icon {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
      }

      .feature-color {
        color: var(--color-primary);
      }

      .release-color {
        color: var(--color-success);
      }

      .hotfix-color {
        color: var(--color-error);
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  @state() private config: GitFlowConfig | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  /**
   * A config load that FAILED, as opposed to one that reported "not
   * initialized". The two must render differently: only the second may offer
   * the Initialize button, which rewrites the repo's gitflow config with the
   * defaults and would silently discard custom branch names and prefixes.
   */
  @state() private configLoadFailed = false;
  /**
   * The repo path `config` and the active item lists were loaded from. A
   * failed load keeps the last good data for the SAME repo, but never carries
   * another repo's items across — their Finish buttons run against
   * `repositoryPath`, so that would finish the wrong branch.
   */
  private configPath: string | null = null;
  @state() private activeFeatures: ActiveItem[] = [];
  @state() private activeReleases: ActiveItem[] = [];
  @state() private activeHotfixes: ActiveItem[] = [];
  @state() private expandedSections = new Set<GitFlowCategory>(['feature', 'release', 'hotfix']);
  /**
   * The working-tree lock, shared with app-shell, the other sidebar sections
   * and the destructive dialogs.
   *
   * This panel is the fourth section in the same left panel as the branch, tag
   * and stash lists, and performs the same class of operation — a git-flow
   * finish checks out develop, merges and deletes a branch. It was the last
   * one still holding a component-local boolean, so a Finish and a branch-list
   * checkout could run against the same working tree at once. See
   * utils/ref-lock.ts.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  private get operationInProgress(): boolean {
    void this.refOpsVersion;
    return isRefOpRunning(this.repositoryPath);
  }

  /** Claim the lock for `repoPath`; false when it is already held. */
  private claimOperation(repoPath: string): boolean {
    // Reports the refusal: these components hold the same lock app-shell does,
    // and a gesture with no disabled binding — the double-clicked branch row —
    // otherwise looked like a hung app for the whole other operation.
    return tryAcquireRefOpOrWarn(repoPath);
  }

  /**
   * Release `repoPath`'s lock.
   *
   * The path is passed explicitly rather than re-read from
   * `this.repositoryPath`: the prop rebinds when the user switches repo tabs
   * mid-operation, and a release that re-read it would free the wrong repo.
   */
  private releaseOperation(repoPath: string): void {
    releaseRefOp(repoPath);
  }
  /** Per-path load sequence: a slow load for repo A must not overwrite the
   * panel with A's config/items after the user switched to repo B (whose
   * load already resolved). Mirrors gn-branch-list's branchesLoadSeq. The
   * Finish buttons bind directly to these items, so stale data here could
   * finish/delete the wrong branch. */
  private configLoadSeq = new Map<string, number>();

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
    // Conflicted finishes complete inside the shared conflict dialog (branch
    // deleted / finish re-run there), so reload when the app-level refresh
    // fires — otherwise the finished item stays listed as active.
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    await this.loadConfig();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
  }

  private handleRepositoryRefresh = (): void => {
    void this.loadConfig();
  };

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      await this.loadConfig();
    }
  }

  public async refresh(): Promise<void> {
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    if (!this.repositoryPath) return;

    // Capture the repo and bump the per-path sequence at the START — a
    // response that lands after a newer load (for this or another repo) is
    // discarded rather than overwriting the panel with stale data.
    const loadedPath = this.repositoryPath;
    const seq = (this.configLoadSeq.get(loadedPath) ?? 0) + 1;
    this.configLoadSeq.set(loadedPath, seq);
    const isLatest = (): boolean =>
      this.repositoryPath === loadedPath && this.configLoadSeq.get(loadedPath) === seq;

    this.loading = true;
    this.error = null;
    this.configLoadFailed = false;

    try {
      const result = await gitService.getGitFlowConfig(loadedPath);
      if (!isLatest()) return;
      if (result.success && result.data) {
        this.config = result.data;
        this.configPath = loadedPath;
        if (this.config.initialized) {
          await this.loadActiveItems(loadedPath, isLatest);
        }
      } else {
        // invokeCommand turns every backend failure into success === false, so
        // this — not the catch — is the normal failure path. Nulling the config
        // here rendered the "Git Flow is not initialized" prompt, inviting the
        // user to re-initialize an already-initialized repo and overwrite its
        // custom branch names and prefixes with the defaults.
        this.markConfigLoadFailed(
          loadedPath,
          result.error?.message || 'Failed to load Git Flow configuration',
        );
      }
    } catch (err) {
      console.error('Failed to load git flow config:', err);
      if (isLatest()) {
        this.markConfigLoadFailed(loadedPath, 'Failed to load Git Flow configuration');
      }
    } finally {
      if (isLatest()) this.loading = false;
    }
  }

  /**
   * Record a failed config load: surface `message` and keep whatever this
   * repo's last successful load produced, so a transient failure (repo lock,
   * filesystem error) does not present an initialized repo as uninitialized.
   * A config loaded from a DIFFERENT path is dropped instead of kept — the
   * Finish buttons bound to its items run against `repositoryPath`.
   */
  private markConfigLoadFailed(loadedPath: string, message: string): void {
    if (this.configPath !== loadedPath) {
      this.config = null;
      this.configPath = null;
      this.activeFeatures = [];
      this.activeReleases = [];
      this.activeHotfixes = [];
    }
    this.configLoadFailed = true;
    this.error = message;
  }

  private async loadActiveItems(
    loadedPath: string = this.repositoryPath,
    isLatest?: () => boolean,
  ): Promise<void> {
    if (!this.config || !this.config.initialized) return;

    // Post-operation callers (start/finish handlers) pass no guard — they
    // just refresh the panel for whatever repo it currently shows. Establish
    // a fresh sequence guard so their reload is subject to the same
    // stale-response discard as loadConfig's.
    let latest = isLatest;
    if (!latest) {
      const seq = (this.configLoadSeq.get(loadedPath) ?? 0) + 1;
      this.configLoadSeq.set(loadedPath, seq);
      latest = (): boolean =>
        this.repositoryPath === loadedPath && this.configLoadSeq.get(loadedPath) === seq;
    }

    try {
      const branchResult = await gitService.getBranches(loadedPath);
      // Discard a stale response — the Finish buttons bind directly to these
      // items, so writing repo A's items under repo B's tab could
      // finish/delete the wrong branch.
      if (!latest()) return;

      if (!branchResult.success || !branchResult.data) {
        // Keeping the last good listing is the same hazard by another route:
        // the rows would still be the previous repo's while the panel already
        // shows this one's config, and a Finish would run against whatever
        // branch here carries that name. Show nothing rather than something
        // wrong — and say why.
        this.clearActiveItems();
        this.error = branchResult.error?.message || 'Failed to load Git Flow branches';
        return;
      }

      const branches = branchResult.data.filter((b: Branch) => !b.isRemote);

      this.activeFeatures = this.extractActiveItems(branches, this.config.featurePrefix);
      this.activeReleases = this.extractActiveItems(branches, this.config.releasePrefix);
      this.activeHotfixes = this.extractActiveItems(branches, this.config.hotfixPrefix);
    } catch (err) {
      console.error('Failed to load active git flow items:', err);
      // Re-check: a failure for a repo the user has navigated AWAY from must
      // not wipe the current repo's rows or raise a banner about a repo that
      // is no longer shown.
      if (!latest()) return;
      this.clearActiveItems();
      this.error = 'Failed to load Git Flow branches';
    }
  }

  /** Drop every active item — the listing they came from is no longer trusted. */
  private clearActiveItems(): void {
    this.activeFeatures = [];
    this.activeReleases = [];
    this.activeHotfixes = [];
  }

  private extractActiveItems(branches: Branch[], prefix: string): ActiveItem[] {
    return branches
      .filter((b) => b.name.startsWith(prefix))
      .map((b) => ({
        name: b.name.slice(prefix.length),
        branch: b.name,
      }));
  }

  private async handleInitialize(): Promise<void> {
    // Captured BEFORE the await — the host's refresh must target the repo
    // the init actually ran on, even if the prop is rebound mid-flight.
    const repoPath = this.repositoryPath;
    if (!this.claimOperation(repoPath)) {
      // claimOperation reports the refusal itself now, so an inline copy of
      // the same sentence would show it twice — once as a toast and once in
      // this panel's error banner.
      return;
    }
    this.error = null;
    try {
      const result = await gitService.initGitFlow(repoPath);
      if (result.success) {
        await this.loadConfig();
        this.dispatchEvent(new CustomEvent('gitflow-initialized', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to initialize Git Flow';
      }
    } catch (err) {
      console.error('Failed to initialize git flow:', err);
      this.error = 'Failed to initialize Git Flow';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleStartFeature(): Promise<void> {
    // Captured BEFORE the prompt: it is an in-app overlay, so Ctrl+Tab can
    // switch the active repo (rebinding this prop) while it is open — the
    // branch must be created in the repo the panel showed at click time.
    const repoPath = this.repositoryPath;
    const name = await showPrompt('Start Feature', 'Enter feature name:');
    if (!name || !name.trim()) return;

    if (!this.claimOperation(repoPath)) {
      // claimOperation reports the refusal itself now, so an inline copy of
      // the same sentence would show it twice — once as a toast and once in
      // this panel's error banner.
      return;
    }
    this.error = null;

    try {
      const result = await gitService.gitFlowStartFeature(repoPath, name.trim());
      if (result.success) {
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'start-feature', name: name.trim(), repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to start feature';
      }
    } catch (err) {
      console.error('Failed to start feature:', err);
      this.error = 'Failed to start feature';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleFinishFeature(item: ActiveItem, squash = false): Promise<void> {
    // Captured BEFORE the awaits: the conflict dialog must pin to the repo
    // the finish actually ran on, even if the prop is rebound mid-flight.
    const repoPath = this.repositoryPath;

    // Claim the guard SYNCHRONOUSLY, before the confirm's await.
    //
    // Testing it at function entry alone does not close the race: there is an
    // IPC round trip between the click and the native dialog actually opening
    // and taking focus, so a double-click lands a second call while the flag is
    // still false and both pass the check. Two concurrent squash finishes on
    // one repo can double-merge or mint a duplicate squash commit — the Rust
    // command takes no repo-level lock. Claim first, release on decline.
    if (!this.claimOperation(repoPath)) return;

    // A squash finish collapses the branch into ONE commit on develop and then
    // deletes it. Because a squash commit never makes the feature tip an
    // ancestor of develop, every original commit becomes unreachable
    // immediately — and gitflow deletes the branch with git2 directly, so
    // delete_branch's merged-check never runs. This button sits next to the
    // ordinary finish with only a tooltip between them, so it needs its own
    // gate; the plain finish is non-destructive by comparison.
    if (squash) {
      // The guard flag is claimed above but the try/finally that releases it
      // starts below, so a rejecting confirm would leave operationInProgress
      // stuck true — which disables every button in this panel. Treat a failed
      // prompt as declined.
      let confirmed = false;
      try {
        confirmed = await showConfirm(
        'Squash and Finish',
        `"${item.name}" will be squashed into a single commit on develop and then ` +
          `deleted. Its individual commits will no longer be reachable from any ` +
          `branch.\n\nThis cannot be undone.`,
        'warning',
        );
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        this.releaseOperation(repoPath);
        return;
      }
    }

    this.error = null;
    try {
      const result = await gitService.gitFlowFinishFeature(repoPath, item.name, true, squash);
      if (result.success) {
        // A branch rule can block the finish's branch deletion. The merge and
        // tag still landed, so this is a warning about what was KEPT, not a
        // failure — but it must be said, or the branch silently survives.
        if (result.data?.branchKeptReason) {
          showToast(result.data.branchKeptReason, 'warning');
        }
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'finish-feature', name: item.name, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else if (result.error?.code === 'MERGE_CONFLICT') {
        await this.loadActiveItems();
        // Preserve squash intent: a squash finish that conflicted must complete as
        // a single-parent squash commit, not a two-parent merge commit. The finish
        // context lets the dialog complete the finish (delete branch / re-invoke)
        // once the conflict is resolved.
        this.openConflictDialog(
          squash,
          {
            kind: 'feature',
            name: item.name,
            branchName: item.branch,
            deleteBranch: true,
          },
          repoPath,
        );
      } else {
        this.error = result.error?.message || 'Failed to finish feature';
      }
    } catch (err) {
      console.error('Failed to finish feature:', err);
      this.error = 'Failed to finish feature';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleStartRelease(): Promise<void> {
    const repoPath = this.repositoryPath;
    const version = await showPrompt('Start Release', 'Enter release version:');
    if (!version || !version.trim()) return;

    if (!this.claimOperation(repoPath)) {
      // claimOperation reports the refusal itself now, so an inline copy of
      // the same sentence would show it twice — once as a toast and once in
      // this panel's error banner.
      return;
    }
    this.error = null;

    try {
      const result = await gitService.gitFlowStartRelease(repoPath, version.trim());
      if (result.success) {
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'start-release', name: version.trim(), repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to start release';
      }
    } catch (err) {
      console.error('Failed to start release:', err);
      this.error = 'Failed to start release';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleFinishRelease(item: ActiveItem): Promise<void> {
    // Claimed BEFORE the prompt, like handleFinishFeature. showPrompt is a
    // singleton whose open() overwrites its resolver, so a second click during
    // the prompt strands the first call on a promise that never settles rather
    // than racing it — claiming up front prevents that hang and keeps the three
    // finish handlers consistent.
    // Captured BEFORE the prompt (an in-app overlay — Ctrl+Tab can rebind
    // this prop while it is open): the finish must run on the repo whose
    // release the user clicked, and the conflict dialog must pin to it.
    // The develop-branch NAME is per-repo config that reloads on switch —
    // capture it with the path.
    const repoPath = this.repositoryPath;
    if (!this.claimOperation(repoPath)) return;
    const developBranch = this.config?.developBranch ?? 'develop';
    // showPrompt dynamically imports the prompt component; a chunk-load
    // failure rejects here, and the flag is already claimed while the try that
    // releases it starts below — leaving every button in this panel disabled
    // for the session. Same wrapping as handleFinishFeature's confirm.
    let tagMessage: string | null = null;
    try {
      tagMessage = await showPrompt('Finish Release', `Enter tag message for release ${item.name}:`, `Release ${item.name}`);
    } catch {
      this.releaseOperation(repoPath);
      return;
    }
    if (tagMessage === null) {
      this.releaseOperation(repoPath);
      return;
    }

    this.error = null;

    try {
      const result = await gitService.gitFlowFinishRelease(
        repoPath,
        item.name,
        tagMessage || undefined,
        true,
      );
      if (result.success) {
        // A branch rule can block the finish's branch deletion. The merge and
        // tag still landed, so this is a warning about what was KEPT, not a
        // failure — but it must be said, or the branch silently survives.
        if (result.data?.branchKeptReason) {
          showToast(result.data.branchKeptReason, 'warning');
        }
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'finish-release', name: item.name, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else if (result.error?.code === 'MERGE_CONFLICT') {
        await this.loadActiveItems();
        this.openConflictDialog(
          false,
          {
            kind: 'release',
            name: item.name,
            branchName: item.branch,
            deleteBranch: true,
            tagMessage: tagMessage || undefined,
            // The backend merges+tags master BEFORE the develop merge; a conflict
            // while HEAD is on develop means that master merge + tag already landed.
            priorFinishCommitLanded: await this.isOnDevelopBranch(repoPath, developBranch),
          },
          repoPath,
        );
      } else {
        this.error = result.error?.message || 'Failed to finish release';
      }
    } catch (err) {
      console.error('Failed to finish release:', err);
      this.error = 'Failed to finish release';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleStartHotfix(): Promise<void> {
    const repoPath = this.repositoryPath;
    const version = await showPrompt('Start Hotfix', 'Enter hotfix version:');
    if (!version || !version.trim()) return;

    if (!this.claimOperation(repoPath)) {
      // claimOperation reports the refusal itself now, so an inline copy of
      // the same sentence would show it twice — once as a toast and once in
      // this panel's error banner.
      return;
    }
    this.error = null;

    try {
      const result = await gitService.gitFlowStartHotfix(repoPath, version.trim());
      if (result.success) {
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'start-hotfix', name: version.trim(), repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to start hotfix';
      }
    } catch (err) {
      console.error('Failed to start hotfix:', err);
      this.error = 'Failed to start hotfix';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private async handleFinishHotfix(item: ActiveItem): Promise<void> {
    // Claimed BEFORE the prompt, like handleFinishFeature. showPrompt is a
    // singleton whose open() overwrites its resolver, so a second click during
    // the prompt strands the first call on a promise that never settles rather
    // than racing it — claiming up front prevents that hang and keeps the three
    // finish handlers consistent.
    const repoPath = this.repositoryPath;
    if (!this.claimOperation(repoPath)) return;
    const developBranch = this.config?.developBranch ?? 'develop';
    // showPrompt dynamically imports the prompt component; a chunk-load
    // failure rejects here, and the flag is already claimed while the try that
    // releases it starts below — leaving every button in this panel disabled
    // for the session. Same wrapping as handleFinishFeature's confirm.
    let tagMessage: string | null = null;
    try {
      tagMessage = await showPrompt('Finish Hotfix', `Enter tag message for hotfix ${item.name}:`, `Hotfix ${item.name}`);
    } catch {
      this.releaseOperation(repoPath);
      return;
    }
    if (tagMessage === null) {
      this.releaseOperation(repoPath);
      return;
    }

    this.error = null;

    try {
      const result = await gitService.gitFlowFinishHotfix(
        repoPath,
        item.name,
        tagMessage || undefined,
        true,
      );
      if (result.success) {
        // A branch rule can block the finish's branch deletion. The merge and
        // tag still landed, so this is a warning about what was KEPT, not a
        // failure — but it must be said, or the branch silently survives.
        if (result.data?.branchKeptReason) {
          showToast(result.data.branchKeptReason, 'warning');
        }
        await this.loadActiveItems();
        this.dispatchEvent(new CustomEvent('gitflow-operation', {
          detail: { type: 'finish-hotfix', name: item.name, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else if (result.error?.code === 'MERGE_CONFLICT') {
        await this.loadActiveItems();
        this.openConflictDialog(
          false,
          {
            kind: 'hotfix',
            name: item.name,
            branchName: item.branch,
            deleteBranch: true,
            tagMessage: tagMessage || undefined,
            // The backend merges+tags master BEFORE the develop merge; a conflict
            // while HEAD is on develop means that master merge + tag already landed.
            priorFinishCommitLanded: await this.isOnDevelopBranch(repoPath, developBranch),
          },
          repoPath,
        );
      } else {
        this.error = result.error?.message || 'Failed to finish hotfix';
      }
    } catch (err) {
      console.error('Failed to finish hotfix:', err);
      this.error = 'Failed to finish hotfix';
    } finally {
      this.releaseOperation(repoPath);
    }
  }

  private dismissError(): void {
    this.error = null;
  }

  /**
   * A gitflow finish that hit a merge conflict — open the app-level conflict
   * resolution dialog so the user can resolve it. The `gitflowFinish` context lets
   * the dialog COMPLETE the finish (tag / merge develop / delete branch) after the
   * conflict is resolved, instead of leaving it half-done.
   */
  /**
   * True when HEAD is on the develop branch — after a release/hotfix finish
   * conflict this means the backend already merged into master and created the
   * version tag (both happen before the develop merge), so those survive an abort.
   */
  private async isOnDevelopBranch(repoPath: string, developBranch: string): Promise<boolean> {
    // BOTH parameters are the caller's PRE-AWAIT captures — this runs after
    // the finish's awaits, when this.repositoryPath (and with it
    // this.config, which reloads on repo switch) may already describe
    // another repo. Reading the live config here would compare repo A's
    // HEAD against repo B's develop-branch NAME and seed a dishonest
    // priorFinishCommitLanded into the abort wording.
    const result = await gitService.getBranches(repoPath);
    if (!result.success || !result.data) return false;
    return result.data.some((b) => b.isHead && b.name === developBranch);
  }

  private openConflictDialog(
    squash: boolean,
    gitflowFinish: GitflowFinishContext,
    repositoryPath: string,
  ): void {
    this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
      bubbles: true,
      composed: true,
      detail: {
        operationType: 'merge',
        squash,
        gitflowFinish,
        // The caller's PRE-AWAIT capture — this.repositoryPath may have been
        // rebound to another repo while the finish ran.
        repositoryPath,
      },
    }));
  }

  private toggleSection(category: GitFlowCategory): void {
    const next = new Set(this.expandedSections);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    this.expandedSections = next;
  }

  private renderInitSection() {
    return html`
      <div class="init-section">
        <div class="init-description">
          Git Flow is not initialized for this repository.
        </div>
        <button
          class="btn btn-primary"
          @click=${this.handleInitialize}
          ?disabled=${this.operationInProgress}
        >
          ${this.operationInProgress ? 'Initializing...' : 'Initialize Git Flow'}
        </button>
      </div>
    `;
  }

  private renderCategorySection(
    category: GitFlowCategory,
    label: string,
    items: ActiveItem[],
    onStart: () => void,
    onFinish: (item: ActiveItem) => void,
    colorClass: string,
    onSquash?: (item: ActiveItem) => void,
  ) {
    const expanded = this.expandedSections.has(category);

    return html`
      <div class="section">
        <div
          class="section-header"
          @click=${() => this.toggleSection(category)}
        >
          <div class="section-title">
            <svg class="section-icon ${expanded ? '' : 'collapsed'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span class="${colorClass}">${label}</span>
            ${items.length > 0 ? html`<span style="font-size: var(--font-size-xs); color: var(--color-text-muted);">(${items.length})</span>` : nothing}
          </div>
          <div class="section-actions">
            <button
              class="action-btn"
              title="Start ${label}"
              @click=${(e: Event) => { e.stopPropagation(); onStart(); }}
              ?disabled=${this.operationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </div>
        </div>
        ${expanded ? this.renderCategoryItems(category, items, onFinish, onSquash) : nothing}
      </div>
    `;
  }

  private renderCategoryItems(
    _category: GitFlowCategory,
    items: ActiveItem[],
    onFinish: (item: ActiveItem) => void,
    onSquash?: (item: ActiveItem) => void,
  ) {
    if (items.length === 0) {
      return html`<div class="empty-section">No active items</div>`;
    }

    return html`
      <ul class="item-list">
        ${items.map((item) => html`
          <li class="item">
            <svg class="item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="6" y1="3" x2="6" y2="15"></line>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <path d="M18 9a9 9 0 01-9 9"></path>
            </svg>
            <span class="item-name" title="${item.branch}">${item.name}</span>
            ${onSquash
              ? html`
                  <button
                    class="item-finish-btn item-squash-btn"
                    title="Squash and finish ${item.name}"
                    @click=${() => onSquash(item)}
                    ?disabled=${this.operationInProgress}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="8 7 12 3 16 7"></polyline>
                      <polyline points="8 17 12 21 16 17"></polyline>
                      <line x1="12" y1="3" x2="12" y2="21"></line>
                    </svg>
                  </button>
                `
              : nothing}
            <button
              class="item-finish-btn"
              title="Finish ${item.name}"
              @click=${() => onFinish(item)}
              ?disabled=${this.operationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </button>
          </li>
        `)}
      </ul>
    `;
  }

  private renderConfigSummary() {
    if (!this.config || !this.config.initialized) return nothing;

    return html`
      <div class="config-summary">
        <div class="config-row">
          <span class="config-label">Master:</span>
          <span class="config-value">${this.config.masterBranch}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Develop:</span>
          <span class="config-value">${this.config.developBranch}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Feature:</span>
          <span class="config-value">${this.config.featurePrefix}*</span>
        </div>
        <div class="config-row">
          <span class="config-label">Release:</span>
          <span class="config-value">${this.config.releasePrefix}*</span>
        </div>
        <div class="config-row">
          <span class="config-label">Hotfix:</span>
          <span class="config-value">${this.config.hotfixPrefix}*</span>
        </div>
      </div>
    `;
  }

  private renderErrorBanner() {
    if (!this.error) return nothing;
    return html`
      <div class="error-banner">
        <span class="error-banner-message">${this.error}</span>
        <button
          class="error-banner-dismiss"
          title="Dismiss"
          aria-label="Dismiss error"
          @click=${this.dismissError}
        >✕</button>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading Git Flow...</div>`;
    }

    // A load that FAILED is not the same as "not initialized": the Initialize
    // button would rewrite this repo's gitflow config with the defaults. The
    // message is the section's own text rather than a dismissible banner, so
    // dismissing it cannot leave a blank panel.
    if (this.configLoadFailed && !this.config?.initialized) {
      return html`
        <div class="load-error">
          <div class="load-error-message">
            ${this.error ?? 'Failed to load Git Flow configuration'}
          </div>
          <button class="btn btn-secondary" @click=${() => void this.loadConfig()}>
            Retry
          </button>
        </div>
      `;
    }

    if (!this.config || !this.config.initialized) {
      return html`
        ${this.renderErrorBanner()}
        ${this.renderInitSection()}
      `;
    }

    return html`
      ${this.renderErrorBanner()}
      <div class="panel">
        ${this.renderCategorySection(
          'feature',
          'Feature',
          this.activeFeatures,
          () => this.handleStartFeature(),
          (item) => this.handleFinishFeature(item),
          'feature-color',
          (item) => this.handleFinishFeature(item, true),
        )}
        ${this.renderCategorySection(
          'release',
          'Release',
          this.activeReleases,
          () => this.handleStartRelease(),
          (item) => this.handleFinishRelease(item),
          'release-color',
        )}
        ${this.renderCategorySection(
          'hotfix',
          'Hotfix',
          this.activeHotfixes,
          () => this.handleStartHotfix(),
          (item) => this.handleFinishHotfix(item),
          'hotfix-color',
        )}

        ${this.renderConfigSummary()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-gitflow-panel': GnGitflowPanel;
  }
}
