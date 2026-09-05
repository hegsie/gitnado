import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { sharedStyles } from './styles/shared-styles.ts';
import { repositoryStore, uiStore, type OpenRepository } from './stores/index.ts';
import {
  dialogStore,
  dialogs,
  type ConflictDialogContext,
} from './stores/dialog.store.ts';
import { registerDefaultShortcuts, keyboardService } from './services/keyboard.service.ts';
import {
  MENU_ACTION_EVENT,
  resolveMenuAction,
  shouldSuppressMenuAction,
  startAcceleratorWatch,
  syncAppMenu,
  type MenuShellHandlers,
} from './services/app-menu.service.ts';
import { loggers } from './utils/logger.ts';
import { sweepRepoScopedDialogs } from './utils/repo-scoped-dialogs.ts';
import { rebasedOntoMessage } from './utils/rebase-messages.ts';
import * as watcherService from './services/watcher.service.ts';

const log = loggers.app;

/**
 * Repository states that have a working abort command.
 *
 * The operation banner's Abort button and handleAbortOperation BOTH read this,
 * so the UI can never offer an abort the handler will refuse. The banner used
 * to render for every non-clean state, which made Abort a permanent dead end
 * during a bisect or an in-progress mailbox apply — those have no abort command
 * here (a bisect exits via the bisect dialog's Reset).
 *
 * Typed as RepositoryState so a typo or a renamed state is a compile error.
 */
const ABORTABLE_STATES: readonly RepositoryState[] = [
  'cherrypick',
  'merge',
  'rebase',
  'rebase-interactive',
  'rebase-merge',
  'revert',
];

/**
 * Repository states that have a working skip command.
 *
 * The banner's Skip button and handleSkipOperation BOTH read this, so the UI can
 * never offer a skip the handler will refuse. Rebase is intentionally absent:
 * `skip_rebase_commit` exists in the backend but is not wired to this control,
 * and listing it here without a switch arm would render a dead button.
 */
const SKIPPABLE_STATES: readonly RepositoryState[] = ['cherrypick', 'revert'];

/**
 * The palette query that turns the command palette into a branch switcher.
 *
 * Matches the label lv-command-palette gives every branch entry
 * ("Switch to <branch>"), so a prefix match puts them all above every other
 * command. Kept as a constant so the two cannot drift silently.
 */
const SWITCH_BRANCH_PALETTE_QUERY = 'Switch to ';

/**
 * How a repository state reads in user-facing prose.
 *
 * The stored state is git's own token, so the raw value produces "Skipped
 * cherrypick" / "Abort cherrypick?" — wording that appears nowhere else in the
 * app. The banner beside these controls already says "Cherry-pick in progress",
 * and the conflict dialog's own Skip/Abort toasts say "cherry-pick"; this keeps
 * the banner's confirms and toasts consistent with both.
 */
function operationLabel(state: RepositoryState): string {
  return state === 'cherrypick' ? 'cherry-pick' : state;
}
import './components/toolbar/lv-toolbar.ts';
import './components/welcome/lv-welcome.ts';
import './components/graph/lv-graph-canvas.ts';
import './components/panels/lv-diff-view.ts';
import type { LvDiffView } from './components/panels/lv-diff-view.ts';
import './components/panels/lv-blame-view.ts';
import './components/panels/lv-output-panel.ts';
import './components/sidebar/lv-left-panel.ts';
import './components/sidebar/lv-right-panel.ts';
import './components/dialogs/lv-settings-dialog.ts';
import './components/dialogs/lv-modal.ts';
import './components/dialogs/lv-conflict-resolution-dialog.ts';
import type { GitflowFinishContext } from './components/dialogs/lv-conflict-resolution-dialog.ts';
import './components/dialogs/lv-command-palette.ts';
import './components/dialogs/lv-reflog-dialog.ts';
import './components/dialogs/lv-describe-dialog.ts';
import './components/dialogs/lv-compare-branches-dialog.ts';
import './components/dialogs/lv-search-dialog.ts';
import './components/dialogs/lv-keyboard-shortcuts-dialog.ts';
import './components/dialogs/lv-remote-dialog.ts';
import './components/dialogs/lv-changelog-dialog.ts';
import './components/dialogs/lv-clean-dialog.ts';
import './components/dialogs/lv-export-import-dialog.ts';
import './components/dialogs/lv-bisect-dialog.ts';
import './components/dialogs/lv-submodule-dialog.ts';
import './components/dialogs/lv-worktree-dialog.ts';
import './components/dialogs/lv-lfs-dialog.ts';
import './components/dialogs/lv-gpg-dialog.ts';
import './components/dialogs/lv-ssh-dialog.ts';
import './components/dialogs/lv-config-dialog.ts';
import './components/dialogs/lv-gitignore-dialog.ts';
import './components/dialogs/lv-credentials-dialog.ts';
import './components/dialogs/lv-github-dialog.ts';
import './components/dialogs/lv-gitlab-dialog.ts';
import './components/dialogs/lv-oidc-dialog.ts';
import './components/dialogs/lv-bitbucket-dialog.ts';
import './components/dialogs/lv-azure-devops-dialog.ts';
import './components/dialogs/lv-profile-manager-dialog.ts';
import './components/dialogs/lv-migration-dialog.ts';
import './components/dialogs/lv-workspace-manager-dialog.ts';
import './components/dialogs/lv-scan-repositories-dialog.ts';
import './components/dialogs/lv-init-dialog.ts';
import './components/dialogs/lv-hooks-dialog.ts';
import './components/dialogs/lv-create-tag-dialog.ts';
import './components/dialogs/lv-create-branch-dialog.ts';
import './components/dialogs/lv-cherry-pick-dialog.ts';
import './components/dialogs/lv-interactive-rebase-dialog.ts';
import './components/dialogs/lv-repository-health-dialog.ts';
import './components/panels/lv-file-history.ts';
import './components/common/lv-toast-container.ts';
import './components/common/lv-progress-indicator.ts';
import { progressService } from './services/progress.service.ts';
import type { ProgressOperation } from './components/common/lv-progress-indicator.ts';
import './components/dashboard/lv-context-dashboard.ts';
import type { CommitSelectedEvent, LvGraphCanvas } from './components/graph/lv-graph-canvas.ts';
import { evictGraphCache } from './components/graph/lv-graph-canvas.ts';
import type { LvCreateTagDialog } from './components/dialogs/lv-create-tag-dialog.ts';
import type { LvCreateBranchDialog } from './components/dialogs/lv-create-branch-dialog.ts';
import type { LvCherryPickDialog } from './components/dialogs/lv-cherry-pick-dialog.ts';
import type { LvInteractiveRebaseDialog } from './components/dialogs/lv-interactive-rebase-dialog.ts';
import type { LvProfileManagerDialog } from './components/dialogs/lv-profile-manager-dialog.ts';
import type { LvReflogDialog } from './components/dialogs/lv-reflog-dialog.ts';
import type { LvDescribeDialog } from './components/dialogs/lv-describe-dialog.ts';
import type { LvCompareBranchesDialog } from './components/dialogs/lv-compare-branches-dialog.ts';
import type { LvGitHubDialog } from './components/dialogs/lv-github-dialog.ts';
import type { LvGitLabDialog } from './components/dialogs/lv-gitlab-dialog.ts';
import type { LvBitbucketDialog } from './components/dialogs/lv-bitbucket-dialog.ts';
import type { LvAzureDevOpsDialog } from './components/dialogs/lv-azure-devops-dialog.ts';
import type { PullRequestProviderId } from './services/pull-request.service.ts';
import type { SearchDialogMode } from './components/dialogs/lv-search-dialog.ts';
import type { LvCleanDialog } from './components/dialogs/lv-clean-dialog.ts';
import type { LvExportImportDialog } from './components/dialogs/lv-export-import-dialog.ts';
import type { LvRemoteDialog } from './components/dialogs/lv-remote-dialog.ts';
import type { LvRepositoryHealthDialog } from './components/dialogs/lv-repository-health-dialog.ts';
import type { LvChangelogDialog } from './components/dialogs/lv-changelog-dialog.ts';
import type { IntegrationOpenContext, IntegrationType } from './types/integration-accounts.types.ts';
import type { Commit, RefInfo, StatusEntry, Tag, Branch, RepositoryState } from './types/git.types.ts';
import type { SearchFilter } from './components/toolbar/lv-search-bar.ts';
import type { PaletteCommand } from './components/dialogs/lv-command-palette.ts';
import { buildPaletteCommands, type PaletteCommandHost } from './palette-commands.ts';
import * as gitService from './services/git.service.ts';
import * as updateService from './services/update.service.ts';
import * as unifiedProfileService from './services/unified-profile.service.ts';
import { settingsStore } from './stores/settings.store.ts';
import { workspaceStore } from './stores/workspace.store.ts';
import * as workspaceService from './services/workspace.service.ts';
import { listenToEvent } from './services/tauri-api.ts';
import {
  startGitCommandLogging,
  stopGitCommandLogging,
} from './services/git-output.service.ts';
import { showToast, notifyWarning } from './services/notification.service.ts';
import { emitSecuritySettings } from './services/security-sync.service.ts';
import { showErrorWithSuggestion } from './services/error-suggestion.service.ts';
import { runFetch, runPull, runPush } from './services/remote-operations.service.ts';
import { showConfirm, showMessage, showPrompt } from './services/dialog.service.ts';
import { mergePreviewSummary } from './utils/merge-preview.ts';
import {
  confirmGarbageCollection,
  confirmPrune,
  summariseFsck,
  tryAcquireMaintenance,
  tryAcquireMaintenanceReadOnly,
  releaseMaintenance,
  isMaintenanceBlocked,
} from './utils/maintenance-confirms.ts';
import { confirmDeleteTag, offerRemoteTagDelete } from './utils/tag-delete.ts';
import {
  cherryPickConfirmMessage,
  cherryPickFailureMessage,
  orderCommitsForApply,
  shortCommitLabel,
} from './utils/commit-selection.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
  warnRepositoryBusy,
  tryAcquirePush,
  releasePush,
  pushTagKey,
  isPushRunning,
} from './utils/ref-lock.ts';
import { searchIndexService } from './services/search-index.service.ts';
import { embeddingIndexService } from './services/embedding-index.service.ts';
import { initOAuthListener } from './services/oauth.service.ts';
import * as localAiService from './services/local-ai.service.ts';
import { emit, type UnlistenFn } from '@tauri-apps/api/event';
import {
  startRepositoryDropListener,
  REPOSITORY_SCAN_OFFER_EVENT,
} from './services/window-drop.service.ts';

/**
 * Main application shell component
 * Provides the top-level layout and routing
 */
@customElement('lv-app-shell')
// Only the Settings modal's own title is localised here so far — but the shell
// still has to re-render on a locale change, or that title would go stale while
// the dialog inside it switches language.
@localized()
export class AppShell extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        width: 100vw;
        overflow: hidden;
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }

      .skip-link {
        position: absolute;
        top: -100%;
        left: 16px;
        z-index: 10000;
        padding: 8px 16px;
        background: var(--color-accent);
        color: white;
        text-decoration: none;
        border-radius: 0 0 6px 6px;
        font-size: 14px;
      }

      /* Top level, NOT nested in .skip-link. The rule above was left unclosed,
         so under CSS nesting — which the WebView2 and WKWebView engines Tauri
         uses both support — these compiled to a descendant selector under
         .skip-link and matched nothing: the bar is a SIBLING of the skip link,
         not a descendant. The global progress indicator was invisible for
         every long-running operation, and the skip link lost its own colours
         to boot, since its declarations were stranded after the keyframes. */
      .global-loading-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        z-index: 9999;
        overflow: hidden;
        background: var(--color-bg-tertiary);
      }

      .global-loading-bar::after {
        content: '';
        display: block;
        height: 100%;
        width: 40%;
        background: var(--color-primary);
        animation: loading-slide 1.2s ease-in-out infinite;
      }

      @keyframes loading-slide {
        0% { transform: translateX(-100%); }
        50% { transform: translateX(150%); }
        100% { transform: translateX(350%); }
      }

      /* Drop affordance for the REPOSITORY-OPEN window.
         The OS drop is accepted in both states — dropping a folder with a repo
         open opens it in a new tab — but only lv-welcome had an overlay, so the
         same drag looked accepted on one screen and ignored on the other. Same
         wording and same dashed frame as lv-welcome's copy; it cannot be shared
         as one element because that one lives inside the welcome component's
         shadow root. Fixed rather than absolute: the shell is a flex column and
         the overlay must cover the whole window, toolbar included. */
      .window-drop-overlay {
        position: fixed;
        inset: var(--spacing-md);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        border: 2px dashed var(--color-primary);
        border-radius: var(--radius-lg);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        z-index: 9998;
        /* The OS owns the drag; the overlay must never swallow a pointer. */
        pointer-events: none;
      }

      .window-drop-overlay svg {
        width: 48px;
        height: 48px;
        color: var(--color-primary);
      }

      .window-drop-overlay-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-medium);
      }

      .window-drop-overlay-hint {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        max-width: 380px;
        text-align: center;
      }

      /* The shared reduced-motion rules clamp every animation to one 0.01ms
         iteration, which would park this bar at its final keyframe — 350% to
         the right, i.e. completely off-screen — and the app would look idle
         during long operations. Paint a static full-width bar instead so the
         "busy" state is still visible without motion. */
      @media (prefers-reduced-motion: reduce) {
        .global-loading-bar::after {
          width: 100%;
          transform: none;
        }
      }

      .skip-link:focus {
        top: 0;
      }

      .main-content {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .left-panel {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border-right: 1px solid var(--color-border);
        overflow: hidden;
      }

      /* Hidden, NOT unmounted. The panel owns the interactive-rebase,
         branch-cleanup and create-branch dialogs; removing it from the
         template tore down an in-progress rebase plan on Ctrl+B, and worse,
         detached the subtree mid-execute, so the open-conflict-dialog event
         it raises on REBASE_CONFLICT never reached app-shell's listener and
         the repo was left mid-rebase with no conflict dialog. Keeping it
         mounted also means lv-branch-list's window listeners stay registered. */
      .left-panel.hidden,
      .resize-handle-h.hidden {
        display: none;
      }

      .center-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 400px;
        position: relative;
      }

      .output-panel-container {
        height: 240px;
        flex-shrink: 0;
        border-top: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .output-panel-container lv-output-panel {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }

      .graph-area {
        flex: 1;
        overflow: hidden;
        background: var(--color-bg-primary);
      }

      .operation-banner {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        background: var(--color-warning-bg, #3d3000);
        border-bottom: 1px solid var(--color-warning-border, #665200);
        color: var(--color-warning-text, #ffd700);
        font-size: var(--font-size-sm);
      }

      .operation-banner.cherrypick {
        background: var(--color-info-bg, #002d4d);
        border-color: var(--color-info-border, #004d80);
        color: var(--color-info-text, #66b3ff);
      }

      .operation-banner.merge {
        background: var(--color-success-bg, #0d3d0d);
        border-color: var(--color-success-border, #1a661a);
        color: var(--color-success-text, #66ff66);
      }

      .operation-banner.rebase,
      .operation-banner.rebase-interactive,
      .operation-banner.rebase-merge {
        background: var(--color-warning-bg, #3d3000);
        border-color: var(--color-warning-border, #665200);
        color: var(--color-warning-text, #ffd700);
      }

      .operation-banner.revert {
        background: var(--color-error-bg, #3d0d0d);
        border-color: var(--color-error-border, #661a1a);
        color: var(--color-error-text, #ff6666);
      }

      .operation-icon {
        display: flex;
        align-items: center;
      }

      .operation-text {
        flex: 1;
        font-weight: var(--font-weight-medium);
      }

      .operation-btn {
        padding: var(--spacing-xxs) var(--spacing-sm);
        border: 1px solid currentColor;
        border-radius: var(--radius-sm);
        background: transparent;
        color: inherit;
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: background-color 0.15s;
      }

      .operation-btn:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      .operation-btn-primary {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.3);
      }

      .operation-btn-primary:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .operation-abort-btn {
        padding: var(--spacing-xxs) var(--spacing-sm);
        border: 1px solid currentColor;
        border-radius: var(--radius-sm);
        background: transparent;
        color: inherit;
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: background-color 0.15s;
      }

      .operation-abort-btn:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      .operation-banner-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .diff-area {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        flex-direction: column;
        background: var(--color-bg-primary);
        z-index: 10;
      }

      .diff-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      }

      .diff-header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
        flex: 1;
      }

      .diff-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .diff-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .diff-close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
        flex-shrink: 0;
      }

      .diff-close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .diff-close-btn svg {
        width: 16px;
        height: 16px;
      }

      .diff-content {
        flex: 1;
        overflow: hidden;
      }

      .right-panel {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border-left: 1px solid var(--color-border);
        overflow: hidden;
      }

      .resize-handle-h {
        width: 4px;
        cursor: col-resize;
        background: transparent;
        transition: background-color 0.15s ease;
        flex-shrink: 0;
        z-index: 10;
      }

      .resize-handle-h:hover,
      .resize-handle-h.dragging {
        background: var(--color-primary);
      }

      .status-bar {
        display: flex;
        align-items: center;
        height: 24px;
        padding: 0 var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-top: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      lv-welcome {
        flex: 1;
      }

      :host(.resizing) {
        user-select: none;
      }

      :host(.resizing-h) * {
        cursor: col-resize !important;
      }

      /* Context Menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown);
        min-width: 200px;
        max-width: 300px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--spacing-xs) 0;
      }

      .context-menu-header {
        padding: var(--spacing-xs) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        margin-bottom: var(--spacing-xs);
      }

      .context-menu-oid {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        margin-right: var(--spacing-sm);
      }

      .context-menu-summary {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: block;
        margin-top: 2px;
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
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

      .context-menu-item.danger:hover {
        background: var(--color-error-bg);
      }

      .context-menu-submenu {
        padding: var(--spacing-xs) 0;
      }

      .context-menu-label {
        display: block;
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-weight: var(--font-weight-medium);
      }

      /* Blame view uses the same diff-area styling */
    `,
  ];

  @state() activeRepository: OpenRepository | null = null;
  @state() selectedCommit: Commit | null = null;
  @state() private selectedCommitRefs: RefInfo[] = [];
  /**
   * Every commit in the graph's current selection (Ctrl/Shift+click), primary
   * included. The graph has always shipped this list on `commit-selected`;
   * dropping it meant a user could select eight commits and find no action
   * that used more than one of them. Kept whole here so the commit context
   * menu can offer the batch actions, and re-derived from the graph's loaded
   * commits at use time so a reload that rewrote history away cannot leave a
   * menu offering to cherry-pick commits the repository no longer has.
   */
  @state() private selectedCommits: Commit[] = [];

  // Diff view state. Whether the pane is up lives in the dialog store
  // (`dialogs.isOpen('diff')`); these payload fields stay here because they are
  // re-derived from every status refresh, not fixed at open time.
  @state() private diffFile: StatusEntry | null = null;
  @state() private diffCommitFile: { commitOid: string; filePath: string } | null = null;
  @state() private diffFilePartiallyStaged = false;

  // Blame view state. Open-ness lives in the dialog store, as for the diff.
  @state() private blameFile: string | null = null;
  @state() private blameCommitOid: string | null = null;

  // Progress operations
  @state() private progressOperations: ProgressOperation[] = [];
  private progressUnsubscribe?: () => void;

  /** True while an abort is in flight — blocks a double-click firing two. */
  @state() private abortInProgress = false;
  @state() private skipInProgress = false;

  // Search/filter
  @state() private searchFilter: SearchFilter | null = null;

  // Commit context menu
  @state() private contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    commit: Commit | null;
  } = { visible: false, x: 0, y: 0, commit: null };

  // Ref (branch/tag) context menu
  @state() private refContextMenu: {
    visible: boolean;
    x: number;
    y: number;
    refName: string;
    fullName: string;
    refType: 'localBranch' | 'remoteBranch' | 'tag';
    /** The checked-out branch cannot be deleted — see renderRefContextMenu. */
    isHead: boolean;
  } = {
    visible: false,
    x: 0,
    y: 0,
    refName: '',
    fullName: '',
    refType: 'localBranch',
    isHead: false,
  };

  // Conflict resolution dialog. Its open flag AND its snapshotted inputs live
  // in the dialog store as the `conflict` dialog's context — see
  // ConflictDialogContext there for why they are snapshotted rather than
  // live-bound to the loose staging fields below.
  @state() private conflictOperationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' = 'merge';
  // Stash-completion semantics for the conflict dialog (which entry to drop and
  // whether to drop it at all — pop drops, plain apply keeps).
  @state() private conflictStashIndex = 0;
  /** The auto-stash's oid, when the operation reported one. Preferred over the index. */
  @state() private conflictStashOid: string | null = null;
  @state() private conflictDropStashOnComplete = true;
  // Whether a conflicted merge should complete as a squash (single-parent) commit.
  @state() private conflictSquashMerge = false;
  // When a git-flow finish conflicts, the finish context so the dialog can COMPLETE
  // the finish (tag / merge develop / delete branch) after the conflict is resolved.
  @state() private conflictGitflowFinish: GitflowFinishContext | null = null;
  // The file the user clicked to enter the conflict flow — the dialog opens
  // preselected on it instead of always starting at the first conflict.
  @state() private conflictInitialFilePath: string | null = null;
  // False when 'stash' was only inferred from a clean repo state — the dialog
  // must not promise the changes are safe in a stash that may not exist.
  @state() private conflictStashSourceCertain = true;

  // Command palette
  @state() private paletteBranches: Branch[] = [];
  @state() private paletteTrackedFiles: string[] = [];
  private commandPaletteRepositoryPath: string | null = null;
  private commandPaletteRequestId = 0;
  /**
   * Text the palette's search box opens with. Empty for every entry point but
   * the native menu's "Switch Branch…", which opens the palette already
   * filtered to the branch entries rather than the full command list.
   */
  @state() private commandPaletteQuery = '';

  /**
   * Mirror of the graph canvas's loaded commits / tag tips, for the command
   * palette and the export-import dialog.
   *
   * These used to be pulled straight from the canvas inside render()
   * (`.commits=${this.graphCanvas?.getLoadedCommits() ?? []}`), which copied
   * up to a full page of commits and walked the whole ref map on EVERY
   * re-render of this component — and produced a fresh array identity each
   * time, so both consumers rebuilt their lists even while closed. The canvas
   * now announces changes with `graph-commits-changed` and this mirror is
   * refreshed from that (plus once more when the palette opens, so the
   * palette can never show a stale list).
   *
   * `graphPaletteRepositoryPath` is captured in the SAME update as the two
   * lists: the export dialog compares it against its own repositoryPath to
   * decide whether the lists belong to the repo it is showing, so the three
   * must never be sampled at different moments.
   */
  @state() private graphPaletteCommits: Commit[] = [];
  @state() private graphPaletteTags: Array<{ name: string; oid: string }> = [];
  @state() private graphPaletteRepositoryPath = '';

  /**
   * Memoised palette command list. Every entry's action closes over the shell
   * and reads live state when INVOKED (requiresRepository() checks
   * activeRepository at click time), so the only input that changes what the
   * list renders is the modifier-key label — which is the cache key.
   */
  private paletteCommandsCache: PaletteCommand[] | null = null;
  private paletteCommandsCacheKey: string | null = null;

  @state() private vimMode = false;

  // EXPLICIT navigation context for a provider/OIDC dialog opened FROM the
  // profile manager's "Connect a new account" flow. Non-null ONLY while such a
  // dialog is open: it drives the Back arrow, the "Adding to <name>" breadcrumb,
  // and the deterministic return + attach-after-connect. Cleared on every
  // standalone open (command palette/dashboard/toolbar) so those never show a
  // back arrow or auto-attach. Replaces the old open-profile-manager inference.
  @state() private integrationContext: IntegrationOpenContext | null = null;
  // When "Manage Accounts" is opened from a provider dialog, remember which
  // provider so closing the Accounts view can return there — making that
  // navigation reversible rather than a one-way teleport.
  private manageAccountsReturnProvider: IntegrationType | null = null;

  /** Folder the scan dialog was opened for, and which of its two modes. */
  @state() private repositoryScanPath = '';
  @state() private repositoryScanMode: 'scan' | 'offer' = 'scan';
  /** True while an OS drag is over the window, so whichever screen is up —
   *  the welcome screen or an open repository — can show its drop
   *  affordance. The drop is accepted in both states. */
  @state() private fileDragActive = false;

  // Right panel tab tracking
  @state() private activeRightPanelTab: string | undefined;

  // Panel dimensions
  @state() private leftPanelWidth = 220;
  @state() private rightPanelWidth = 350;

  // Panel visibility
  @state() private leftPanelVisible = true;
  @state() private rightPanelVisible = true;
  @state() private globalLoading = false;

  // Resize state
  private resizing: 'left' | 'right' | null = null;
  private resizeStartPos = 0;
  private resizeStartValue = 0;
  // Latest un-applied pointer position while dragging a panel divider, and
  // the frame callback that will apply it. mousemove fires far faster than
  // the display refreshes, and each width assignment re-renders this whole
  // component, so the moves are coalesced into one update per frame.
  private resizePendingClientX: number | null = null;
  private resizeRafId: number | null = null;

  @query('lv-graph-canvas') graphCanvas?: LvGraphCanvas;
  @query('lv-diff-view') private diffView?: LvDiffView;
  @query('lv-create-tag-dialog') createTagDialog?: LvCreateTagDialog;
  @query('lv-create-branch-dialog') createBranchDialog?: LvCreateBranchDialog;
  @query('lv-cherry-pick-dialog') private cherryPickDialog?: LvCherryPickDialog;
  @query('lv-export-import-dialog') exportImportDialog?: LvExportImportDialog;
  @query('#app-rebase-dialog') private interactiveRebaseDialog?: LvInteractiveRebaseDialog;
  @query('lv-profile-manager-dialog') private profileManagerDialog?: LvProfileManagerDialog;
  @query('lv-reflog-dialog') private reflogDialog?: LvReflogDialog;
  @query('lv-describe-dialog') describeDialog?: LvDescribeDialog;
  @query('lv-compare-branches-dialog') compareBranchesDialog?: LvCompareBranchesDialog;
  @query('lv-clean-dialog') private cleanDialog?: LvCleanDialog;
  @query('lv-remote-dialog') private remoteDialog?: LvRemoteDialog;
  @query('lv-repository-health-dialog') private repositoryHealthDialog?: LvRepositoryHealthDialog;
  @query('lv-changelog-dialog') private changelogDialog?: LvChangelogDialog;
  @query('lv-github-dialog') private githubDialog?: LvGitHubDialog;
  @query('lv-gitlab-dialog') private gitlabDialog?: LvGitLabDialog;
  @query('lv-bitbucket-dialog') private bitbucketDialog?: LvBitbucketDialog;
  @query('lv-azure-devops-dialog') private azureDevOpsDialog?: LvAzureDevOpsDialog;

  private unsubscribe?: () => void;
  private unsubscribeUi?: () => void;
  private unsubscribeWatcher?: () => void;
  // Repo paths that currently have a backend file watcher (i.e., all open tabs)
  private watchedRepoPaths = new Set<string>();
  // Background repos that received watcher events and need a refresh when activated
  private staleRepoPaths = new Set<string>();
  // Debounce timers for background tab-badge refreshes, keyed by repo path
  private badgeHydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Last auto-fetch interval applied to the backend (settings subscription
  // must only restart timers when THIS value actually changes)
  /** Repos with a window-focus fetch already running. */
  private focusFetchInFlight = new Set<string>();
  /** Guards the graph ref menu's merge/rebase the way lv-branch-list guards
   * its own: from the graph you could right-click a second ref and start a
   * second history rewrite while the first was still running.
   *
   * Keyed by repo path, like destructiveActionsInFlight below. It used to be a
   * single boolean, so a rebase running in one repo tab greyed out every
   * mutating control in EVERY other open repo — with no banner or tooltip to
   * explain why, because those repos are clean. Separate repos have separate
   * working trees and nothing to serialize against each other. Reassigned
   * rather than mutated so Lit sees the change and re-renders the menus. */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;
  /**
   * Re-render trigger for the dialog store.
   *
   * Which dialogs are open is module state now (see stores/dialog.store.ts), so
   * Lit has nothing of its own to observe. Bumping this from the store
   * subscription is the same trick `refOpsVersion` above uses for the ref lock,
   * and it keeps `await el.updateComplete` after a `dialogs.open(...)` working
   * exactly as it did when each dialog had its own `@state()` flag.
   */
  @state() private dialogVersion = 0;
  private unsubscribeDialogs?: () => void;
  /**
   * Keys for destructive actions already running.
   *
   * Force push, force push tag and force delete are reachable only from an
   * error-suggestion toast's action button, so they never got the
   * claim-before-confirm guard every dialog-hosted destructive button has.
   * Keyed so two repos can each run one, and claimed before the confirm — that
   * confirm is an IPC round trip, and a second dispatch during it would raise a
   * second native prompt for the same operation.
   */
  private destructiveActionsInFlight = new Set<string>();

  /**
   * Claim the graph's working-tree lock for `fn`.
   *
   * The commit context menu's mutating actions live in the same canvas as the
   * ref menu's and touch the same working tree, but were never added to the
   * flag when it was extended by hand — the same stale-enumeration pattern that
   * produced the earlier holes. Wrapping rather than editing each body means no
   * early return can leak the claim.
   */
  private async runRefExclusive(repoPath: string, fn: () => Promise<void>): Promise<void> {
    if (!this.claimRefOperation(repoPath)) {
      // Audible by DEFAULT rather than at a hand-picked set of call sites.
      // A silent return only reads correctly for controls carrying a
      // ?disabled binding, where the refusal is already visible — and every
      // attempt to enumerate "the ones without a binding" has gone stale
      // within a round (toast actions, keyboard shortcuts, palette entries,
      // a batch loop). For a disabled control this can only fire in the race
      // window, where saying so is right too.
      this.warnRepositoryBusy();
      return;
    }
    try {
      await fn();
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  /** The one refusal message every busy-repo path shows. */
  warnRepositoryBusy(): void {
    warnRepositoryBusy();
  }

  /** True when `repoPath` (default: the active repo) has a ref operation running. */
  private isRefOperationInFlight(repoPath?: string): boolean {
    // Reading refOpsVersion is what makes this a reactive binding: the lock
    // itself is module state (shared with the sidebar lists), which Lit cannot
    // observe. The subscription in connectedCallback bumps the counter.
    void this.refOpsVersion;
    return isRefOpRunning(repoPath ?? this.activeRepository?.repository.path);
  }

  /**
   * True when THIS tag already has a push in flight.
   *
   * The tag-push slot is separate from the working-tree lock, so
   * isRefOperationInFlight cannot see it: Force Push Tag holds only the push
   * slot, and holds it across its confirm. Without this the Push Tag item
   * stayed lit through that whole window and the click did nothing but raise a
   * refusal toast — the dead control the lock work exists to remove.
   */
  private isTagPushInFlight(tagName: string, repoPath?: string): boolean {
    void this.refOpsVersion;
    const path = repoPath ?? this.activeRepository?.repository.path;
    return path !== undefined && isPushRunning(pushTagKey(path, tagName));
  }

  /** Claim the lock for `repoPath`; false when it is already held. */
  claimRefOperation(repoPath: string): boolean {
    return tryAcquireRefOp(repoPath);
  }

  releaseRefOperation(repoPath: string): void {
    releaseRefOp(repoPath);
  }

  /** Run `fn` unless an identical action is already in flight. */
  /**
   * Push and Force Push must be mutually exclusive across EVERY surface.
   *
   * `destructiveActionsInFlight` is this component's own state, so the context
   * dashboard's Push button could launch a plain push while the force-push
   * confirm raised from a suggestion toast was still on screen. The shared
   * slot is what both can see.
   */
  /** The same exclusion as runPushExclusive, scoped to one tag. */
  private async runTagPushExclusive(
    repoPath: string,
    tagName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const key = pushTagKey(repoPath, tagName);
    if (!tryAcquirePush(key)) {
      this.warnRepositoryBusy();
      return;
    }
    try {
      await fn();
    } finally {
      releasePush(key);
    }
  }

  private async runPushExclusive(repoPath: string, fn: () => Promise<void>): Promise<void> {
    if (!tryAcquirePush(repoPath)) {
      this.warnRepositoryBusy();
      return;
    }
    try {
      await fn();
    } finally {
      releasePush(repoPath);
    }
  }

  private async runExclusive(key: string, fn: () => Promise<void>): Promise<void> {
    if (this.destructiveActionsInFlight.has(key)) {
      // Audible for the same reason as runRefExclusive: every caller of this
      // helper is a toast action button, whose affordance the click destroys.
      this.warnRepositoryBusy();
      return;
    }
    this.destructiveActionsInFlight.add(key);
    try {
      await fn();
    } finally {
      this.destructiveActionsInFlight.delete(key);
    }
  }
  private lastOfflineMode = false;
  private lastAutoFetchInterval = 0;
  private lastRemoteAllowlistKey = '';
  private refsChangedDebounceTimer?: ReturnType<typeof setTimeout>;
  private updateUnlisteners: UnlistenFn[] = [];
  /** Teardown for the native menu's key-press watcher. */
  private appMenuWatchDispose?: () => void;
  /** Last repository-open state pushed to the native menu, to skip no-op IPC. */
  private appMenuHasRepository?: boolean;
  /** Teardown for the keyboard-settings subscription that refreshes the menu. */
  private appMenuShortcutUnsubscribe?: () => void;
  private shownIntegrationSuggestions: Set<string> = new Set();
  private isRestoringRepositories = false;
  private autoFetchUnsubscribe?: () => void;
  private focusHandler?: () => void;

  // Bound event handlers for cleanup
  private boundHandleMouseMove = this.handleResizeMove.bind(this);
  private boundHandleMouseUp = this.handleResizeEnd.bind(this);

  private boundHandleKeyDown = this.handleKeyDown.bind(this);

  // Prevent browser default context menu globally
  private handleContextMenu = (e: MouseEvent): void => {
    // Allow context menu in text inputs/textareas for copy/paste
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }
    e.preventDefault();
  };

  // Handle repository-refresh events from window (e.g., after commit).
  // External callers expect a full refresh (store + graph + indexes), not just
  // the graph. handleRefresh itself dispatches a `repository-refresh` window
  // event tagged with `detail.source = 'app-shell'` to notify external
  // listeners (context dashboard, etc.); we MUST ignore those tagged events
  // here, otherwise dispatching it from inside handleRefresh would re-trigger
  // handleWindowRefresh in an unbounded loop.
  private handleWindowRefresh = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { source?: string; repoPath?: string } | undefined;
    if (detail?.source === 'app-shell') return;
    // When the refresh names the repo the operation ran on (a sidebar
    // stash/tag/branch success), pin to it — a plain handleRefresh would
    // refresh whichever tab is active if the user switched mid-operation,
    // leaving the originating repo stale until the file watcher notices.
    if (detail?.repoPath) {
      this.refreshConflictDialogRepo(detail.repoPath);
    } else {
      this.handleRefresh();
    }
  };

  /**
   * A fetch, pull or push landed — refresh the repository it ran ON.
   *
   * Raised by remote-operations.service, the one runner behind BOTH surfaces
   * (the shortcuts and palette here, the context dashboard's three buttons),
   * so the two cannot drift apart again. It is a private request rather than
   * the `repository-refresh` broadcast for a reason: every panel listens to
   * that one, and `handleRefresh` emits it itself, so raising it from the
   * runner would refresh the branch list, the analytics panel and the
   * dashboard twice for one fetch.
   *
   * Pinned to the repo in the detail, never the active tab: these are slow
   * network operations and the user can switch tabs while one runs.
   */
  private handleRemoteOperationRefresh = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { repoPath?: string } | undefined;
    this.refreshConflictDialogRepo(detail?.repoPath ?? null);
  };

  // Cycle the active repository tab by offset (wraps around both ends)
  /**
   * Open the branch-cleanup dialog from the command palette.
   *
   * Unlike every sibling palette action, this one cannot just flip a flag on
   * app-shell: the dialog is owned by `lv-branch-list`, which is rendered only
   * while the left panel is visible. With the panel hidden (Ctrl+B) the
   * `open-branch-cleanup` event had no listener at all and the command
   * silently did nothing. Reveal the panel first, then wait for the panel AND
   * its branch list to render — `lv-branch-list` registers the window listener
   * in connectedCallback, so dispatching before it exists is the same dead end.
   */
  async openBranchCleanup(): Promise<void> {
    if (!this.leftPanelVisible) {
      uiStore.getState().togglePanel('left');
      await this.updateComplete;
      const panel = this.renderRoot.querySelector('lv-left-panel') as LitElement | null;
      await panel?.updateComplete;
    }
    window.dispatchEvent(new CustomEvent('open-branch-cleanup'));
  }

  private cycleRepositoryTab(offset: number): void {
    const state = repositoryStore.getState();
    const count = state.openRepositories.length;
    if (count < 2) return;
    const next = (state.activeIndex + offset + count) % count;
    state.setActiveIndex(next);
  }

  // Route file-watcher events. Events for the active repo trigger a
  // (debounced) refresh; events for background repos mark them stale (full
  // refresh happens when their tab activates) and refresh just their tab
  // badge data so the dirty dot / ahead-behind stay live.
  private handleWatcherEvent = (event: watcherService.FileChangeEvent): void => {
    if (event.repoPath !== this.activeRepository?.repository.path) {
      if (this.watchedRepoPaths.has(event.repoPath)) {
        this.staleRepoPaths.add(event.repoPath);
        this.scheduleBadgeHydration(event.repoPath);
      }
      return;
    }
    // The ACTIVE repo's tab badges must stay live too — but only when the
    // right panel is hidden: while it's mounted, lv-file-status already
    // reloads on these events and mirrors into the store, so hydrating here
    // as well would just double every status query.
    if (!this.rightPanelVisible) {
      this.scheduleBadgeHydration(event.repoPath);
    }
    if (event.eventType === 'refs-changed') {
      this.handleRefsChanged();
    }
  };

  // Per-path monotonic sequence for badge hydration: a superseded hydration
  // (an older watcher tick's) must not overwrite a newer one's store write.
  private badgeHydrationSeq = new Map<string, number>();
  private autoFetchStartSeq = new Map<string, number>();
  private autoFetchOperationChains = new Map<string, Promise<void>>();

  /**
   * Tear down every per-repo backend service and client-side cache for a
   * path. Called both when a tab is closed and when the shell itself
   * disconnects, so the two paths can never drift out of sync (a leak the
   * closed-tab path fixed must not silently reappear on remount).
   */
  private teardownRepoServices(path: string): void {
    watcherService.stopWatching(path).catch(() => {
      /* backend watcher already gone */
    });
    searchIndexService.drop(path);
    // Without this the backend keeps fetching (and toasting about) the
    // closed repo forever
    this.stopAutoFetchLogged(path);
    // An ONNX embedding build can run for minutes — don't keep burning CPU
    // for a tab that no longer exists (no-op when nothing builds)
    embeddingIndexService.cancelBuild(path).catch(() => {
      /* nothing to cancel */
    });
    // A later repo at the same path must not flash this repo's graph
    evictGraphCache(path);
    this.staleRepoPaths.delete(path);
    this.focusFetchInFlight.delete(path);
    const pendingHydration = this.badgeHydrationTimers.get(path);
    if (pendingHydration) {
      clearTimeout(pendingHydration);
      this.badgeHydrationTimers.delete(path);
    }
  }

  // Auto-fetch start/stop are fire-and-forget, but a failure must not be
  // fully silent — log it (matching the watcher-start error handling) so a
  // repo silently not auto-fetching is diagnosable.
  private startAutoFetchLogged(
    path: string,
    intervalMinutes: number,
    immediate = false,
  ): void {
    const sequence = (this.autoFetchStartSeq.get(path) ?? 0) + 1;
    this.autoFetchStartSeq.set(path, sequence);
    const previous = this.autoFetchOperationChains.get(path) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.autoFetchStartSeq.get(path) !== sequence) return;
        const r = await gitService.startAutoFetch(path, intervalMinutes);
        if (!r.success) {
          log.warn('Failed to start auto-fetch for', path, r.error?.message);
          // `immediate` means this is the restart after the backend reported
          // FETCH_REMOTE_CHANGED. That loop is still alive and still parked on
          // its timer, so a failed restart leaves it re-reporting the same
          // change every interval while the ahead/behind badge stays frozen —
          // and, without this, saying nothing at all. Clear the dead loop and
          // tell the user their counts are stale.
          //
          // Only while this restart is still the current one, the same guard
          // the success path below applies: `startAutoFetch` is several IPC
          // round trips, and the repo can be closed — or the loop legitimately
          // restarted — while they are in flight. Reporting a superseded
          // restart's failure toasts about a repo the user has already shut,
          // and stops a loop somebody else just started.
          if (immediate && this.autoFetchStartSeq.get(path) === sequence) {
            this.reportAutoFetchFailure(path, r.error?.message);
            await gitService.stopAutoFetch(path);
          }
          return;
        }
        if (this.autoFetchStartSeq.get(path) !== sequence) {
          await gitService.stopAutoFetch(path);
        } else if (immediate) {
          const triggered = await gitService.triggerAutoFetch(path);
          if (!triggered.success) {
            log.warn('Failed to trigger auto-fetch for', path, triggered.error?.message);
          }
        }
      })
      .catch((err) => log.warn('Failed to start auto-fetch for', path, err))
      .finally(() => {
        if (this.autoFetchOperationChains.get(path) === operation) {
          this.autoFetchOperationChains.delete(path);
        }
      });
    this.autoFetchOperationChains.set(path, operation);
  }

  private stopAutoFetchLogged(path: string): void {
    this.autoFetchStartSeq.set(path, (this.autoFetchStartSeq.get(path) ?? 0) + 1);
    const previous = this.autoFetchOperationChains.get(path) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const r = await gitService.stopAutoFetch(path);
        if (!r.success) log.warn('Failed to stop auto-fetch for', path, r.error?.message);
      })
      .catch((err) => log.warn('Failed to stop auto-fetch for', path, err))
      .finally(() => {
        if (this.autoFetchOperationChains.get(path) === operation) {
          this.autoFetchOperationChains.delete(path);
        }
      });
    this.autoFetchOperationChains.set(path, operation);
  }

  private async ensureAutoFetchRunning(path: string): Promise<void> {
    const initialSettings = settingsStore.getState();
    if (initialSettings.autoFetchInterval <= 0 || initialSettings.offlineMode) return;
    const running = await gitService.isAutoFetchRunning(path);
    const settings = settingsStore.getState();
    if (
      running.success &&
      running.data === false &&
      settings.autoFetchInterval > 0 &&
      !settings.offlineMode &&
      repositoryStore
        .getState()
        .openRepositories.some((repo) => repo.repository.path === path)
    ) {
      this.startAutoFetchLogged(path, settings.autoFetchInterval);
    }
  }

  /**
   * Load a repo's status (and, for background repos, branches) into the
   * path-keyed store so its tab badges (dirty dot, ahead/behind) render
   * without the repo ever having been activated. Deliberately light: cheap
   * queries, no graph or index work.
   *
   * For the ACTIVE repo the always-mounted branch list already mirrors
   * branches into the store, so hydrating branches here too would race that
   * (guarded) writer — hydrate only status for the active repo.
   */
  private async hydrateRepoBadges(repoPath: string): Promise<void> {
    const seq = (this.badgeHydrationSeq.get(repoPath) ?? 0) + 1;
    this.badgeHydrationSeq.set(repoPath, seq);
    const isActive = repoPath === this.activeRepository?.repository.path;
    try {
      const [statusResult, branchesResult] = await Promise.all([
        gitService.getStatus(repoPath),
        isActive ? Promise.resolve(null) : gitService.getBranches(repoPath),
      ]);
      // A newer hydration for this path superseded us while we were loading
      if (this.badgeHydrationSeq.get(repoPath) !== seq) return;
      const data: Partial<Omit<OpenRepository, 'repository'>> = {};
      if (statusResult.success && statusResult.data) {
        data.status = statusResult.data;
        data.stagedFiles = statusResult.data.filter((s) => s.isStaged);
        data.unstagedFiles = statusResult.data.filter((s) => !s.isStaged);
      }
      if (branchesResult && branchesResult.success && branchesResult.data) {
        data.branches = branchesResult.data;
        data.currentBranch = branchesResult.data.find((b) => b.isHead) ?? null;
      }
      if (Object.keys(data).length > 0) {
        repositoryStore.getState().updateRepoData(repoPath, data);
      }
    } catch (err) {
      log.warn('Failed to hydrate tab badges for', repoPath, err);
    }
  }

  // Badge hydrations run through a small queue: restoring N tabs must not
  // fire 2×N git walks into the IPC pool at the same instant (the same
  // stampede lazy indexes and staggered auto-fetch exist to avoid).
  private badgeHydrationQueue: string[] = [];
  private badgeHydrationActive = 0;
  private static readonly BADGE_HYDRATION_CONCURRENCY = 2;

  private enqueueBadgeHydration(repoPath: string): void {
    if (this.badgeHydrationQueue.includes(repoPath)) return;
    this.badgeHydrationQueue.push(repoPath);
    this.pumpBadgeHydration();
  }

  private pumpBadgeHydration(): void {
    while (
      this.badgeHydrationActive < AppShell.BADGE_HYDRATION_CONCURRENCY &&
      this.badgeHydrationQueue.length > 0
    ) {
      const repoPath = this.badgeHydrationQueue.shift()!;
      // The repo may have been closed while queued. Checked against the
      // store (not watchedRepoPaths, which the subscription only updates
      // AFTER enqueueing newly opened repos).
      const stillOpen = repositoryStore
        .getState()
        .openRepositories.some((r) => r.repository.path === repoPath);
      if (!stillOpen) continue;
      this.badgeHydrationActive++;
      this.hydrateRepoBadges(repoPath).finally(() => {
        this.badgeHydrationActive--;
        this.pumpBadgeHydration();
      });
    }
  }

  // Debounced badge refresh for watcher events — they can fire in bursts
  // (builds, npm install), one status query per second per repo is plenty
  private scheduleBadgeHydration(repoPath: string): void {
    if (this.badgeHydrationTimers.has(repoPath)) return;
    this.badgeHydrationTimers.set(
      repoPath,
      setTimeout(() => {
        this.badgeHydrationTimers.delete(repoPath);
        if (this.watchedRepoPaths.has(repoPath)) {
          this.enqueueBadgeHydration(repoPath);
        }
      }, 1000)
    );
  }

  // Handle refs-changed from file watcher (debounced)
  private handleRefsChanged = (): void => {
    if (this.refsChangedDebounceTimer) {
      clearTimeout(this.refsChangedDebounceTimer);
    }
    this.refsChangedDebounceTimer = setTimeout(() => {
      this.handleRefresh();
    }, 200);
  };

  // Handle open-conflict-dialog events from child components (e.g., interactive rebase)
  private handleOpenConflictDialogEvent = (e: Event): void => {
    const customEvent = e as CustomEvent<{
      operationType?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash';
      stashIndex?: number;
      stashOid?: string | null;
      dropStashOnComplete?: boolean;
      squash?: boolean;
      gitflowFinish?: GitflowFinishContext;
      filePath?: string;
      repositoryPath?: string;
    }>;
    if (customEvent.detail?.operationType) {
      this.conflictOperationType = customEvent.detail.operationType;
      // Thread stash-completion semantics so the dialog drops the correct entry
      // (and only when the failed operation had pop semantics).
      this.conflictStashIndex = customEvent.detail?.stashIndex ?? 0;
      this.conflictStashOid = customEvent.detail?.stashOid ?? null;
      this.conflictDropStashOnComplete = customEvent.detail?.dropStashOnComplete ?? true;
      // A squash finish that conflicted must complete as a squash, not a merge commit.
      this.conflictSquashMerge = customEvent.detail?.squash ?? false;
      // A conflicted git-flow finish carries the context to complete the finish.
      this.conflictGitflowFinish = customEvent.detail?.gitflowFinish ?? null;
      this.conflictInitialFilePath = customEvent.detail?.filePath ?? null;
      // An explicit operation always knows its source — clear any uncertainty
      // left over from a previous state-inferred stash flow.
      this.conflictStashSourceCertain = true;
      this.openConflictDialogPinned(customEvent.detail?.repositoryPath);
    } else {
      // No operation context (the diff view's "Open Merge Editor" button, a
      // conflicted-file stage click): derive the operation from repository
      // state, keeping the clicked file preselected when one was given.
      this.openConflictDialogFromState(customEvent.detail?.filePath);
    }
    this.refreshConflictDialogRepo(customEvent.detail?.repositoryPath ?? null);
  };

  // Handle merge-conflict events from branch list (e.g., sidebar merge resulting in conflicts)
  private handleMergeConflictEvent = (e?: Event): void => {
    const detail = (
      e as CustomEvent<{ repositoryPath?: string; operationType?: 'merge' | 'rebase' }> | undefined
    )?.detail;
    // A pull configured to rebase raises REBASE_CONFLICT, and the dialog's
    // Complete/Abort actions differ per operation — continuing a rebase is not
    // committing a merge. Dispatchers that omit the type are all merges, so the
    // default keeps them working unchanged.
    this.conflictOperationType = detail?.operationType ?? 'merge';
    this.resetConflictDetailState();
    this.openConflictDialogPinned(detail?.repositoryPath);
    this.refreshConflictDialogRepo(detail?.repositoryPath ?? null);
  };

  /**
   * Open the conflict dialog with the staged conflict* fields snapshotted
   * and pinned to the repository that is active NOW. Refuses to retarget an
   * ALREADY-OPEN dialog: a new conflicting operation on another repo (or
   * even this one) must not hijack an in-flight resolution's repo,
   * operation type, or completion semantics.
   */
  private openConflictDialogPinned(repoPathOverride?: string): void {
    // The conflicting operation ran on a repo path captured BEFORE its
    // await — pass that path in. Falling back to the active repo is only
    // safe for synchronous open paths; after an await the user may have
    // switched tabs, and pinning the now-active repo would trap them in a
    // dialog whose Complete/Abort target a repo with no operation at all.
    const repoPath = repoPathOverride ?? this.activeRepository?.repository.path;
    if (!repoPath) return;
    // The tab may have been CLOSED during the operation's await — a dialog
    // pinned to a closed repo would float over the empty screen with a
    // post-close refresh that no-ops. The repo on disk still holds the
    // in-progress operation; re-opening the tab surfaces it again.
    if (
      repoPath !== this.activeRepository?.repository.path &&
      !repositoryStore.getState().openRepositories.some((r) => r.repository.path === repoPath)
    ) {
      showToast(
        'Conflicts were detected in a repository whose tab was closed — reopen it to resolve them',
        'warning',
      );
      return;
    }
    if (dialogs.isOpen('conflict')) {
      showToast(
        'A conflict resolution is already in progress — finish or close it first',
        'warning',
      );
      return;
    }
    dialogs.open('conflict', {
      repoPath,
      operationType: this.conflictOperationType,
      initialFilePath: this.conflictInitialFilePath,
      stashSourceCertain: this.conflictStashSourceCertain,
      stashIndex: this.conflictStashIndex,
      stashOid: this.conflictStashOid,
      dropStashOnComplete: this.conflictDropStashOnComplete,
      squashMerge: this.conflictSquashMerge,
      gitflowFinish: this.conflictGitflowFinish,
    });
  }

  /**
   * The conflict dialog's snapshotted inputs, or null while it is shut.
   *
   * Read through the store rather than a field of its own: the snapshot IS the
   * dialog's open-time context, so it is created and dropped by the same
   * `dialogs.open('conflict', …)` / `dialogs.close('conflict')` calls and
   * cannot drift out of step with the flag the way two fields could.
   */
  private get conflictDialogConfig(): ConflictDialogContext | null {
    return dialogs.context('conflict');
  }

  private closeConflictDialog(): void {
    dialogs.close('conflict');
  }

  /** The file the history pane is showing, or null while it is shut. */
  private get fileHistoryPath(): string | null {
    return dialogs.context('fileHistory')?.filePath ?? null;
  }

  /** Which mode the search dialog opened in. */
  private get searchDialogMode(): SearchDialogMode {
    return dialogs.context('search')?.mode ?? 'files';
  }

  /** Which view the Profile Manager should open to. */
  private get profileManagerView(): '' | 'accounts' {
    return dialogs.context('profileManager')?.initialView ?? '';
  }

  // Reset the conflict-dialog completion semantics to defaults so a value set by a
  // prior operation (e.g. squash=true from a git-flow squash finish, or a non-zero
  // stash index) can't leak into an unrelated conflict resolution.
  private resetConflictDetailState(): void {
    this.conflictStashIndex = 0;
    this.conflictStashOid = null;
    this.conflictDropStashOnComplete = true;
    this.conflictSquashMerge = false;
    this.conflictGitflowFinish = null;
    this.conflictInitialFilePath = null;
    this.conflictStashSourceCertain = true;
  }

  // Handle gitflow events (init, feature/release/hotfix operations) to trigger refresh
  private handleGitflowEvent = (e: Event): void => {
    // Pinned refresh, like every other operation completion: the gitflow
    // command ran on the repo the panel showed at click time, which may be
    // backgrounded by the time it finishes.
    const detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    this.refreshConflictDialogRepo(detail?.repositoryPath ?? null);
  };

  // Handle show-commit events (e.g., from reflog dialog "Show in graph")
  private handleShowCommitEvent = (e: Event): void => {
    const customEvent = e as CustomEvent<{ oid: string }>;
    if (customEvent.detail?.oid) {
      this.revealCommitInGraph(customEvent.detail.oid);
    }
  };

  // Handle settings-changed events from settings dialog to re-render with new settings
  private handleSettingsChanged = (): void => {
    this.requestUpdate();
  };

  connectedCallback(): void {
    super.connectedCallback();
    // The ref lock is module state shared with the sidebar lists, so a claim
    // taken there must re-render this component's ?disabled bindings too.
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });

    // A freshly mounted shell shows nothing, exactly as it did when every
    // dialog was a `@state()` flag initialised to false on the instance. The
    // store is module state and outlives an instance, so it is cleared here
    // rather than inherited from whatever the previous shell left open.
    dialogs.reset();
    this.unsubscribeDialogs = dialogStore.subscribe(() => {
      this.dialogVersion++;
    });

    this.unsubscribe = repositoryStore.subscribe((state) => {
      const newActiveRepo = state.getActiveRepository();
      const repoChanged = this.activeRepository?.repository.path !== newActiveRepo?.repository.path;
      this.activeRepository = newActiveRepo;

      // Repository-scoped menu items must be greyed out the moment the last
      // tab closes, and live again the moment one opens.
      this.syncAppMenuState(state.openRepositories.length > 0);

      // Every repo-scoped dialog must die with the last repository.      //
      // These dialogs render inside the `${this.activeRepository ? ...}` block,
      // so closing the last tab destroys the ELEMENT while its open flag stays
      // set. Open the next repository and the element is reconstructed with
      // ?open=true — a full-screen overlay springing up unbidden over a repo
      // the user just opened, freshly constructed with every button
      // re-enabled. lv-repository-health-dialog carries that exact story, and
      // lv-bisect-dialog then reproduced it because it has no pinned path and
      // so was in neither hand-written sweep.
      //
      // This used to reflect over Lit's reactive-property map and match field
      // names against /^show[A-Z]/, minus a hand-kept exclusion list, because
      // nothing enumerated the dialogs. DIALOG_REGISTRY does, so it is now a
      // plain loop over the dialogs declared `repoScoped` — and repo-scoping is
      // a property of the dialog rather than of how its field was named. The
      // default is still the safe one: a newly declared dialog is repo-scoped
      // unless it says otherwise.
      if (state.openRepositories.length === 0) {
        dialogs.closeRepoScoped();
      }

      // Closing the pinned repo's TAB while its conflict dialog is up
      // would leave the dialog floating over whatever renders next, with
      // dead completion plumbing (the open-time guard only covers closes
      // during the triggering operation's await). Close it with an
      // explanation — the operation itself persists on disk and resurfaces
      // when the repo is reopened.
      if (
        dialogs.isOpen('conflict') &&
        this.conflictDialogConfig &&
        !state.openRepositories.some(
          (r) => r.repository.path === this.conflictDialogConfig!.repoPath,
        )
      ) {
        this.closeConflictDialog();
        showToast(
          'The repository tab was closed — reopen it to continue resolving its conflicts',
          'warning',
        );
      }

      // ONE sweep for EVERY repo-scoped dialog. They all pin to their repo at
      // open() and stay open across tab switches, so closing the pinned tab
      // must dismiss them — otherwise they float over another repo and their
      // next click runs against a repository that is no longer in the tab bar.
      //
      // Discovery is from the DOM (`pinnedRepositoryPathIfOpen`), not a list of
      // tag names. This used to be seven hand-written arms plus a hand-written
      // table, and the arms were the stale half: each one force-cleared the
      // host flag or called a bare `close()`, bypassing the dialog's OWN
      // in-flight guard, so closing a tab mid-`clean_files` reported "clean
      // cancelled" and then deleted 4,913 files anyway. The sweep now consults
      // `operationInFlight` — the same flag `dismiss()`/`handleModalClose()`
      // refuse on — and NEVER announces a dismissal that did not happen.
      //
      // The table below only supplies wording and the host flag to clear; a
      // dialog missing from it is still swept, with generic wording.
      sweepRepoScopedDialogs({
        root: this.renderRoot,
        isRepoOpen: (path) =>
          state.openRepositories.some((r) => r.repository.path === path),
        hostHasRepositories: state.openRepositories.length > 0,
        entries: {
          'lv-cherry-pick-dialog': {
            dismissed: 'cherry-pick cancelled',
            running: 'cherry-pick',
          },
          'lv-interactive-rebase-dialog': {
            dismissed: 'interactive rebase cancelled',
            running: 'interactive rebase',
          },
          // create-branch even moves HEAD via checkout, so a "cancelled" it did
          // not honour is a silent mutation of a repo not in the tab bar.
          'lv-create-tag-dialog': {
            dismissed: 'tag creation cancelled',
            running: 'tag creation',
          },
          'lv-create-branch-dialog': {
            dismissed: 'branch creation cancelled',
            running: 'branch creation',
          },
          'lv-clean-dialog': {
            dismissed: 'clean cancelled',
            running: 'clean',
            clearFlag: () => { dialogs.close('clean'); },
          },
          // No clearFlag: this dialog owns its own open state via open()/close(),
          // like lv-create-branch-dialog.
          'lv-export-import-dialog': {
            dismissed: 'export/import cancelled',
            running: 'patch/bundle operation',
          },
          'lv-reflog-dialog': {
            dismissed: 'undo history closed',
            running: 'reset',
            clearFlag: () => { dialogs.close('reflog'); },
          },
          // Read-only: it never reports work in flight, so the sweep always
          // takes the dismissal branch here.
          'lv-describe-dialog': {
            dismissed: 'describe closed',
            running: 'describe',
          },
          'lv-compare-branches-dialog': {
            dismissed: 'branch comparison closed',
            running: 'branch comparison',
          },
          'lv-search-dialog': {
            dismissed: 'search closed',
            running: 'search',
            clearFlag: () => { dialogs.close('search'); },
          },
          'lv-remote-dialog': {
            dismissed: 'remote management closed',
            running: 'remote update',
            clearFlag: () => { dialogs.close('remotes'); },
          },
          // Closing this one DESTROYS the element (its render block is gated on
          // the repositoryHealth dialog), so it implements closeWhenIdle() and the
          // sweep hands the close over rather than orphaning a running gc.
          'lv-repository-health-dialog': {
            dismissed: 'repository health closed',
            running: 'maintenance operation',
            clearFlag: () => { dialogs.close('repositoryHealth'); },
          },
          'lv-worktree-dialog': {
            dismissed: 'worktrees closed',
            running: 'worktree removal',
            clearFlag: () => { dialogs.close('worktrees'); },
          },
          'lv-submodule-dialog': {
            dismissed: 'submodules closed',
            running: 'submodule removal',
            clearFlag: () => { dialogs.close('submodules'); },
          },
          'lv-lfs-dialog': {
            dismissed: 'Git LFS closed',
            running: 'LFS prune',
            clearFlag: () => { dialogs.close('lfs'); },
          },
          'lv-gpg-dialog': {
            dismissed: 'signing settings closed',
            running: 'signing update',
            clearFlag: () => { dialogs.close('gpg'); },
          },
          'lv-config-dialog': {
            dismissed: 'configuration closed',
            running: 'configuration save',
            clearFlag: () => { dialogs.close('config'); },
          },
          'lv-credentials-dialog': {
            dismissed: 'credentials closed',
            running: 'credential test',
            clearFlag: () => { dialogs.close('credentials'); },
          },
          'lv-hooks-dialog': {
            dismissed: 'hooks closed',
            running: 'hook save',
            clearFlag: () => { dialogs.close('hooks'); },
          },
          'lv-gitignore-dialog': {
            dismissed: 'ignore rules closed',
            running: 'ignore rule update',
            clearFlag: () => { dialogs.close('gitignore'); },
          },
          'lv-changelog-dialog': {
            dismissed: 'changelog closed',
            running: 'changelog generation',
          },
        },
      });

      // The open diff binds a click-time StatusEntry snapshot. Re-derive it
      // from every status refresh so a file that became conflicted since the
      // click (e.g. a merge run in an external terminal) hits the diff view's
      // isConflicted guards instead of rendering raw marker text — and stays
      // in sync in the other direction once it's resolved.
      if (this.diffFile && !repoChanged && newActiveRepo) {
        const fresh =
          newActiveRepo.status.find(
            (f) => f.path === this.diffFile!.path && f.isStaged === this.diffFile!.isStaged
          ) ?? newActiveRepo.status.find((f) => f.path === this.diffFile!.path);
        // Only swap on a real transition — reassigning every refresh would
        // needlessly reload the visible diff.
        if (
          fresh &&
          (fresh.isConflicted !== this.diffFile.isConflicted ||
            fresh.status !== this.diffFile.status)
        ) {
          this.diffFile = fresh;
        } else if (!fresh && this.diffFile.isConflicted) {
          // A conflicted file that left the status entirely was resolved and
          // committed (e.g. Complete Merge) — close the diff rather than
          // showing a permanently stale "has merge conflicts" interstitial.
          // Not a gesture, but the same unmount: if the user was mid-edit on
          // that file the typed text goes with the pane, so say so.
          this.warnIfDiscardingEdits();
          this.diffFile = null;
          dialogs.close('diff');
        }
      }

      // Start/stop per-repo services as tabs open and close. Every OPEN repo
      // gets a watcher (not just the active one) so background repos don't go
      // silently stale; closed repos release their watcher and search index.
      const openPaths = new Set(state.openRepositories.map((r) => r.repository.path));
      for (const path of openPaths) {
        if (!this.watchedRepoPaths.has(path)) {
          watcherService.startWatching(path).catch((err) => {
            // watcher.service already warns the user that auto-refresh is
            // unavailable (with the actionable cause); don't toast twice
            log.warn('Failed to start file watcher:', err);
          });
          const autoFetchInterval = settingsStore.getState().autoFetchInterval;
          if (autoFetchInterval > 0) {
            this.startAutoFetchLogged(path, autoFetchInterval);
          }
          // Populate tab badge data (dirty dot, ahead/behind) — background
          // tabs are never rendered by the status/branch panels, so without
          // this a restored-but-never-activated tab shows no badges at all
          this.enqueueBadgeHydration(path);
        }
      }
      for (const path of this.watchedRepoPaths) {
        if (!openPaths.has(path)) {
          this.teardownRepoServices(path);
        }
      }
      this.watchedRepoPaths = openPaths;

      // Clear view state when switching repositories
      if (repoChanged) {
        this.commandPaletteRequestId++;
        dialogs.close('commandPalette');
        this.commandPaletteRepositoryPath = null;
        this.commandPaletteQuery = '';
        this.paletteBranches = [];
        this.paletteTrackedFiles = [];
        // Clear selected commit and refs
        this.selectedCommit = null;
        this.selectedCommitRefs = [];
        // The graph clears its own selection on a repository switch without
        // announcing it (there is no commit to announce), so the multi-select
        // list has to be dropped here or the next repo's commit menu would
        // offer batch actions over the previous repo's commits.
        this.selectedCommits = [];

        // Same gesture-owned teardown as handleCloseDiff: the tab switch
        // unmounts the editor along with the pane.
        this.warnIfDiscardingEdits();

        // Close any open overlays
        dialogs.close('diff');
        this.diffFile = null;
        this.diffCommitFile = null;
        dialogs.close('blame');
        this.blameFile = null;
        this.blameCommitOid = null;
        dialogs.close('fileHistory');

        // Graph context-menu entries are scoped to the repository that
        // produced their commit/ref. Leaving either menu open across a tab
        // switch lets a subsequent click resolve against the new active repo.
        this.contextMenu = { ...this.contextMenu, visible: false };
        this.refContextMenu = { ...this.refContextMenu, visible: false };

        // Clear search filter
        this.searchFilter = null;

        // Load profile for new repository and check integration
        if (newActiveRepo) {
          gitService.loadProfileForRepository(newActiveRepo.repository.path);
          // Only check integration / build indexes if not restoring repos on
          // startup (restore handles the final active repo itself)
          if (!this.isRestoringRepositories) {
            this.checkRepositoryIntegration(newActiveRepo.repository.path);
            // Indexes build lazily on first activation of a tab
            this.ensureRepoIndexes(newActiveRepo.repository.path);
          }
          // Load remotes if not already loaded
          if (!newActiveRepo.remotes || newActiveRepo.remotes.length === 0) {
            this.loadRepositoryRemotes(newActiveRepo.repository.path);
          }
          // If this repo changed while it was a background tab, its store
          // data and graph are stale — refresh now that it's visible.
          if (this.staleRepoPaths.delete(newActiveRepo.repository.path)) {
            this.handleRefresh();
          }
        }
      }
    });
    this.unsubscribeUi = uiStore.subscribe((state) => {
      this.leftPanelVisible = state.panels.left.isVisible;
      this.rightPanelVisible = state.panels.right.isVisible;
      this.globalLoading = state.globalLoading;
    });
    // Subscribe to file watcher events (routing logic in handleWatcherEvent)
    this.unsubscribeWatcher = watcherService.onFileChange(this.handleWatcherEvent);
    document.addEventListener('keydown', this.boundHandleKeyDown);
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('repository-refresh', this.handleWindowRefresh);
    window.addEventListener('remote-operation-refresh', this.handleRemoteOperationRefresh);
    window.addEventListener('trigger-pull', this.handleTriggerPull);
    window.addEventListener('force-delete-branch', this.handleForceDeleteBranch as EventListener);
    window.addEventListener('open-settings', this.handleOpenSettings);
    window.addEventListener('open-git-config', this.handleOpenGitConfig);
    window.addEventListener('trigger-abort', this.handleTriggerAbort);
    window.addEventListener('force-push', this.handleForcePush);
    window.addEventListener('force-push-tag', this.handleForcePushTag);
    this.addEventListener('open-conflict-dialog', this.handleOpenConflictDialogEvent);
    this.addEventListener('merge-conflict', this.handleMergeConflictEvent);
    this.addEventListener('gitflow-initialized', this.handleGitflowEvent);
    this.addEventListener('gitflow-operation', this.handleGitflowEvent);
    // Host-level, so it catches the event once wherever the dialog is mounted.
    // Do NOT also bind @rebase-complete on the dialog element: the event
    // bubbles composed, so both would fire and every rebase would run two full
    // refreshes (two open_repository round trips, two graph rebuilds).
    this.addEventListener('rebase-complete', this.handleRebaseComplete);
    this.addEventListener('show-commit', this.handleShowCommitEvent);
    window.addEventListener('settings-changed', this.handleSettingsChanged);
    window.addEventListener(REPOSITORY_SCAN_OFFER_EVENT, this.handleRepositoryScanOffer);
    // OS folder drops open repositories from anywhere in the app, not just
    // the welcome screen.
    void this.setupWindowDropListener();

    // Load vim mode from keyboard service
    this.vimMode = keyboardService.isVimMode();

    // Set up remote operation event listeners (for auto-fetch notifications)
    gitService.setupRemoteOperationListeners();

    // Record the backend's real `git` invocations (interactive rebase, force
    // push, difftool, LFS, …) into the Output panel's log.
    void startGitCommandLogging();

    // Load profiles
    gitService.loadProfiles();

    // Check for unified profiles migration
    this.checkUnifiedProfilesMigration();

    // Start periodic token validation for integration accounts
    unifiedProfileService.startPeriodicTokenValidation();

    // Restore previously open repositories
    this.restorePersistedRepositories();

    // Load workspaces
    this.loadWorkspaces();

    // Set up auto-fetch based on settings
    this.setupAutoFetch();

    // Set up window focus handler for fetch-on-focus
    this.focusHandler = () => {
      if (!settingsStore.getState().fetchOnFocus || !this.activeRepository) return;
      // "Fetch on Window Focus" used to call getRemoteStatus, which only runs
      // graph_ahead_behind over refs already on disk — no network. It
      // recomputed a number that could not have changed, so the setting never
      // did anything. Fetch first, then read the counts — via the background
      // route, because alt-tabbing back into the app is not a gesture that
      // should raise a native "Allow fetch?" modal.
      // Pinned: the user can switch tabs during the fetch; the result belongs
      // to the repo it was started for, so the write below is keyed by that
      // path rather than gated on whichever tab is active when it lands —
      // which is also why the focus fetch now refreshes that repo's TAB badge,
      // which it previously left stale.
      const repoPath = this.activeRepository.repository.path;
      // Alt-tabbing repeatedly used to start a fetch per focus event; on a hung
      // remote they stacked with nothing to cancel them.
      if (this.focusFetchInFlight.has(repoPath)) return;
      this.focusFetchInFlight.add(repoPath);
      void (async () => {
        try {
        await gitService.fetchInBackground(repoPath);
        const result = await gitService.getRemoteStatus(repoPath);
        if (result.success && result.data) {
          this.applyAheadBehind(repoPath, result.data.ahead, result.data.behind);
        }
        } finally {
          this.focusFetchInFlight.delete(repoPath);
        }
      })();
    };
    window.addEventListener('focus', this.focusHandler);

    // Listen for auto-fetch events
    this.setupAutoFetchListeners();

    // Set up update notification listeners
    this.setupUpdateListeners();

    // Surface background model-download failures even when Settings is closed
    this.setupModelDownloadListeners();

    // Initialize OAuth deep link listener
    initOAuthListener().catch((e) => {
      log.warn('Failed to initialize OAuth listener:', e);
    });

    // Register keyboard shortcuts
    registerDefaultShortcuts({
      navigateUp: () => this.graphCanvas?.navigatePrevious?.(),
      navigateDown: () => this.graphCanvas?.navigateNext?.(),
      navigateFirst: () => this.graphCanvas?.navigateFirst?.(),
      navigateLast: () => this.graphCanvas?.navigateLast?.(),
      pageUp: () => this.graphCanvas?.navigatePageUp?.(),
      pageDown: () => this.graphCanvas?.navigatePageDown?.(),
      selectCommit: () => {/* handled by graph canvas */},
      stageAll: this.requiresRepository(() => this.handleStageAll()),
      unstageAll: this.requiresRepository(() => this.handleUnstageAll()),
      commit: () => {/* handled by commit panel */},
      refresh: () => this.handleRefresh(),
      search: () => this.handleToggleSearch(),
      openSettings: () => { dialogs.open('settings'); },
      openShortcuts: () => { dialogs.open('shortcuts'); },
      toggleLeftPanel: () => this.toggleLeftPanel(),
      toggleRightPanel: () => uiStore.getState().togglePanel('right'),
      openCommandPalette: () => this.openCommandPalette(),
      openReflog: this.requiresRepository(() => { dialogs.open('reflog'); }),
      // Wrapped like the palette entries: pressing Ctrl+Shift+F on the welcome
      // screen used to do nothing at all while the same command from the
      // palette explained that a repository is needed.
      fetch: this.requiresRepository(() => this.handleFetch()),
      pull: this.requiresRepository(() => this.handlePull()),
      push: this.requiresRepository(() => this.handlePush()),
      createStash: this.requiresRepository(() => this.handleCreateStash()),
      createBranch: this.requiresRepository(() => this.createBranchDialog?.open()),
      closeDiff: () => this.handleCloseOverlay(),
      nextTab: () => this.cycleRepositoryTab(1),
      previousTab: () => this.cycleRepositoryTab(-1),
      selectTab: (index) => repositoryStore.getState().setActiveIndex(index),
    });

    // Wire the native application menu. AFTER registerDefaultShortcuts, so the
    // accelerators pushed to the menu are the bindings that actually exist.
    void this.setupAppMenu();

    // Subscribe to progress updates
    this.progressUnsubscribe = progressService.subscribe((operations) => {
      this.progressOperations = operations;
    });
  }

  // SAFETY: All event listeners registered in connectedCallback are properly removed here.
  // Verified: every addEventListener has a corresponding removeEventListener below.
  disconnectedCallback(): void {
    super.disconnectedCallback();
    stopGitCommandLogging();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    this.unsubscribeDialogs?.();
    this.unsubscribeDialogs = undefined;
    this.unsubscribe?.();
    this.unsubscribeUi?.();
    this.unsubscribeWatcher?.();
    if (this.refsChangedDebounceTimer) {
      clearTimeout(this.refsChangedDebounceTimer);
    }
    for (const timer of this.badgeHydrationTimers.values()) {
      clearTimeout(timer);
    }
    this.badgeHydrationTimers.clear();
    // Tear down per-repo backend services so a remount (hot reload, tests)
    // doesn't leave orphaned watchers, auto-fetch tasks, commit indexes, or
    // in-flight embedding builds running. Uses the exact same teardown as
    // closing a tab so the two paths can't drift.
    for (const path of this.watchedRepoPaths) {
      this.teardownRepoServices(path);
    }
    this.watchedRepoPaths.clear();
    this.staleRepoPaths.clear();
    this.cancelPendingResizeFrame();
    this.resizePendingClientX = null;
    document.removeEventListener('mousemove', this.boundHandleMouseMove);
    document.removeEventListener('mouseup', this.boundHandleMouseUp);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('repository-refresh', this.handleWindowRefresh);
    window.removeEventListener('remote-operation-refresh', this.handleRemoteOperationRefresh);
    window.removeEventListener('trigger-pull', this.handleTriggerPull);
    window.removeEventListener('force-delete-branch', this.handleForceDeleteBranch as EventListener);
    window.removeEventListener('open-settings', this.handleOpenSettings);
    window.removeEventListener('open-git-config', this.handleOpenGitConfig);
    window.removeEventListener('trigger-abort', this.handleTriggerAbort);
    window.removeEventListener('force-push', this.handleForcePush);
    window.removeEventListener('force-push-tag', this.handleForcePushTag);
    this.removeEventListener('open-conflict-dialog', this.handleOpenConflictDialogEvent);
    this.removeEventListener('merge-conflict', this.handleMergeConflictEvent);
    this.removeEventListener('gitflow-initialized', this.handleGitflowEvent);
    this.removeEventListener('gitflow-operation', this.handleGitflowEvent);
    this.removeEventListener('rebase-complete', this.handleRebaseComplete);
    this.removeEventListener('show-commit', this.handleShowCommitEvent);
    window.removeEventListener('settings-changed', this.handleSettingsChanged);
    window.removeEventListener(REPOSITORY_SCAN_OFFER_EVENT, this.handleRepositoryScanOffer);
    this.dropUnlisten?.();
    this.dropUnlisten = undefined;
    gitService.cleanupRemoteOperationListeners();
    // Clean up auto-fetch
    this.autoFetchUnsubscribe?.();
    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
    }
    // Stop periodic token validation
    unifiedProfileService.stopPeriodicTokenValidation();
    // Clean up update listeners
    this.updateUnlisteners.forEach((unlisten) => unlisten());
    this.updateUnlisteners = [];
    // Unsubscribe from progress service
    this.progressUnsubscribe?.();
    // Tear down the native menu wiring (its Tauri listener rides in
    // updateUnlisteners, torn down just above)
    this.appMenuWatchDispose?.();
    this.appMenuWatchDispose = undefined;
    this.appMenuShortcutUnsubscribe?.();
    this.appMenuShortcutUnsubscribe = undefined;
    this.appMenuHasRepository = undefined;
  }

  private async checkUnifiedProfilesMigration(): Promise<void> {
    try {
      // Initialize unified profiles - this loads profiles and checks migration
      await unifiedProfileService.initializeUnifiedProfiles();

      // Check if migration is still needed (user hasn't migrated yet)
      const needsMigration = await unifiedProfileService.checkMigrationNeeded();
      if (needsMigration) {
        // Show migration dialog after a short delay to let the UI settle
        setTimeout(() => {
          dialogs.open('migration');
        }, 500);
      }
    } catch (error) {
      log.error('Failed to initialize unified profiles:', error);
    }
  }

  private async setupUpdateListeners(): Promise<void> {
    // Update available - show notification
    const unlistenAvailable = await updateService.onUpdateAvailable((event) => {
      showToast(
        `Update available: v${event.latestVersion}`,
        'info',
        10000
      );
    });
    this.updateUnlisteners.push(unlistenAvailable);

    // Update downloading
    const unlistenDownloading = await updateService.onUpdateDownloading(() => {
      showToast('Downloading update...', 'info', 5000);
    });
    this.updateUnlisteners.push(unlistenDownloading);

    // Update ready - will restart
    const unlistenReady = await updateService.onUpdateReady(() => {
      showToast('Update installed - restarting...', 'success', 3000);
    });
    this.updateUnlisteners.push(unlistenReady);

    // Update error
    const unlistenError = await updateService.onUpdateError((error) => {
      showToast(`Update failed: ${error.message}`, 'error', 8000);
    });
    this.updateUnlisteners.push(unlistenError);
  }

  /**
   * Model downloads run in a backend task and outlive the Settings dialog that
   * started them, so the shell - not the dialog - owns the failure listener.
   * Without it a download that fails after Settings is closed is silent.
   */
  private async setupModelDownloadListeners(): Promise<void> {
    this.updateUnlisteners.push(await localAiService.listenForModelDownloadFailures());
  }

  /**
   * Check if repository has integration configured and suggest if not
   */
  private async checkRepositoryIntegration(repoPath: string): Promise<void> {
    // Don't check the same repo twice - add immediately to prevent race conditions
    if (this.shownIntegrationSuggestions.has(repoPath)) {
      return;
    }
    this.shownIntegrationSuggestions.add(repoPath);

    try {
      const suggestion = await gitService.detectRepositoryIntegration(repoPath);

      if (suggestion && !suggestion.isConfigured) {
        const features = suggestion.features.slice(0, 2).join(', ');
        showToast(
          `${suggestion.providerName} repository detected. Connect to enable ${features}.`,
          'info',
          12000,
          {
            label: 'Configure',
            callback: () => this.openIntegrationDialog(suggestion.provider),
          }
        );
      }
    } catch {
      // Silently fail - this is a nice-to-have feature
    }
  }

  private openIntegrationDialog(provider: string | null): void {
    // Suggestion-driven open: standalone (no return target, no auto-attach).
    switch (provider) {
      case 'github':
        this.openIntegrationStandalone('github');
        break;
      case 'gitlab':
        this.openIntegrationStandalone('gitlab');
        break;
      case 'bitbucket':
        this.openIntegrationStandalone('bitbucket');
        break;
      case 'ado':
        this.openIntegrationStandalone('azure-devops');
        break;
      case 'oidc':
        this.openIntegrationStandalone('oidc');
        break;
    }
  }

  private handleKeyDown(_e: KeyboardEvent): void {
    // Keyboard shortcuts are handled by the keyboard service.
    //
    // There used to be a `?` arm here "because of the shift key". It matched
    // with no input-focus check and called preventDefault(), so typing a
    // question mark ANYWHERE — commit message, search, branch-rename prompt,
    // hook editor — was impossible: the character was swallowed and the
    // shortcuts dialog opened instead. keyboard.service registers the same
    // shortcut and does bail inside inputs, but it bails by returning, and
    // stopPropagation cannot suppress a sibling listener on the same node,
    // so this copy always won. The guarded registration is the only one now.
  }

  /**
   * Walk a DOM subtree, descending through shadow roots, for a blocking
   * overlay: any open lv-modal, or any dialog reflecting `open`.
   */
  private static containsOpenModal(
    root: ParentNode,
    seen: Set<ShadowRoot>,
    depth = 0,
  ): boolean {
    if (depth > 10) return false;
    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName;
      if (tag === 'LV-MODAL' && el.hasAttribute('open')) return true;
      if (tag.startsWith('LV-') && tag.endsWith('-DIALOG') && el.hasAttribute('open')) return true;
      const shadow = el.shadowRoot;
      if (shadow && !seen.has(shadow)) {
        seen.add(shadow);
        if (AppShell.containsOpenModal(shadow, seen, depth + 1)) return true;
      }
    }
    return false;
  }

  /**
   * True when any dialog is showing a blocking overlay.
   *
   * Walks from document.body, not from this element. Two earlier attempts
   * drifted by enumerating dialogs; the third fixed that but still hard-coded
   * its ROOT as app-shell's renderRoot, which made lv-prompt-dialog invisible
   * by construction — showPrompt appends that singleton to document.body, so
   * it is app-shell's SIBLING. Escape then closed the diff behind an open
   * prompt as soon as focus left its autofocused input (the keyboard service's
   * composedPath bail only covers the input itself). Starting at the document
   * subsumes app-shell, the sidebar, the toolbar and anything body-level, so
   * the root is no longer a choice that can be wrong.
   */
  private hasModalDialogOpen(): boolean {
    return AppShell.containsOpenModal(document.body, new Set<ShadowRoot>());
  }

  /**
   * True when a dialog owned by the LEFT PANEL is open. Hiding the panel with
   * one of those up makes it invisible without closing it — the overlay is
   * inside the `display: none` subtree — while it still owns Escape, so the
   * key goes dead app-wide with no visible cause.
   */
  private hasSidebarDialogOpen(): boolean {
    const panel = this.renderRoot.querySelector('lv-left-panel');
    return panel?.shadowRoot
      ? AppShell.containsOpenModal(panel.shadowRoot, new Set<ShadowRoot>())
      : false;
  }

  /**
   * Hiding the left panel is refused while it hosts an open dialog — see
   * hasSidebarDialogOpen. Revealing it is always allowed.
   */
  toggleLeftPanel(): void {
    if (this.leftPanelVisible && this.hasSidebarDialogOpen()) {
      showToast('Close the open dialog before hiding the sidebar', 'info');
      return;
    }
    uiStore.getState().togglePanel('left');
  }

  /**
   * Closing this dialog DESTROYS it (its whole block is behind a conditional),
   * so a dismissal mid-gc leaves `git gc --aggressive` running with no surface
   * and lets a reopened, freshly-constructed dialog start a second one. Refuse
   * while an action is in flight and re-assert the modal, mirroring the
   * in-flight guards on the clean and reflog dialogs.
   */
  private handleRepositoryHealthClose = (): void => {
    if (this.repositoryHealthDialog?.isRunning) {
      const modal = this.renderRoot.querySelector('lv-modal[modalTitle="Repository Health"]');
      if (modal) (modal as HTMLElement & { open: boolean }).open = true;
      return;
    }
    dialogs.close('repositoryHealth');
  };

  private handleCloseOverlay(): void {
    // Close any open overlay in priority order
    if (this.hasModalDialogOpen()) {
      // A modal owns this Escape and dismisses itself, through lv-modal's
      // handler or its own — each now gated on being the TOPMOST overlay.
      //
      // This arm is FIRST. The shortcuts and command-palette arms used
      // to precede it and closed unconditionally, without consulting the
      // stack: opening the undo-history dialog over the shortcuts dialog and
      // pressing Escape once closed BOTH. Both dialogs clear their own flag
      // through their `close` event, so letting the topmost one dismiss itself
      // is all that is needed.
      // Stop here so one keypress cannot also close the diff behind it, and
      // so a dialog that deliberately blocks dismissal mid-operation does not
      // leak the key either.
      //
      // This subsumes the old reflog arm, which assumed reflog was always
      // topmost: a dialog opened over it (via the palette) made Escape discard
      // the reflog session underneath. The dialog's own handler applies the
      // isResetting guard and its `close` event closes the reflog dialog.
      return;
    } else if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    } else if (this.refContextMenu.visible) {
      this.refContextMenu = { ...this.refContextMenu, visible: false };
    } else if (dialogs.isOpen('diff')) {
      this.handleCloseDiff();
    } else if (dialogs.isOpen('blame')) {
      this.handleCloseBlame();
    } else if (dialogs.isOpen('fileHistory')) {
      this.handleCloseFileHistory();
    }
  }

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
    if (this.refContextMenu.visible) {
      this.refContextMenu = { ...this.refContextMenu, visible: false };
    }
  };

  private handleCommitContextMenu(e: CustomEvent): void {
    const { commit, position } = e.detail as {
      commit: Commit;
      refs: RefInfo[];
      position: { x: number; y: number };
    };

    this.contextMenu = {
      visible: true,
      x: position.x,
      y: position.y,
      commit,
    };
  }

  private handleRefContextMenu(e: CustomEvent): void {
    const { refName, fullName, refType, isHead, position } = e.detail as {
      refName: string;
      fullName: string;
      refType: 'localBranch' | 'remoteBranch' | 'tag';
      isHead?: boolean;
      position: { x: number; y: number };
    };

    this.refContextMenu = {
      visible: true,
      x: position.x,
      y: position.y,
      refName,
      fullName,
      refType,
      isHead: isHead ?? false,
    };
  }

  private async handleRefCheckout(): Promise<void> {
    if (!this.activeRepository) return;
    // Checking out the branch you are already on is a no-op that nonetheless
    // parks the entire working tree in a stash and re-applies it. The sidebar
    // and the direct graph-label click both refuse it; this menu item and the
    // palette's "Switch to <branch>" were never folded into that guard.
    if (this.refContextMenu.refType === 'localBranch' && this.refContextMenu.isHead) {
      showToast('Already on this branch', 'info');
      this.refContextMenu = { ...this.refContextMenu, visible: false };
      return;
    }
    // Checkout mutates the same working tree merge/rebase/delete do, and was
    // left out when this flag was extended to them — so it stayed clickable
    // during an in-flight merge and ran concurrently against it. There is no
    // per-repo lock in the backend. The sidebar has always guarded its own
    // checkout with the flag it shares with merge/rebase/rename.
    const refName = this.refContextMenu.refName;
    const checkoutRef =
      this.refContextMenu.refType === 'tag'
        ? this.refContextMenu.fullName || `refs/tags/${refName}`
        : refName;
    const repoPath = this.activeRepository.repository.path;
    if (!this.claimRefOperation(repoPath)) return;
    const refType = this.refContextMenu.refType;
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    // Checking out a tag detaches HEAD. The Tags sidebar warns about that; this
    // handler was written for branches and later reused for the tag menu entry,
    // so the graph route silently detached and a commit made afterwards was
    // reachable from no ref.
    if (refType === 'tag') {
      const confirmed = await showConfirm(
        'Checkout Tag',
        `Checking out tag "${refName}" will put you in 'detached HEAD' state. Any new commits won't belong to any branch. Continue?`,
        'warning',
      );
      if (!confirmed) {
        this.releaseRefOperation(repoPath);
        return;
      }
    }

    try {
      const result = await gitService.checkoutWithAutoStash(repoPath, checkoutRef);

      if (result.success && result.data?.success) {
        this.handleAutoStashToast(result.data, refName, repoPath);
        // Pinned refresh, matching the sibling command-palette checkout: the
        // checkout ran on repoPath, which may be backgrounded by completion.
        this.refreshConflictDialogRepo(repoPath);
      } else {
        log.error('Checkout failed:', result.data?.message || result.error);
        showErrorWithSuggestion(
          result.data?.message || result.error?.message || '',
          'Checkout failed',
        );
      }
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  private handleAutoStashToast(
    data: gitService.CheckoutWithStashResult,
    refName: string,
    repoPath: string,
  ): void {
    if (data.stashed && data.stashConflict) {
      showToast(`Switched to ${refName} — stash conflicts need resolution`, 'warning');
      // Open the conflict dialog so the user can resolve the failed stash pop.
      // Auto-stash is pop semantics: the entry must be dropped once its changes
      // are applied and resolved. Identified by oid rather than assumed to sit
      // at index 0 — checkout_with_autostash no longer trusts that position
      // either, because another surface or a terminal can push a stash in
      // between and renumber the list.
      this.conflictOperationType = 'stash';
      this.resetConflictDetailState();
      this.conflictStashOid = data.stashOid ?? null;
      this.conflictDropStashOnComplete = true;
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
    } else if (data.stashed && data.stashApplied) {
      showToast(data.message, data.message.includes('staged status was not preserved') ? 'warning' : 'info');
    } else if (data.stashed && !data.stashApplied) {
      showToast(data.message, 'warning');
    }
  }

  private async handleRefMerge(): Promise<void> {
    if (!this.activeRepository) return;

    const refName = this.refContextMenu.refName;
    // The user can switch repo tabs while the operation runs — the dialog
    // must pin to the repo the operation ran ON, not the one active later.
    const repoPath = this.activeRepository.repository.path;
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    // Same confirm the sidebar and drag-drop paths show for the same
    // operation. The sibling delete handlers below already carry a comment
    // saying the graph ref menu must not be the one unguarded path; merge and
    // rebase were missed by that pass.
    // Claimed BEFORE the confirm, like the delete siblings below: showConfirm
    // is an IPC round trip, so a claim taken after it does not serialize two
    // dispatches that both got past the check.
    if (!this.claimRefOperation(repoPath)) return;
    // Predicted before the confirm and inside the claim — see the sidebar's
    // handleMergeBranch. Falls back to an unpredicted confirm when the preview
    // cannot be computed; it must never be the reason a merge is unavailable.
    const prediction = await mergePreviewSummary(repoPath, refName);
    if (!await showConfirm(
      'Merge Branch',
      `Merge "${refName}" into the current branch?${prediction}`,
      'info',
    )) {
      this.releaseRefOperation(repoPath);
      return;
    }

    try {
    const result = await gitService.merge({
      path: repoPath,
      sourceRef: refName,
    });

    if (result.success) {
      this.refreshConflictDialogRepo(repoPath);
      showToast(`Merged ${refName}`, 'success');
    } else if (result.error?.code === 'MERGE_CONFLICT') {
      this.conflictOperationType = 'merge';
      this.resetConflictDetailState();
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
      notifyWarning(
        'Merge Conflict',
        `Conflicts detected while merging ${refName}. Please resolve conflicts to continue.`,
        !settingsStore.getState().showNativeNotifications
      );
    } else {
      log.error('Merge failed:', result.error);
      showErrorWithSuggestion(result.error?.message || '', 'Merge failed');
    }
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  private async handleRefRebase(): Promise<void> {
    if (!this.activeRepository) return;

    const refName = this.refContextMenu.refName;
    const repoPath = this.activeRepository.repository.path;
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    // Claimed BEFORE the confirm — see handleRefMerge.
    if (!this.claimRefOperation(repoPath)) return;
    if (!await showConfirm(
      'Rebase Branch',
      `Rebase current branch onto "${refName}"?\n\nThis will rewrite commit history.`,
      'warning',
    )) {
      this.releaseRefOperation(repoPath);
      return;
    }

    try {
    const result = await gitService.rebase({
      path: repoPath,
      onto: refName,
    });

    if (result.success) {
      this.refreshConflictDialogRepo(repoPath);
      showToast(rebasedOntoMessage(refName, result.data), 'success');
    } else if (result.error?.code === 'REBASE_CONFLICT') {
      this.conflictOperationType = 'rebase';
      this.resetConflictDetailState();
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
      notifyWarning(
        'Rebase Conflict',
        `Conflicts detected while rebasing onto ${refName}. Please resolve conflicts to continue.`,
        !settingsStore.getState().showNativeNotifications
      );
    } else {
      log.error('Rebase failed:', result.error);
      showErrorWithSuggestion(result.error?.message || '', 'Rebase failed');
    }
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  private async handleRefDeleteBranch(): Promise<void> {
    if (!this.activeRepository) return;
    // Serialized with Merge and Rebase from this same menu. The lock was
    // introduced to stop those two racing each other, and these three were
    // never folded in — so a delete or a tag push could run concurrently with a
    // still-running merge or rebase against the same working tree. There is no
    // per-repo lock in the backend (every command opens its own git2 handle),
    // so this flag is the only thing serializing them. The sidebar gets it
    // right: its delete shares operationInProgress with merge/rebase/rename.
    const branchName = this.refContextMenu.refName;
    // Captured before the delete await: the delete and its refresh must target
    // the repo it was invoked on, even if the user switches tabs mid-operation.
    const repoPath = this.activeRepository.repository.path;
    if (!this.claimRefOperation(repoPath)) return;
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    // Deleting from the graph's ref menu destroys the same branch as the
    // sidebar's delete, so it must be gated the same way (lv-branch-list.ts
    // handleDeleteBranch). Without this, one click on a graph label is enough.
    const confirmed = await showConfirm(
      'Delete Branch',
      // Same stakes, same words as the sidebar's delete. Two surfaces for
      // one irreversible operation must not state them differently — and
      // the graph route is the faster gesture.
      `Are you sure you want to delete the branch "${branchName}"?\n\n` +
        `This action cannot be undone.`,
      'warning'
    );

    if (!confirmed) {
      this.releaseRefOperation(repoPath);
      return;
    }

    try {
      const result = await gitService.deleteBranch(repoPath, branchName, false);

      if (result.success) {
        this.refreshConflictDialogRepo(repoPath);
        showToast(`Deleted branch ${branchName}`, 'success');
      } else {
        log.error('Delete branch failed:', result.error);
        showErrorWithSuggestion(result.error?.message || '', 'Delete branch failed', {
          branchName,
          repoPath,
        });
      }
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  private async handleRefDeleteTag(): Promise<void> {
    if (!this.activeRepository) return;
    // Serialized with the rest of this menu — see handleRefDeleteBranch.
    const tagName = this.refContextMenu.refName;
    // Captured before the delete await: the delete and its refresh must target
    // the repo it was invoked on, even if the user switches tabs mid-operation.
    const repoPath = this.activeRepository.repository.path;
    if (!this.claimRefOperation(repoPath)) return;
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    // Gated to match the sidebar's tag delete (lv-tag-list.ts) — the graph ref
    // menu deletes the same tag and must not be the one unguarded path. Shared
    // wording so the two surfaces cannot drift.
    const confirmed = await confirmDeleteTag(tagName);

    if (!confirmed) {
      this.releaseRefOperation(repoPath);
      return;
    }

    try {
      const result = await gitService.deleteTag({ path: repoPath, name: tagName });

      if (result.success) {
        this.refreshConflictDialogRepo(repoPath);
        showToast(`Deleted tag ${tagName}`, 'success');
        // The local ref is gone; the remote copy is not, and the tag fetch
        // refspec would restore it. Asked here, inside the claim, so the
        // follow-up push is serialized with the rest of this repo's ref ops.
        await offerRemoteTagDelete(repoPath, tagName);
      } else {
        log.error('Delete tag failed:', result.error);
        showToast(result.error?.message || 'Delete tag failed', 'error');
      }
    } finally {
      this.releaseRefOperation(repoPath);
    }
  }

  private async handleRefPushTag(): Promise<void> {
    if (!this.activeRepository) return;
    // Serialized with the rest of this menu — see handleRefDeleteBranch.
    const tagName = this.refContextMenu.refName;
    // Captured before the (slow, network) push await: the push and its refresh
    // must target the repo it was invoked on, even if the user switches tabs.
    const repoPath = this.activeRepository.repository.path;
    if (!this.claimRefOperation(repoPath)) return;
    // Also the shared tag-push key, so this cannot race a Force Push Tag
    // sitting on its confirm — that one holds no working-tree claim.
    const tagKey = pushTagKey(repoPath, tagName);
    if (!tryAcquirePush(tagKey)) {
      this.releaseRefOperation(repoPath);
      this.warnRepositoryBusy();
      return;
    }
    this.refContextMenu = { ...this.refContextMenu, visible: false };

    try {
      const remoteResult = await gitService.getPushRemote(repoPath);
      if (!remoteResult.success || !remoteResult.data) {
        // A repo with no remote cannot push a tag anywhere. The resolver falls
        // back to the literal `origin`, so its answer — "Remote not found:
        // origin" — names a remote the user never configured, which reads as a
        // bug rather than as missing setup. Translated exactly as the tag list
        // translates it, so both tag-push surfaces say the same thing.
        const remotes = await gitService.getRemotes(repoPath);
        showToast(
          remotes.success && (remotes.data?.length ?? 0) === 0
            ? 'No remotes configured. Add a remote before pushing tags.'
            : `Could not determine the tag destination: ${remoteResult.error?.message ?? 'Unknown error'}`,
          'error',
        );
        return;
      }
      const remote = remoteResult.data;
      const result = await gitService.pushTag({ path: repoPath, name: tagName, remote });

      if (result.success) {
        this.refreshConflictDialogRepo(repoPath);
        showToast(`Pushed tag ${tagName} to ${remote}`, 'success');
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        log.error('Push tag failed:', result.error);
        showErrorWithSuggestion(result.error?.message || '', 'Push tag failed', {
          operation: 'push-tag',
          // Carries the tag through to the Force Push Tag suggestion action.
          branchName: tagName,
          repoPath,
          remote,
        });
      }
    } finally {
      releasePush(tagKey);
      this.releaseRefOperation(repoPath);
    }
  }

  private handleCherryPick(): void {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Open the cherry-pick dialog
    this.cherryPickDialog?.open(commit);
  }

  /**
   * The batch actions the commit context menu grows when the right-clicked
   * commit is part of a multi-selection.
   *
   * They sit ABOVE the single-commit items and are separated from them by a
   * divider and a "Just <oid>" label, so it is never ambiguous which of the
   * two scopes an entry acts on. Nothing renders for a one-commit selection,
   * which is why the label below it only appears alongside these.
   */
  private renderMultiCommitActions() {
    const commits = this.menuSelection;
    if (commits.length < 2) return '';
    const count = commits.length;
    const subject = this.contextMenu.commit;
    const subjectShort = subject ? subject.shortId || subject.oid.substring(0, 7) : '';
    return html`
      <div class="context-menu-submenu" data-testid="multi-commit-actions">
        <span class="context-menu-label" data-testid="multi-commit-count"
          >${count} commits selected</span
        >
        <button
          class="context-menu-item"
          data-testid="multi-cherry-pick"
          ?disabled=${this.isRefOperationInFlight()}
          @click=${this.handleCherryPickSelection}
          title="Apply all ${count} selected commits to the current branch, oldest first"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" />
            <path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" fill="none" />
          </svg>
          Cherry-pick ${count} commits
        </button>
        <button
          class="context-menu-item"
          data-testid="multi-create-patch"
          @click=${this.handleCreatePatchFromSelection}
          title="Write one .patch file per selected commit, numbered oldest first"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
          </svg>
          Create patch from ${count} commits
        </button>
        ${count === 2
          ? html`
              <button
                class="context-menu-item"
                data-testid="multi-compare"
                @click=${this.handleCompareSelection}
                title="Compare the two selected commits"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="17 1 21 5 17 9"></polyline>
                  <path d="M3 11V9a4 4 0 014-4h14"></path>
                  <polyline points="7 23 3 19 7 15"></polyline>
                  <path d="M21 13v2a4 4 0 01-4 4H3"></path>
                </svg>
                Compare these commits
              </button>
            `
          : ''}
      </div>
      <div class="context-menu-divider"></div>
      <span class="context-menu-label" data-testid="single-commit-scope"
        >Just ${subjectShort}</span
      >
    `;
  }

  /**
   * Cherry-pick the whole graph multi-selection, oldest first.
   *
   * The order is the graph's, never the click order: `git cherry-pick a b c`
   * replays in the order it is given, and a descendant applied before its
   * ancestor either conflicts or produces a different tree. The picks run one
   * at a time through the SAME single-commit command the cherry-pick dialog
   * uses, so a conflict lands in the existing conflict-resolution dialog
   * rather than a second mechanism — and stopping there is deliberate: the
   * commits after it are reported, not silently dropped or force-applied over
   * a conflicted index.
   */
  private handleCherryPickSelection(): Promise<void> {
    const commits = this.menuSelection;
    const repoPath = this.activeRepository?.repository.path;
    if (commits.length < 2 || !repoPath) return Promise.resolve();

    this.contextMenu = { ...this.contextMenu, visible: false };
    return this.runRefExclusive(repoPath, () => this.cherryPickCommits(repoPath, commits));
  }

  private async cherryPickCommits(repoPath: string, commits: Commit[]): Promise<void> {
    const branch = this.activeRepository?.currentBranch?.shorthand ?? 'HEAD';

    // A merge commit needs an explicit mainline parent (`git cherry-pick -m`),
    // which only the single-commit dialog can ask for. Refuse the whole batch
    // BEFORE anything is applied rather than dying partway through it.
    const merge = commits.find((c) => c.parentIds.length > 1);
    if (merge) {
      showToast(
        `${merge.shortId || merge.oid.substring(0, 7)} is a merge commit — cherry-pick it on ` +
          'its own to choose which parent to keep, then run the rest as a batch',
        'warning',
        8000,
      );
      return;
    }

    const confirmed = await showConfirm(
      `Cherry-pick ${commits.length} commits`,
      cherryPickConfirmMessage(commits, branch),
      'warning',
    );
    if (!confirmed) return;

    const applied: Commit[] = [];
    for (const [index, commit] of commits.entries()) {
      const result = await gitService.cherryPick({ path: repoPath, commitOid: commit.oid });
      if (result.success) {
        applied.push(commit);
        continue;
      }

      const message = result.error?.message ?? '';
      const isConflict =
        result.error?.code === 'CHERRY_PICK_CONFLICT' || message.toLowerCase().includes('conflict');
      showToast(
        cherryPickFailureMessage(
          applied,
          commits.slice(index),
          commits.length,
          message || (isConflict ? 'it conflicts' : 'the cherry-pick failed'),
        ),
        'error',
        12000,
      );
      if (isConflict) {
        this.showCherryPickConflict(repoPath);
      } else {
        this.refreshConflictDialogRepo(repoPath);
      }
      return;
    }

    showToast(`Cherry-picked ${applied.length} commits onto ${branch}`, 'success');
    this.refreshConflictDialogRepo(repoPath);
  }

  /**
   * Write patch files for the whole multi-selection (the export dialog's Patch
   * tab, with every selected commit pre-ticked). Writes no git state, so it is
   * not gated on the ref lock — same as the single-commit entry beside it.
   */
  private handleCreatePatchFromSelection(): void {
    const commits = this.menuSelection;
    if (commits.length < 2) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.exportImportDialog?.open({
      tab: 'patch',
      patchMode: 'create',
      commitOids: commits.map((c) => c.oid),
    });
  }

  /** Compare exactly two selected commits, the ancestor as the base. */
  private handleCompareSelection(): void {
    const commits = this.menuSelection;
    if (commits.length !== 2) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    const [base, compare] = commits;
    this.compareBranchesDialog?.open({
      baseRef: base.oid,
      compareRef: compare.oid,
      extraRefs: [
        { ref: base.oid, label: shortCommitLabel(base) },
        { ref: compare.oid, label: shortCommitLabel(compare) },
      ],
    });
  }

  private handleCherryPickComplete(e: CustomEvent): void {
    const { sourceCommit, noCommit, repositoryPath } = e.detail;
    if (noCommit) {
      showToast(`Staged changes from ${sourceCommit.oid.substring(0, 7)}`, 'success');
    } else {
      showToast(`Cherry-picked ${sourceCommit.oid.substring(0, 7)}`, 'success');
    }
    // Pinned refresh: after a mid-operation tab switch the cherry-pick
    // completed on the ORIGINATING repo — refreshing the active tab would
    // leave that repo's graph and state stale until the file watcher fires.
    this.refreshConflictDialogRepo(repositoryPath ?? null);
  }

  // Arrow + host-level listener (not an inline binding on one dialog):
  // interactive rebase is dispatched by BOTH the app-shell dialog and the
  // branch-list's own embedded dialog, and a bubbling host listener catches
  // either. The pinned refresh targets the repo the rebase ran on, which
  // may no longer be the active tab.
  private handleRebaseComplete = (e: Event): void => {
    const detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    this.refreshConflictDialogRepo(detail?.repositoryPath ?? null);
  };

  private handleCherryPickConflict(e: Event): void {
    const detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    this.showCherryPickConflict(detail?.repositoryPath);
  }

  /**
   * The one "a cherry-pick stopped on conflicts" surface, shared by the
   * cherry-pick dialog's event and the graph's batch pick. Both leave the
   * repository in the same state, so both must reach the same dialog — a
   * second mechanism for the batch case would have to re-implement continue,
   * skip and abort.
   */
  private showCherryPickConflict(repositoryPath?: string): void {
    // Show conflict resolution dialog
    this.conflictOperationType = 'cherry-pick';
    this.resetConflictDetailState();
    this.openConflictDialogPinned(repositoryPath);
    notifyWarning(
      'Cherry-pick Conflict',
      'Conflicts detected during cherry-pick. Please resolve conflicts to continue.',
      !settingsStore.getState().showNativeNotifications
    );
    this.refreshConflictDialogRepo(repositoryPath ?? null);
  }

  private canResolveConflicts(state: string): boolean {
    // These operations can have conflicts that need resolution
    return ['cherrypick', 'merge', 'rebase', 'rebase-interactive', 'rebase-merge', 'revert'].includes(state);
  }

  /** True when the working tree has unmerged (conflicted) files. */
  private get hasConflictedFiles(): boolean {
    return (this.activeRepository?.status ?? []).some((f) => f.isConflicted);
  }

  /**
   * Derive which operation the current index conflicts belong to from the
   * repository state. A CLEAN state with conflicted files means a stash
   * apply conflicted — the only conflict source that leaves no in-progress
   * state. Returns null for states this dialog cannot drive (an external
   * `git am` / `git bisect`): its Complete does not run their --continue
   * and its stash-flavored Abort would discard the conflicted files while
   * leaving the operation wedged mid-flight.
   */
  private deriveConflictOperationType():
    | 'merge'
    | 'rebase'
    | 'cherry-pick'
    | 'revert'
    | 'stash'
    | null {
    const state = this.activeRepository?.repository.state ?? 'clean';
    if (state === 'cherrypick') return 'cherry-pick';
    if (state === 'rebase' || state === 'rebase-interactive' || state === 'rebase-merge') return 'rebase';
    if (state === 'revert') return 'revert';
    if (state === 'merge') return 'merge';
    if (state === 'clean') return 'stash';
    return null;
  }

  /**
   * Open the conflict dialog with the operation derived from repository state.
   * Used when the trigger carries no operation context (banner button, diff
   * view redirect, conflicted-file click).
   */
  private openConflictDialogFromState(initialFilePath?: string): void {
    if (!this.activeRepository) return;

    const operationType = this.deriveConflictOperationType();
    if (operationType === null) {
      showToast(
        `Conflicts from an external ${this.activeRepository.repository.state} operation — resolve them with git in a terminal`,
        'warning',
      );
      return;
    }
    this.conflictOperationType = operationType;
    this.resetConflictDetailState();
    // A state-derived stash conflict has unknown pop semantics — never drop a
    // stash entry we can't identify (completing keeps the stash), and the
    // source is only inferred (checkout -m / apply -3 look identical), so the
    // dialog must not promise the changes are safe in a stash.
    if (this.conflictOperationType === 'stash') {
      this.conflictDropStashOnComplete = false;
      this.conflictStashSourceCertain = false;
    }
    this.conflictInitialFilePath = initialFilePath ?? null;
    this.openConflictDialogPinned();
  }

  private handleOpenConflictDialog(): void {
    this.openConflictDialogFromState();
  }

  private handleRevertCommit(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    return this.runRefExclusive(repoPath, () => this.revertCommit());
  }

  private async revertCommit(): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: the revert commit must be created in
    // the repo it was invoked on, even if the user switches tabs (rebinding
    // activeRepository) while the confirm is up.
    const repoPath = this.activeRepository.repository.path;

    // A merge commit has no single "the change" to undo; git requires an
    // explicit mainline parent (`git revert -m`). Default to the first parent
    // (the branch the merge landed on), which is what reverting a merge almost
    // always means, and tell the user so.
    const isMergeCommit = commit.parentIds.length > 1;
    const confirmed = await showConfirm(
      'Revert Commit',
      isMergeCommit
        ? `Commit ${commit.oid.substring(0, 7)} is a merge commit. Reverting it will create a new commit that undoes the merge relative to its first parent (mainline). Continue?`
        : `Are you sure you want to revert commit ${commit.oid.substring(0, 7)}? This will create a new commit that undoes the changes.`,
      'warning'
    );
    if (!confirmed) return;

    const result = await import('./services/git.service.ts').then((m) =>
      m.revert({
        path: repoPath,
        commitOid: commit.oid,
        mainline: isMergeCommit ? 1 : undefined,
      })
    );

    if (result.success) {
      this.refreshConflictDialogRepo(repoPath);
      showToast(`Reverted ${commit.oid.substring(0, 7)}`, 'success');
    } else if (result.error?.code === 'REVERT_CONFLICT') {
      // Show conflict resolution dialog
      this.conflictOperationType = 'revert';
      this.resetConflictDetailState();
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
      notifyWarning(
        'Revert Conflict',
        `Conflicts detected while reverting ${commit.oid.substring(0, 7)}. Please resolve conflicts to continue.`,
        !settingsStore.getState().showNativeNotifications
      );
    } else {
      log.error('Revert failed:', result.error);
      showErrorWithSuggestion(result.error?.message || '', 'Revert failed');
    }
  }

  /** `pinnedRepoPath` is optional, so this must NEVER be bound directly as an
   * event handler — a MouseEvent would arrive in that slot and the lookup below
   * would silently find no repo, making Abort do nothing. Bind it as
   * `() => this.handleAbortOperation()`. */
  private async handleAbortOperation(pinnedRepoPath?: string): Promise<void> {
    if (this.abortInProgress) return;

    // An abort discards the in-progress operation AND any conflict resolution,
    // so a toast action must target the repo that failed, not the active tab.
    const repo = pinnedRepoPath
      ? repositoryStore
          .getState()
          .openRepositories.find((r) => r.repository.path === pinnedRepoPath)
      : this.activeRepository;
    if (!repo) return;

    const state = repo.repository.state;
    const path = repo.repository.path;
    let result;

    // Reject an unabortable state BEFORE prompting — otherwise the user
    // confirms a destructive action that was never going to run.
    if (!ABORTABLE_STATES.includes(state)) {
      showToast(`Cannot abort operation: ${state}`, 'error');
      return;
    }

    // Aborting throws away every conflict resolution made so far and restores
    // the pre-operation working tree. The conflict dialog's own Abort button
    // gates this behind an explicit confirmation panel; the banner button
    // reaches the same command, so it needs the same gate rather than being a
    // one-click path to the identical loss.
    // Claimed BEFORE the confirm, not after. There is an IPC round trip between
    // the click and the native dialog actually opening and taking focus, so a
    // double-click landed a second call while the flag was still false and
    // raised two abort prompts — the second then ran against an
    // already-restored tree with a stale `state` and reported a failure for an
    // operation that had in fact succeeded. Same reasoning as
    // lv-gitflow-panel's handleFinishFeature.
    //
    // The claim is on the SHARED working-tree lock, not just this banner's own
    // flag. An abort is a full working-tree restore, and this is the only
    // always-visible non-modal destructive control — so a hard reset from the
    // graph could run beside it in one direction, and a sidebar discard could
    // start during this confirm's IPC round trip in the other.
    if (!this.claimRefOperation(path)) {
      this.warnRepositoryBusy();
      return;
    }
    this.abortInProgress = true;

    const confirmed = await showConfirm(
      `Abort ${operationLabel(state)}?`,
      `This discards all conflict resolutions and restores the working tree to ` +
        `its state before the ${operationLabel(state)} began. This cannot be undone.`,
      'warning'
    );

    if (!confirmed) {
      this.abortInProgress = false;
      this.releaseRefOperation(path);
      return;
    }

    try {
      switch (state) {
        case 'cherrypick':
          result = await gitService.abortCherryPick({ path });
          break;
        case 'merge':
          result = await gitService.abortMerge({ path });
          break;
        case 'rebase':
        case 'rebase-interactive':
        case 'rebase-merge':
          result = await gitService.abortRebase({ path });
          break;
        case 'revert':
          result = await gitService.abortRevert({ path });
          break;
        default:
          // Unreachable while ABORTABLE_STATES gates entry above. Kept explicit
          // so that adding a state to that list without adding a case here
          // fails loudly instead of silently running an unrelated abort.
          showToast(`Cannot abort operation: ${state}`, 'error');
          return;
      }

      if (result.success) {
        showToast(`Aborted ${operationLabel(state)}`, 'success');
        // `path` was captured before the abort await — pin the refresh to it so
        // a mid-abort tab switch doesn't refresh the wrong repo.
        this.refreshConflictDialogRepo(path);
      } else {
        log.error('Abort failed:', result.error);
        showToast(result.error?.message || 'Abort failed', 'error');
      }
    } finally {
      this.abortInProgress = false;
      this.releaseRefOperation(path);
    }
  }

  /** `pinnedRepoPath` is optional, so this must NEVER be bound directly as an
   * event handler — see handleAbortOperation. Bind it as
   * `() => this.handleSkipOperation()`. */
  private async handleSkipOperation(pinnedRepoPath?: string): Promise<void> {
    if (this.skipInProgress) return;

    const repo = pinnedRepoPath
      ? repositoryStore
          .getState()
          .openRepositories.find((r) => r.repository.path === pinnedRepoPath)
      : this.activeRepository;
    if (!repo) return;

    const state = repo.repository.state;
    const path = repo.repository.path;
    let result;

    // Reject an unskippable state BEFORE doing anything, so the handler can
    // never run a skip the banner was not offering.
    if (!SKIPPABLE_STATES.includes(state)) {
      showToast(`Cannot skip operation: ${state}`, 'error');
      return;
    }

    // Same shared working-tree lock the banner's Abort claims, and for the same
    // reason: a skip restores the working tree, so a graph reset or a sidebar
    // discard must not run beside it.
    if (!this.claimRefOperation(path)) {
      this.warnRepositoryBusy();
      return;
    }
    this.skipInProgress = true;

    try {
      // Skip only discards the CURRENT pick — commits already applied stay. When
      // there are conflicted files there IS resolution work to lose, so gate it
      // like Abort; on an empty stop there is nothing to lose and a scary
      // confirm would be pure friction.
      // Gated on the TARGETED repo's status, not `hasConflictedFiles` — that
      // getter reads the ACTIVE tab, which is a different repository whenever
      // this runs with a pinned path.
      if ((repo.status ?? []).some((f) => f.isConflicted)) {
        const confirmed = await showConfirm(
          `Skip ${operationLabel(state)}?`,
          `This commit will not be applied and the conflict resolutions for it are ` +
            `discarded. Commits already applied stay, and the rest of the range continues.`,
          'warning'
        );
        if (!confirmed) return;
      }

      switch (state) {
        case 'cherrypick':
          result = await gitService.skipCherryPick({ path });
          break;
        case 'revert':
          result = await gitService.skipRevert({ path });
          break;
        default:
          // Unreachable while SKIPPABLE_STATES gates entry above. Kept explicit
          // so that adding a state to that list without adding a case here
          // fails loudly instead of silently running an unrelated skip.
          showToast(`Cannot skip operation: ${state}`, 'error');
          return;
      }

      if (result.success) {
        showToast(`Skipped ${operationLabel(state)}`, 'success');
        // `path` was captured before the skip await — pin the refresh to it so
        // a mid-skip tab switch doesn't refresh the wrong repo.
        this.refreshConflictDialogRepo(path);
      } else {
        log.error('Skip failed:', result.error);
        showToast(result.error?.message || 'Skip failed', 'error');
      }
    } finally {
      this.skipInProgress = false;
      this.releaseRefOperation(path);
    }
  }

  // Error suggestion action handlers
  /**
   * A suggestion toast lives 8 seconds and nothing clears toasts on a repo
   * switch, so an action clicked from one must run against the repo that
   * FAILED — not whichever tab happens to be active by then. Same reasoning as
   * handleForceDeleteBranch; these two were left resolving `activeRepository`.
   */
  private resolvePinnedRepo(repoPath?: string): string | null {
    if (!repoPath) return this.activeRepository?.repository.path ?? null;
    const open = repositoryStore
      .getState()
      .openRepositories.some((r) => r.repository.path === repoPath);
    if (!open) {
      showToast('That repository is no longer open', 'warning');
      return null;
    }
    return repoPath;
  }

  private handleTriggerPull = (e: Event): void => {
    const repoPath = this.resolvePinnedRepo(
      (e as CustomEvent<{ repoPath?: string }>).detail?.repoPath,
    );
    if (!repoPath) return;
    void this.handlePull(repoPath);
  };

  private handleForceDeleteBranch = (
    e: CustomEvent<{ branchName?: string; repoPath?: string }>
  ): void => {
    const branchName = e.detail?.branchName;
    const repoPath = e.detail?.repoPath;
    if (branchName && repoPath) {
      // The SHARED working-tree lock, not a private key. Its sibling
      // handleRefDeleteBranch says why: a delete can run concurrently with a
      // still-running merge or rebase, and this flag is the only thing
      // serializing them. Keying it privately left the toast button live while
      // every menu was greyed out.
      //
      // runRefExclusive reports the refusal itself, which matters here: a toast
      // action button carries no ?disabled binding, and clicking it destroys
      // the toast — so a silent refusal takes the affordance away with it.
      void this.runRefExclusive(repoPath, () =>
        this.forceDeleteBranch(branchName, repoPath),
      );
    }
  };

  private async forceDeleteBranch(branchName: string, repoPath: string): Promise<void> {
    // The repo comes from the event, NOT from activeRepository. This runs from
    // an 8-second error toast, and nothing clears toasts on a repository
    // switch — so resolving the repo at click time force-deleted from whichever
    // tab was active by then. With two repos both holding a branch of the same
    // name, that discarded unmerged commits in the repo the user never aimed at,
    // under a confirm quoting facts measured in the other one.
    const repo = repositoryStore
      .getState()
      .openRepositories.find((r) => r.repository.path === repoPath);
    if (!repo) {
      showToast(
        `Cannot force delete ${branchName}: its repository is no longer open`,
        'warning'
      );
      return;
    }

    // This fires from the "Force Delete" action on an error-suggestion toast,
    // i.e. one click away from an ordinary delete that just failed as unmerged.
    // Force-deleting discards commits that exist on no other ref, so it needs
    // its own gate — the sidebar escalation (lv-branch-list.ts) re-confirms
    // here too, and the toast button must not be the cheaper route to the same
    // irreversible outcome.
    const confirmed = await showConfirm(
      'Force Delete Branch',
      `"${branchName}" in ${repo.repository.name} has commits that are not ` +
        `merged anywhere else. Force deleting it discards those commits ` +
        `permanently — they will be recoverable only through the reflog. ` +
        `Continue?`,
      'warning'
    );

    if (!confirmed) return;

    try {
      const result = await gitService.deleteBranch(repoPath, branchName, true);
      if (result.success) {
        this.refreshConflictDialogRepo(repoPath);
        showToast(`Force deleted branch ${branchName}`, 'success');
      } else {
        showToast(result.error?.message || 'Force delete failed', 'error');
      }
    } catch (err) {
      showToast(
        `Force delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error'
      );
    }
  };

  private handleOpenSettings = (): void => {
    dialogs.open('settings');
  };

  /** Unlisten for the webview's OS drag/drop events. */
  private dropUnlisten?: UnlistenFn;

  /** Open the scan dialog on a folder the user picked (welcome screen). */
  private handleOpenRepositoryScan = (e: Event): void => {
    const detail = (e as CustomEvent<{ path?: string; mode?: 'scan' | 'offer' }>).detail;
    if (!detail?.path) return;
    this.repositoryScanPath = detail.path;
    this.repositoryScanMode = detail.mode ?? 'scan';
    dialogs.open('repositoryScan');
  };

  /**
   * A folder dropped on the window is not a repository: offer to scan it or to
   * initialize one there. Fired on `window` by the drop service, which has no
   * component of its own.
   */
  private handleRepositoryScanOffer = (e: Event): void => {
    const detail = (e as CustomEvent<{ path?: string }>).detail;
    if (!detail?.path) return;
    this.repositoryScanPath = detail.path;
    this.repositoryScanMode = 'offer';
    dialogs.open('repositoryScan');
  };

  /**
   * Hand a folder to the init dialog. Only one init dialog is mounted at a
   * time: the welcome screen owns it while no repository is open, the shell
   * owns it once one is.
   */
  private handleInitializeRepositoryRequest = async (e: Event): Promise<void> => {
    const path = (e as CustomEvent<{ path?: string }>).detail?.path;
    dialogs.close('repositoryScan');
    await this.updateComplete;
    const welcome = this.renderRoot.querySelector('lv-welcome');
    if (welcome) {
      welcome.openInitDialog(path);
      return;
    }
    const initDialog = this.renderRoot.querySelector('lv-init-dialog');
    if (initDialog) {
      initDialog.open(path);
      return;
    }
    showToast('Could not open the Initialize Repository dialog', 'error');
  };

  /** Start listening for folders dropped onto the window. */
  private async setupWindowDropListener(): Promise<void> {
    this.dropUnlisten = await startRepositoryDropListener((active) => {
      this.fileDragActive = active;
    });
  }

  /**
   * Open the Git Configuration dialog — where user.name/user.email are set.
   * Dispatched by the commit panel when there is no identity to sign off with,
   * so the warning it shows leads somewhere.
   */
  private handleOpenGitConfig = (): void => {
    dialogs.open('config');
  };

  // True while any integration dialog is open.
  private get integrationDialogOpen(): boolean {
    return dialogs.isOpen('gitHub') || dialogs.isOpen('gitLab') || dialogs.isOpen('bitbucket') || dialogs.isOpen('azureDevOps') || dialogs.isOpen('oidc');
  }

  // True only while a provider/OIDC dialog is open ON TOP of the profile manager
  // via the explicit "Connect a new account" flow. Drives the profile manager's
  // `demoted` (render-behind) visual. Unlike the old inference, opening a provider
  // dialog standalone (command palette) while the manager happens to be open does
  // NOT demote it — because no return context was set.
  private get profileManagerDemoted(): boolean {
    return this.integrationDialogOpen && this.integrationContext?.returnTo === 'profile-manager';
  }

  /**
   * Open a provider/OIDC dialog FROM the profile manager's connect flow. Captures
   * the explicit return context (from the event detail) so the provider dialog
   * shows a Back arrow + breadcrumb and, on close, returns here and (when the
   * context carries attach intent) attaches the connected account.
   */
  private handleOpenIntegrationFromManager(
    type: IntegrationType,
    e: CustomEvent<IntegrationOpenContext | undefined>,
  ): void {
    // The profile manager always sends an explicit context. Fall back to a
    // non-attaching context if somehow absent, so we never silently auto-attach.
    this.integrationContext = e.detail ?? {
      returnTo: 'profile-manager',
      integrationType: type,
      profileId: '',
      profileName: '',
      attach: false,
    };
    this.setIntegrationDialogOpen(type, true);
  }

  /**
   * Open a provider/OIDC dialog STANDALONE (command palette, dashboard, toolbar).
   * Clears any return context so the dialog shows no Back arrow and never
   * auto-attaches to a profile.
   */
  openIntegrationStandalone(type: IntegrationType): void {
    this.integrationContext = null;
    this.setIntegrationDialogOpen(type, true);
  }

  // Back arrow shows ONLY when the current provider dialog was opened with a
  // return target — derived from explicit context, not global manager state.
  private get integrationBackButton(): boolean {
    return this.integrationContext?.returnTo === 'profile-manager';
  }

  // Breadcrumb name shows only when the open was an attach flow.
  private get integrationAttachName(): string {
    return this.integrationContext?.attach ? this.integrationContext.profileName : '';
  }

  /**
   * "Create pull request..." on a branch in the sidebar.
   *
   * Routed to the provider dialog that ALREADY owns the create flow rather
   * than reimplemented: the dialog holds the form, the account selection, the
   * create call and its own success/error feedback. All this does is open the
   * right one on its create tab with the branch prefilled as the source.
   */
  private handleCreatePullRequest = async (
    e: CustomEvent<{
      provider?: PullRequestProviderId;
      sourceBranch?: string;
      baseBranch?: string;
    }>,
  ): Promise<void> => {
    const provider = e.detail?.provider;
    const sourceBranch = e.detail?.sourceBranch;
    if (!provider || !sourceBranch) return;

    this.openIntegrationStandalone(provider);
    // The dialogs are always rendered (only their `open` flag changes), but the
    // very first open still needs this render to land before the element and
    // its own update cycle are reachable.
    await this.updateComplete;

    switch (provider) {
      case 'github': {
        const dialog = this.githubDialog;
        if (!dialog) break;
        await dialog.updateComplete;
        dialog.startCreatePullRequest(sourceBranch, e.detail?.baseBranch);
        return;
      }
      case 'gitlab': {
        const dialog = this.gitlabDialog;
        if (!dialog) break;
        await dialog.updateComplete;
        dialog.startCreateMergeRequest(sourceBranch, e.detail?.baseBranch);
        return;
      }
      case 'bitbucket': {
        const dialog = this.bitbucketDialog;
        if (!dialog) break;
        await dialog.updateComplete;
        dialog.startCreatePullRequest(sourceBranch, e.detail?.baseBranch);
        return;
      }
      case 'azure-devops': {
        const dialog = this.azureDevOpsDialog;
        if (!dialog) break;
        await dialog.updateComplete;
        dialog.startCreatePullRequest(sourceBranch, e.detail?.baseBranch);
        return;
      }
    }

    // The dialog is open but could not be reached, so the create form was never
    // prefilled. Say so rather than leaving the user staring at a blank form
    // wondering which branch it is about.
    showToast('Could not open the create form. Fill in the branch manually.', 'error');
  };

  private setIntegrationDialogOpen(type: IntegrationType, open: boolean): void {
    switch (type) {
      case 'github': dialogs.setOpen('gitHub', open); break;
      case 'gitlab': dialogs.setOpen('gitLab', open); break;
      case 'bitbucket': dialogs.setOpen('bitbucket', open); break;
      case 'azure-devops': dialogs.setOpen('azureDevOps', open); break;
      case 'oidc': dialogs.setOpen('oidc', open); break;
    }
  }

  /**
   * A provider/OIDC dialog closed (via Back or ×). When it was opened from the
   * profile manager (explicit context present), deterministically return there
   * and run the explicit attach-after-connect. Otherwise just close it.
   */
  private handleIntegrationDialogClose(type: IntegrationType): void {
    this.setIntegrationDialogOpen(type, false);
    const context = this.integrationContext;
    this.integrationContext = null;
    if (context?.returnTo === 'profile-manager') {
      // The profile manager stayed mounted (demoted) underneath; reveal it and
      // attach the just-connected account per the explicit context.
      void this.profileManagerDialog?.revealAfterConnect(context);
    }
  }

  private handleTriggerAbort = (e: Event): void => {
    const repoPath = this.resolvePinnedRepo(
      (e as CustomEvent<{ repoPath?: string }>).detail?.repoPath,
    );
    if (!repoPath) return;
    void this.handleAbortOperation(repoPath);
  };

  /**
   * "Force Push" from a rejected-push suggestion toast.
   *
   * The suggestion for libgit2's "non-fastforwardable" told the user to
   * force-push — the only correct recovery after an amend or rebase — but the
   * app had no affordance for it anywhere, so the advice dead-ended. This is
   * that affordance, and it uses force-with-lease: if the remote moved since
   * the last fetch (someone else pushed while the toast was up) the push is
   * refused rather than silently discarding their commits.
   */
  private handleForcePush = (e: Event): void => {
    const repoPath = this.resolvePinnedRepo(
      (e as CustomEvent<{ repoPath?: string }>).detail?.repoPath,
    );
    if (!repoPath) return;
    void this.runPushExclusive(repoPath, () => this.forcePush(repoPath));
  };

  private async forcePush(repoPath: string): Promise<void> {
    const repo = repositoryStore
      .getState()
      .openRepositories.find((r) => r.repository.path === repoPath);
    if (!repo) return;

    // Names the BRANCH, not just the repository: this is the one operation in
    // the app that can discard commits belonging to someone else, so the
    // confirm has to say which ref it is about to overwrite.
    const branch = repo.currentBranch?.shorthand ?? repo.repository.headRef;
    const confirmed = await showConfirm(
      'Force Push',
      `This replaces "${branch}" on the remote of ${repo.repository.name} with your ` +
        `local commits. Any commits on the remote that you do not have will be ` +
        `removed from it. The push is refused if the remote has moved since your ` +
        `last fetch.`,
      'error'
    );
    if (!confirmed) return;

    const opId = progressService.startOperation('push', 'Force pushing to remote...', {
      cancellable: true,
    });
    const result = await gitService.push({
      path: repoPath,
      forceWithLease: true,
      silent: true,
      operationId: opId,
    });
    if (result.success) {
      progressService.completeOperation(opId);
      // No success toast here: the backend emits remote-operation-completed and
      // setupRemoteOperationListeners toasts it — naming the branch and remote,
      // which this one could not. Adding a second stacked two messages on one
      // click, the same rule handleFetch/handlePull/handlePush already follow.
      this.refreshConflictDialogRepo(repoPath);
    } else {
      progressService.failOperation(opId);
      if (gitService.isOperationCancelled(result.error)) {
        showToast('Force push cancelled', 'info');
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // NOT through showErrorWithSuggestion: a force push that is itself
        // rejected would match the same branch that produced this toast and
        // offer Force Push again, an unbounded loop over the one action that
        // discards remote commits.
        showToast(result.error?.message || 'Force push failed', 'error');
      }
    }
  }

  /**
   * "Force Push Tag" from a rejected tag-push suggestion toast. The previous
   * suggestion said to delete the remote tag first, which Leviathan cannot do.
   */
  private handleForcePushTag = (e: Event): void => {
    const detail = (e as CustomEvent<{ tagName?: string; repoPath?: string; remote?: string }>)
      .detail;
    const tagName = detail?.tagName;
    const repoPath = this.resolvePinnedRepo(detail?.repoPath);
    // The remote the rejected push was aimed at. Re-resolving it here would
    // force-move the tag on whatever the backend picks — for a fork checkout
    // that is `origin`, not the `upstream` the user chose — and report success.
    const remote = detail?.remote;
    if (!tagName || !repoPath) return;
    // The SHARED tag-push key, not a private one. This slot is held across the
    // "this moves the remote tag" confirm, and the sidebar's Push and the graph
    // ref menu's Push Tag claim the same key — so neither can push the tag out
    // from under the force push the user is authorising.
    void this.runTagPushExclusive(repoPath, tagName, () =>
      this.forcePushTag(tagName, repoPath, remote),
    );
  };

  private async forcePushTag(
    tagName: string,
    repoPath: string,
    remote?: string,
  ): Promise<void> {
    const repo = repositoryStore
      .getState()
      .openRepositories.find((r) => r.repository.path === repoPath);
    if (!repo) return;

    const remoteResult = await gitService.getPushRemote(repoPath, remote);
    if (!remoteResult.success || !remoteResult.data) {
      showToast(
        `Could not determine the tag destination: ${remoteResult.error?.message ?? 'Unknown error'}`,
        'error',
      );
      return;
    }
    const destination = remoteResult.data;

    const confirmed = await showConfirm(
      'Force Push Tag',
      `This moves the tag "${tagName}" on "${destination}" in ` +
        `${repo.repository.name} to your local commit. Anyone who already fetched ` +
        `the tag keeps the old one until they delete it locally.`,
      'error'
    );
    if (!confirmed) return;

    const result = await gitService.pushTag({
      path: repoPath,
      name: tagName,
      force: true,
      // Always explicit: the destination was resolved above, so the confirm,
      // the toast and git.service's allowlist/token lookups all name the same
      // remote.
      remote: destination,
    });
    if (result.success) {
      showToast(
        `Force pushed tag ${tagName} to ${destination}`,
        'success',
      );
      this.refreshConflictDialogRepo(repoPath);
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      // Plain toast, same reason as forcePush: routing through the suggestion
      // service would offer Force Push Tag again.
      showToast(result.error?.message || 'Force push tag failed', 'error');
    }
  }

  private handleResetToCommit(mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    return this.runRefExclusive(repoPath, () => this.resetToCommit(mode));
  }

  private async resetToCommit(mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: a hard reset discards uncommitted work
    // and must target the repo it was invoked on, even if the user switches
    // tabs (rebinding activeRepository) while the confirm is up.
    const repoPath = this.activeRepository.repository.path;

    // Confirm reset based on mode.
    //
    // EVERY mode drops the commits after the target off this branch — that is
    // what a reset is — so every confirm has to say so and name the recovery
    // path. Describing only what happens to the working tree made soft/mixed
    // read as harmless and understated hard, which is the loudest of them.
    // Phrased for ANY target. The graph context menu offers Reset on every
    // node, so the target may be a descendant of HEAD (nothing is dropped) or
    // sit on a diverged branch (the dropped set is not a simple "after X").
    // Saying "commits after X are removed" is false in the first case and
    // mischaracterises the second — and a confirm that overstates trains users
    // to dismiss the one that matters.
    const droppedNote =
      `This branch will point at ${commit.shortId}. Any commit no longer reachable ` +
      `from it is recoverable only through the reflog.`;

    if (mode === 'hard') {
      const confirmed = await showConfirm(
        'Hard Reset',
        `Hard reset to "${commit.summary}"?\n\n${droppedNote}\n\n` +
          `All uncommitted changes are also discarded permanently — those are not ` +
          `in the reflog and cannot be recovered.`,
        'warning'
      );
      if (!confirmed) return;
    } else if (mode === 'mixed') {
      const confirmed = await showConfirm(
        'Mixed Reset',
        `Reset to "${commit.summary}"?\n\n${droppedNote}\n\n` +
          `Your working-directory changes are kept, but unstaged.`,
        'warning'
      );
      if (!confirmed) return;
    } else if (mode === 'soft') {
      const confirmed = await showConfirm(
        'Soft Reset',
        `Reset to "${commit.summary}"?\n\n${droppedNote}\n\n` +
          `Your changes remain staged.`,
        'warning'
      );
      if (!confirmed) return;
    }

    const result = await import('./services/git.service.ts').then((m) =>
      m.reset({
        path: repoPath,
        targetRef: commit.oid,
        mode,
      })
    );

    if (result.success) {
      // Without this the user cannot tell a completed reset from a click that
      // did nothing — failure was reported, success was silent. Every sibling
      // destructive handler in this file toasts on success.
      showToast(`Reset to ${commit.shortId} (${mode})`, 'success');
      this.refreshConflictDialogRepo(repoPath);
    } else {
      log.error('Reset failed:', result.error);
      showErrorWithSuggestion(result.error?.message || '', 'Reset failed');
    }
  }

  private handleCreateTagFromContext(): void {
    const commit = this.contextMenu.commit;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (commit) {
      this.createTagDialog?.open(commit.oid);
    }
  }

  /**
   * Name the selected commit after the most recent tag reachable from it.
   * Read-only, so it is not gated on the ref-operation lock the mutating
   * items beside it take.
   */
  private handleDescribeFromContext(): void {
    const commit = this.contextMenu.commit;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (commit) {
      this.describeDialog?.open(commit.oid, commit.summary);
    }
  }

  private handleCreateBranchFromContext(): void {
    const commit = this.contextMenu.commit;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (commit) {
      this.createBranchDialog?.open(commit.oid);
    }
  }

  /** Not gated on isRefOperationInFlight(): opening the dialog writes no git
   * state, same as Create tag / Create branch above. */
  private handleCreatePatchFromContext(): void {
    const commit = this.contextMenu.commit;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (commit) {
      this.exportImportDialog?.open({ tab: 'patch', patchMode: 'create', commitOid: commit.oid });
    }
  }

  private handleExportArchiveFromContext(): void {
    const refName = this.refContextMenu.refName;
    this.refContextMenu = { ...this.refContextMenu, visible: false };
    if (refName) {
      this.exportImportDialog?.open({ tab: 'archive', ref: refName });
    }
  }

  /**
   * Create a fixup commit targeting the selected commit
   * Requires staged changes. The fixup commit will be marked with "fixup! <original-message>"
   * Can be auto-squashed later with interactive rebase --autosquash
   */
  private handleFixupCommit(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    return this.runRefExclusive(repoPath, () => this.fixupCommit());
  }

  private async fixupCommit(): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured once, before the status await: the fixup commit must be created
    // in the repo it was invoked on, not whichever tab is active if the user
    // switches during the (yielding) status check.
    const repoPath = this.activeRepository.repository.path;

    // Check if there are staged changes
    const statusResult = await gitService.getStatus(repoPath);
    if (!statusResult.success || !statusResult.data) {
      showToast('Failed to check status', 'error');
      return;
    }

    const hasStagedChanges = statusResult.data.some(f => f.isStaged);
    if (!hasStagedChanges) {
      showToast('No staged changes to fixup', 'error');
      return;
    }

    // Create fixup commit
    const result = await gitService.createCommit(repoPath, {
      message: `fixup! ${commit.summary}`,
    });

    if (result.success) {
      showToast(`Created fixup commit for ${commit.shortId}`, 'success');
      this.refreshConflictDialogRepo(repoPath);
      window.dispatchEvent(new CustomEvent('status-refresh'));
    } else {
      showErrorWithSuggestion(result.error?.message || '', 'Failed to create fixup commit');
    }
  }

  /**
   * Create a squash commit targeting the selected commit
   * Similar to fixup but preserves the message for editing during autosquash
   */
  private handleSquashCommit(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    return this.runRefExclusive(repoPath, () => this.squashCommit());
  }

  private async squashCommit(): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured once, before the status await: the squash commit must be created
    // in the repo it was invoked on, not whichever tab is active if the user
    // switches during the (yielding) status check.
    const repoPath = this.activeRepository.repository.path;

    // Check if there are staged changes
    const statusResult = await gitService.getStatus(repoPath);
    if (!statusResult.success || !statusResult.data) {
      showToast('Failed to check status', 'error');
      return;
    }

    const hasStagedChanges = statusResult.data.some(f => f.isStaged);
    if (!hasStagedChanges) {
      showToast('No staged changes to squash', 'error');
      return;
    }

    // Create squash commit
    const result = await gitService.createCommit(repoPath, {
      message: `squash! ${commit.summary}`,
    });

    if (result.success) {
      showToast(`Created squash commit for ${commit.shortId}`, 'success');
      this.refreshConflictDialogRepo(repoPath);
      window.dispatchEvent(new CustomEvent('status-refresh'));
    } else {
      showErrorWithSuggestion(result.error?.message || '', 'Failed to create squash commit');
    }
  }

  /**
   * Reword the selected commit
   * For HEAD: Opens amend mode in commit panel
   * For other commits: Dispatches event to open interactive rebase with reword action
   */
  /**
   * Refuse a rewrite-in-place of a merge commit, with a reason.
   *
   * get_rebase_commits skips merge commits (a `pick` of one dies mid-rebase),
   * so the plan the dialog loads for `<merge>^` contains every commit in
   * `<merge>^..HEAD` EXCEPT the one the user asked to reword — including the
   * merged-in side branch. Start Rebase stays enabled, and one click replays
   * that set linearly onto the merge's first parent: the merge is destroyed
   * and the side branch rewritten, from a gesture that promised only to change
   * a message.
   */
  private isMergeCommit(commit: { shortId: string; parentIds?: string[] }): boolean {
    if ((commit.parentIds?.length ?? 0) <= 1) return false;
    showToast(
      `${commit.shortId} is a merge commit — its message cannot be rewritten by rebase`,
      'warning',
    );
    return true;
  }

  private async handleRewordCommit(): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the history await: the reword targets THIS repo's commit.
    const repoPath = this.activeRepository.repository.path;

    const isHead = await this.isHeadCommit(commit.oid, repoPath, 'reword');
    if (isHead === null) return;

    if (isHead) {
      // For HEAD, just trigger amend mode
      await this.dispatchAmend(commit);
    } else {
      // For other commits, open interactive rebase dialog pre-configured for rewording
      if (this.isMergeCommit(commit)) return;
      if (!(await this.canRewriteInPlace(commit.oid, commit.shortId, repoPath))) return;
      this.interactiveRebaseDialog?.open(`${commit.oid}^`, {
        rewordCommitOid: commit.oid,
      });
    }
  }

  /**
   * Is `oid` the commit HEAD points at?
   *
   * Returns null when the answer must not be acted on — the user switched
   * repository during the history await, and both the commit panel and the
   * interactive-rebase dialog bind to the LIVE active repo, so acting would
   * configure THIS repo's commit against another one.
   *
   * Compares against the first commit in history: correct for a branch
   * checkout, and still correct in detached HEAD, where the first commit in
   * history is HEAD.
   */
  /**
   * Refuse the interactive-rebase reword/amend route for a commit that is not
   * in HEAD's history.
   *
   * The graph loads every branch, so both menu items are offered on commits
   * that live only elsewhere. `<oid>^` is a valid revspec for any commit, so
   * nothing downstream noticed: the plan came back as the CURRENT branch's
   * history with the target absent, no reword row appeared, and Start Rebase
   * was still enabled — one click from replaying this branch onto an unrelated
   * one.
   */
  private async canRewriteInPlace(
    oid: string,
    shortId: string,
    repoPath: string,
  ): Promise<boolean> {
    const result = await gitService.isAncestorOfHead(repoPath, oid);
    if (this.activeRepository?.repository.path !== repoPath) return false;
    if (!result.success) {
      showToast(result.error?.message ?? 'Could not check where that commit lives', 'error');
      return false;
    }
    if (!result.data) {
      showToast(
        `${shortId} is not on the current branch — check out the branch that ` +
          `contains it first`,
        'warning',
      );
      return false;
    }
    return true;
  }

  private async isHeadCommit(
    oid: string,
    repoPath: string,
    operation: string,
  ): Promise<boolean | null> {
    const historyResult = await gitService.getCommitHistory({ path: repoPath, limit: 1 });
    if (this.activeRepository?.repository.path !== repoPath) {
      showToast(`Repository changed — ${operation} cancelled`, 'warning');
      return null;
    }
    return !!(
      historyResult.success &&
      historyResult.data &&
      historyResult.data.length > 0 &&
      historyResult.data[0].oid === oid
    );
  }

  /**
   * Quick amend from the graph's commit context menu.
   *
   * Amend ONLY ever rewrites HEAD — create_commit re-parents
   * `repo.head()?.peel_to_commit()` regardless of which commit the UI thinks
   * it is amending. This handler used to trust the clicked commit, so amending
   * any older commit replaced HEAD instead: HEAD's message became the clicked
   * commit's, any staged changes were folded into HEAD, the commit the user
   * actually right-clicked was untouched, and HEAD's original commit survived
   * only in the reflog. The commit panel showed the clicked commit's short id
   * throughout, so nothing said otherwise.
   *
   * Reword has always performed this check; amend was left behind. Non-HEAD
   * commits go to the same interactive-rebase route rather than dead-ending.
   */
  private async handleQuickAmend(): Promise<void> {
    const commit = this.contextMenu.commit;
    if (!commit || !this.activeRepository) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    const repoPath = this.activeRepository.repository.path;
    const isHead = await this.isHeadCommit(commit.oid, repoPath, 'amend');
    if (isHead === null) return;

    if (isHead) {
      await this.dispatchAmend(commit);
    } else {
      // Same gates as reword — see isMergeCommit and canRewriteInPlace. Checked
      // BEFORE the "opening interactive rebase" toast, so a refusal is not
      // preceded by a promise the app is about to break.
      if (this.isMergeCommit(commit)) return;
      if (!(await this.canRewriteInPlace(commit.oid, commit.shortId, repoPath))) return;
      showToast('Only the latest commit can be amended — opening interactive rebase', 'info');
      this.interactiveRebaseDialog?.open(`${commit.oid}^`, {
        rewordCommitOid: commit.oid,
      });
    }
  }

  private handleConflictResolved(): void {
    const pinnedPath = this.conflictDialogConfig?.repoPath ?? null;
    this.closeConflictDialog();
    this.refreshConflictDialogRepo(pinnedPath);
  }

  private handleConflictAborted(): void {
    const pinnedPath = this.conflictDialogConfig?.repoPath ?? null;
    this.closeConflictDialog();
    this.refreshConflictDialogRepo(pinnedPath);
  }

  /**
   * Refresh the repo a conflict dialog operates/operated ON — used both
   * when a conflict opens the dialog and when Complete/Abort closes it.
   * The user can switch tabs during the triggering operation's await (and
   * behind the open dialog), so refreshing the ACTIVE repo could leave the
   * operated-on repo showing a stale merge state (state/status/graph)
   * until some unrelated event refreshed it. Refresh the pinned repo
   * instead: live when it is still active, via the stale-on-activate path
   * (plus a badge hydration so its tab updates promptly) when it is
   * backgrounded.
   */
  refreshConflictDialogRepo(pinnedPath: string | null): void {
    if (!pinnedPath || pinnedPath === this.activeRepository?.repository.path) {
      this.handleRefresh();
      return;
    }
    // Only for a repo that is still OPEN. A slow operation can land after its
    // tab was closed — teardownRepoServices() has already dropped the path,
    // and adding it back here left an entry no one ever removes: it survived
    // for the rest of the session, made a later reopen of the same path do a
    // spurious extra refresh, and grew without bound across close/reopen
    // cycles. Nothing to refresh either way once the tab is gone.
    const isOpen = repositoryStore
      .getState()
      .openRepositories.some((r) => r.repository.path === pinnedPath);
    if (!isOpen) return;

    this.staleRepoPaths.add(pinnedPath);
    this.scheduleBadgeHydration(pinnedPath);
  }

  private handleResizeStart(e: MouseEvent, type: 'left' | 'right'): void {
    e.preventDefault();
    this.resizing = type;
    this.resizeStartPos = e.clientX;
    this.resizeStartValue = type === 'left' ? this.leftPanelWidth : this.rightPanelWidth;
    this.classList.add('resizing', 'resizing-h');

    document.addEventListener('mousemove', this.boundHandleMouseMove);
    document.addEventListener('mouseup', this.boundHandleMouseUp);
  }

  private handleResizeMove(e: MouseEvent): void {
    if (!this.resizing) return;

    // Only remember where the pointer is; the width is assigned once per
    // frame below. Writing it here re-rendered the whole shell at
    // pointer-event rate (well above the display refresh rate) for a value
    // the user can only ever see once per frame.
    this.resizePendingClientX = e.clientX;
    if (this.resizeRafId !== null) return;
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = null;
      this.applyPendingResize();
    });
  }

  /** Apply the most recent coalesced pointer position to the panel width. */
  private applyPendingResize(): void {
    const clientX = this.resizePendingClientX;
    if (clientX === null || !this.resizing) return;
    this.resizePendingClientX = null;

    const delta = clientX - this.resizeStartPos;
    if (this.resizing === 'left') {
      const newWidth = Math.max(150, Math.min(400, this.resizeStartValue + delta));
      this.leftPanelWidth = newWidth;
    } else {
      const newWidth = Math.max(280, Math.min(600, this.resizeStartValue - delta));
      this.rightPanelWidth = newWidth;
    }
  }

  private handleResizeEnd(): void {
    // Flush the last coalesced move BEFORE clearing `resizing` (which
    // applyPendingResize checks): mouseup usually lands in the same frame as
    // the final mousemove, and dropping that frame would leave the divider
    // a few pixels away from where the user released it.
    this.cancelPendingResizeFrame();
    this.applyPendingResize();
    this.resizing = null;
    this.classList.remove('resizing', 'resizing-h');
    document.removeEventListener('mousemove', this.boundHandleMouseMove);
    document.removeEventListener('mouseup', this.boundHandleMouseUp);
  }

  private cancelPendingResizeFrame(): void {
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
  }

  private handleCommitSelected(e: CustomEvent<CommitSelectedEvent>): void {
    this.selectedCommit = e.detail.commit;
    this.selectedCommitRefs = e.detail.refs;
    // A plain click sends a one-commit list, which IS the "selection cleared
    // back to one" signal — the graph re-announces on every selection change,
    // including the pruning pass after a reload, so this stays in step with
    // what the canvas paints without a second source of truth.
    this.selectedCommits = e.detail.commits.length > 1 ? [...e.detail.commits] : [];
  }

  /** The graph's loaded commits, newest first — the ordering authority. */
  private loadedGraphCommits(): Commit[] {
    return this.graphCanvas?.getLoadedCommits() ?? [];
  }

  /**
   * The multi-selection the commit context menu is acting on, ancestor first,
   * or `[]` when the menu is a single-commit menu.
   *
   * Empty unless the right-clicked commit is part of the selection: the graph
   * collapses the selection onto any commit clicked outside it, so a menu
   * offering batch actions over a set that no longer contains its own subject
   * would be acting on something the user cannot see highlighted.
   */
  private get menuSelection(): Commit[] {
    const subject = this.contextMenu.commit;
    if (!subject || this.selectedCommits.length < 2) return [];
    if (!this.selectedCommits.some((c) => c.oid === subject.oid)) return [];
    const ordered = orderCommitsForApply(this.selectedCommits, this.loadedGraphCommits());
    // The subject has to survive the graph's own list too, or the batch would
    // run over a set the menu's header does not belong to.
    if (!ordered.some((c) => c.oid === subject.oid)) return [];
    return ordered.length > 1 ? ordered : [];
  }

  private handleSelectCommit(e: CustomEvent<{ oid: string }>): void {
    this.revealCommitInGraph(e.detail.oid);
  }

  private async handleCheckoutBranchFromGraph(e: CustomEvent<{ branchName: string }>): Promise<void> {
    // A SINGLE left-click on a branch label reaches here, so this is the
    // easiest checkout in the app to fire twice. With a dirty tree,
    // checkout_with_autostash stashes, applies index 0, then drops index 0 —
    // and a stash index is a position, so a second run's save shifts the
    // first's entry and the two cross-apply and cross-drop each other's work.
    // Routed through the helper rather than claiming inline: the canvas draws
    // its ref labels itself, so this control can render no disabled state and
    // a silent refusal is indistinguishable from a dead click. The helper
    // reports it. The ref-menu handlers below still claim inline, which is
    // fine — their buttons carry ?disabled bindings, so the refusal is
    // already visible there.
    if (!this.activeRepository) return;
    const repoPath = this.activeRepository.repository.path;
    return this.runRefExclusive(repoPath, () => this.checkoutBranchFromGraph(e, repoPath));
  }

  private async checkoutBranchFromGraph(
    e: CustomEvent<{ branchName: string }>,
    repoPath: string,
  ): Promise<void> {
    const branchName = e.detail.branchName;
    const result = await gitService.checkoutWithAutoStash(repoPath, branchName);

    if (result.success && result.data?.success) {
      this.handleAutoStashToast(result.data, branchName, repoPath);
      // Pinned refresh, matching the sibling checkout handlers.
      this.refreshConflictDialogRepo(repoPath);
    } else {
      log.error('Failed to checkout branch:', result.data?.message || result.error);
      showErrorWithSuggestion(
        result.data?.message || result.error?.message || '',
        'Failed to checkout branch',
      );
    }
  }

  private handleCopySha(e: CustomEvent<{ sha: string }>): void {
    // Show brief feedback that SHA was copied
    showToast(`Copied SHA ${e.detail.sha} to clipboard`, 'success');
  }

  /**
   * A note was added, edited or removed in the commit details panel. Notes
   * live in refs/notes/*, which the graph does not draw, so there is nothing
   * to refresh — the panel owns its own reload. All this needs to do is
   * confirm the write, the same way handleCopySha confirms a copy.
   */
  private handleNotesChanged(
    e: CustomEvent<{ action: 'added' | 'updated' | 'removed'; commitOid: string; notesRef: string }>
  ): void {
    const { action, commitOid } = e.detail;
    const shortOid = commitOid.substring(0, 7);
    const verb = action === 'added' ? 'added to' : action === 'updated' ? 'updated on' : 'removed from';
    showToast(`Note ${verb} ${shortOid}`, 'success');
  }

  /**
   * The graph canvas loaded, cleared or extended its commit set (or its
   * refs). Re-take the palette/export mirror so those consumers see the new
   * data without render() having to ask the canvas for it every update.
   */
  private handleGraphCommitsChanged(): void {
    this.syncGraphPaletteData();
  }

  /**
   * Copy the graph canvas's loaded commits and tag tips into state.
   *
   * All three fields are sampled together so the repository path always
   * describes the two lists beside it — lv-export-import-dialog uses exactly
   * that comparison to decide whether the lists belong to the repo it shows.
   */
  private syncGraphPaletteData(): void {
    const canvas = this.graphCanvas;
    this.graphPaletteCommits = canvas?.getLoadedCommits() ?? [];
    this.graphPaletteTags = canvas?.getTagTips() ?? [];
    this.graphPaletteRepositoryPath = canvas?.repositoryPath ?? '';
  }

  private handleGraphNotice(e: CustomEvent<{ message: string; type?: 'info' | 'success' | 'error' }>): void {
    // User-facing notices from the graph canvas (it has no toast of its own)
    showToast(e.detail.message, e.detail.type ?? 'info', 4000);
  }

  private handleFileSelected(e: CustomEvent<{ file: StatusEntry; isPartiallyStaged?: boolean }>): void {
    this.openWorkingTreeDiff(e.detail.file, e.detail.isPartiallyStaged ?? false);
  }

  /** Shared by the file list and the diff search, so both route conflicts and
   * blame teardown identically. */
  private openWorkingTreeDiff(file: StatusEntry, isPartiallyStaged = false): void {
    // A conflicted file is resolved in the merge editor, never shown as a raw
    // diff — its working-tree content is git's conflict-marker text. Open the
    // dialog on the file that was actually clicked.
    if (file.isConflicted) {
      this.openConflictDialogFromState(file.path);
      return;
    }
    // Close blame if open
    dialogs.close('blame');
    this.blameFile = null;
    this.blameCommitOid = null;
    // Close file history if open. It sits last in the center pane's
    // priority order, so leaving it set hides it under the new diff and then
    // uncovers it — history for a file the user moved on from — the moment
    // the diff is closed. Unlike the diff a file-history pane opens
    // (`handleFileHistoryViewDiff`), this selection comes from the right
    // panel, not from history, so there is no drill-down to return to.
    dialogs.close('fileHistory');
    // Working directory file selected - show diff
    this.diffFile = file;
    this.diffFilePartiallyStaged = isPartiallyStaged;
    this.diffCommitFile = null;
    dialogs.open('diff');
  }

  private handleCommitFileSelected(e: CustomEvent<{ commitOid: string; filePath: string }>): void {
    // Close blame if open
    dialogs.close('blame');
    this.blameFile = null;
    this.blameCommitOid = null;
    // Close file history if open — same reason as handleFileSelected: it
    // would otherwise reappear under the user when this diff is closed.
    dialogs.close('fileHistory');
    // Commit file selected - show diff
    this.diffCommitFile = {
      commitOid: e.detail.commitOid,
      filePath: e.detail.filePath,
    };
    this.diffFile = null;
    dialogs.open('diff');
  }

  /**
   * Closing the diff pane unmounts the inline editor with it.
   *
   * The editor guards every teardown it can see — Cancel confirms, a file
   * change warns — but the × button, Escape and a repository tab switch are all
   * owned by app-shell and simply close the diff, dropping typed text
   * with no confirm and no message. Escape is the sharpest case: the editor's
   * own indicator says "Esc to cancel" while the header says "Close diff (Esc)",
   * and which one won depended purely on whether the caret was in the textarea.
   */
  private warnIfDiscardingEdits(): void {
    const editing = this.diffView;
    if (editing?.hasUnsavedEdits) {
      showToast(
        `Unsaved edits to ${editing.editingPath ?? 'this file'} were discarded`,
        'warning'
      );
    }
  }

  private handleCloseDiff(): void {
    this.warnIfDiscardingEdits();
    dialogs.close('diff');
    this.diffFile = null;
    this.diffCommitFile = null;
  }

  private handleTagSelected(e: CustomEvent<{ tag: Tag }>): void {
    const tag = e.detail.tag;
    if (tag.targetOid) {
      this.revealCommitInGraph(tag.targetOid);
    }
  }

  private handleBranchSelected(e: CustomEvent<{ branch: Branch }>): void {
    const branch = e.detail.branch;
    if (branch.targetOid) {
      this.revealCommitInGraph(branch.targetOid);
    }
  }

  private getDiffTitle(): string {
    if (this.diffFile) {
      return this.diffFile.isStaged ? 'Staged Changes' : 'Working Changes';
    }
    if (this.diffCommitFile) {
      return `Commit ${this.diffCommitFile.commitOid.substring(0, 7)}`;
    }
    return 'Diff';
  }

  private getDiffPath(): string {
    if (this.diffFile) {
      return this.diffFile.path;
    }
    if (this.diffCommitFile) {
      return this.diffCommitFile.filePath;
    }
    return '';
  }

  handleStageAll(): void {
    void this.dispatchToFileStatus('stage-all');
  }

  handleUnstageAll(): void {
    void this.dispatchToFileStatus('unstage-all');
  }

  /**
   * `trigger-amend` is heard only by `lv-commit-panel`, which lives in the
   * right panel's Changes tab.
   *
   * Right-clicking a commit in the graph selects it first, and a new selection
   * auto-switches that panel to Details — so amend mode was being turned on
   * inside a `.tab-panel` with `display: none` and the gesture looked like it
   * did nothing. With the panel hidden entirely (Ctrl+J) the component is
   * unmounted and the event had no listener at all. Same class as
   * dispatchToFileStatus and openBranchCleanup.
   */
  private async dispatchAmend(commit: Commit): Promise<void> {
    if (!this.rightPanelVisible) {
      uiStore.getState().togglePanel('right');
      await this.updateComplete;
    }
    // Optional chaining: a shell that has never rendered has no renderRoot,
    // and the dispatch below must still happen.
    const panel = this.renderRoot?.querySelector('lv-right-panel') as
      | (LitElement & { showChanges?: () => void })
      | null;
    await panel?.updateComplete;
    panel?.showChanges?.();
    await panel?.updateComplete;
    window.dispatchEvent(new CustomEvent('trigger-amend', { detail: { commit } }));
  }

  /**
   * `stage-all` / `unstage-all` are heard only by `lv-file-status`, which lives
   * inside the right panel and is unmounted while that panel is hidden — so
   * with Ctrl+J pressed the `s` / `u` shortcuts and both palette entries
   * silently did nothing, and there was no other way to stage. Reveal the panel
   * and let it render before dispatching, exactly as openBranchCleanup does for
   * the left panel.
   */
  private async dispatchToFileStatus(eventName: string): Promise<void> {
    if (!this.rightPanelVisible) {
      uiStore.getState().togglePanel('right');
      await this.updateComplete;
    }
    {
      const panel = this.renderRoot.querySelector('lv-right-panel') as LitElement | null;
      await panel?.updateComplete;
      // Mounted is not the same as ready. lv-file-status registers the listener
      // in connectedCallback but loads its file list over IPC, so dispatching
      // as soon as it exists found `unstagedFiles` still empty and
      // handleStageAll returned at `if (paths.length === 0)` — the first press
      // did nothing, the second worked. loadStatus is sequence-guarded, so
      // awaiting it again is safe.
      const fileStatus = panel?.renderRoot?.querySelector('lv-file-status') as
        | (LitElement & { ensureStatusFresh?: () => Promise<void> })
        | null;
      await fileStatus?.updateComplete;
      // Require a CURRENT list, not a blind reload. With the panel already
      // visible — the default — the cached list can belong to the previous repo
      // after a tab switch, or predate a watcher event still inside its
      // debounce; either way "Stage all" would act on the wrong set. But
      // loadStatus always issues a full working-tree walk, so calling it every
      // time cost two scans per keypress. ensureStatusFresh awaits an in-flight
      // load, reloads only when something could have changed, and is otherwise
      // free.
      await fileStatus?.ensureStatusFresh?.();
    }
    window.dispatchEvent(new CustomEvent(eventName));
  }

  // Re-entrancy state for handleRefresh. Multiple callers (file-watcher,
  // @file-edited, @status-changed, child @repository-refresh) can call
  // handleRefresh concurrently; coalesce them into one follow-up pass so the
  // final state always reflects the most recent request.
  private refreshInFlight = false;
  private refreshQueued = false;

  async handleRefresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    let refreshingPath: string | null = null;
    try {
      // Refresh the repository state (e.g., after cherry-pick, merge, rebase)
      if (this.activeRepository) {
        // Capture the path before awaiting: if the user switches tabs during the
        // IPC round-trip, updateActiveRepository would otherwise write repo A's
        // data into repo B's (now-active) tab slot, corrupting its identity.
        refreshingPath = this.activeRepository.repository.path;
        const result = await gitService.openRepository({ path: refreshingPath });
        if (result.success && result.data) {
          if (
            repositoryStore.getState().getActiveRepository()?.repository.path === refreshingPath
          ) {
            repositoryStore.getState().updateActiveRepository(result.data);
          }
        } else if (!result.success) {
          showToast(result.error?.message ?? 'Failed to refresh repository', 'error');
        }
      }
      // Trigger refresh of the graph
      this.graphCanvas?.refresh?.();
      // Refresh search indexes incrementally
      if (this.activeRepository) {
        searchIndexService.refresh(this.activeRepository.repository.path);
        embeddingIndexService.refreshIndex(this.activeRepository.repository.path);
      }
      // Dispatch event for OTHER listeners (context dashboard, etc.). The
      // `source: 'app-shell'` tag lets handleWindowRefresh ignore our own
      // emission so we don't loop back into a fresh handleRefresh.
      window.dispatchEvent(
        new CustomEvent('repository-refresh', { detail: { source: 'app-shell' } }),
      );
      if (refreshingPath) {
        await this.ensureAutoFetchRunning(refreshingPath);
      }
    } finally {
      this.refreshInFlight = false;
    }
    // If a refresh request landed while we were awaiting above, run one more
    // pass and AWAIT it so callers awaiting handleRefresh see the final state.
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.handleRefresh();
    }
  }

  // "Manage Accounts" from a provider dialog: close the provider dialog and open
  // the Profiles & Accounts manager on its Accounts view. REVERSIBLE — we
  // remember which provider we came from so closing the Accounts view returns
  // there (see handleProfileManagerClose), instead of a one-way teleport.
  private handleManageAccounts(e: CustomEvent<{ integrationType?: IntegrationType }>): void {
    const from = e.detail?.integrationType ?? null;
    dialogs.close('gitHub');
    dialogs.close('gitLab');
    dialogs.close('bitbucket');
    dialogs.close('azureDevOps');
    dialogs.close('oidc');
    // If we're pivoting from a provider dialog that was stacked on top of the manager,
    // preserve the integrationContext so we can restore the stacked state later.
    if (!dialogs.isOpen('profileManager')) {
      this.integrationContext = null;
    }
    this.manageAccountsReturnProvider = from;
    dialogs.setContext('profileManager', { initialView: 'accounts' });
    // If the manager is ALREADY open (the provider dialog was launched FROM it,
    // so it's open & demoted), the `open` property won't transition false→true and
    // the manager's willUpdate/open-transition logic that applies `initialView`
    // never runs — it would reveal on its prior view (select-account/edit). Drive
    // the Accounts view explicitly instead so the click isn't a no-op.
    if (dialogs.isOpen('profileManager')) {
      this.profileManagerDialog?.showAccountsView(true);
    } else {
      dialogs.open('profileManager');
    }
  }

  // The profile manager closed. If it was opened via "Manage Accounts" from a
  // provider dialog AND the user closed out OF the Accounts view (i.e. they backed
  // out of account management rather than navigating off to edit profiles),
  // reopen that provider dialog so the navigation is reversible. The view we
  // closed from travels in the event detail (captured before the view reset).
  private handleProfileManagerClose(e: CustomEvent<{ fromView?: string }>): void {
    const returnProvider = this.manageAccountsReturnProvider;
    const closedFromAccounts = e.detail?.fromView === 'accounts';
    dialogs.close('profileManager');
    this.manageAccountsReturnProvider = null;
    if (returnProvider && closedFromAccounts) {
      this.openIntegrationStandalone(returnProvider);
    }
    // Announced for surfaces that sent the user here mid-task and owe them a
    // way back — the clone dialog's account picker reopens on this. It is
    // deliberately a plain notification rather than a second return target:
    // whoever is waiting decides for itself whether to come back.
    window.dispatchEvent(new CustomEvent('profile-manager-closed'));
  }

  private handleRestoreProvider(): void {
    const returnProvider = this.manageAccountsReturnProvider;
    this.manageAccountsReturnProvider = null;
    if (returnProvider) {
      this.setIntegrationDialogOpen(returnProvider, true);
    }
  }

  private async handleRefreshAccount(e: CustomEvent<{ accountId: string }>): Promise<void> {
    const { accountId } = e.detail;
    try {
      const account = await unifiedProfileService.getGlobalAccount(accountId);
      // D3: Surface feedback instead of silently returning when the account
      // can't be found (e.g. it was deleted between dispatch and handling).
      if (!account) {
        showToast('Account not found', 'error');
        return;
      }
      await unifiedProfileService.refreshAccountCachedUser(account);
    } catch (error) {
      log.error('Failed to refresh account', error);
      showToast('Failed to refresh account connection', 'error');
    }
  }

  handleToggleSearch(): void {
    const toolbar = this.shadowRoot?.querySelector('lv-toolbar');
    if (toolbar) {
      (toolbar as HTMLElement).dispatchEvent(new CustomEvent('focus-search'));
    }
  }

  private handleCloseSettings(): void {
    dialogs.close('settings');
  }

  private handleBlameCommitClick(e: CustomEvent<{ oid: string }>): void {
    dialogs.close('blame');
    this.revealCommitInGraph(e.detail.oid);
  }

  private handleCloseBlame(): void {
    dialogs.close('blame');
    this.blameFile = null;
    this.blameCommitOid = null;
  }

  private handleShowBlame(e: CustomEvent<{ filePath: string; commitOid?: string }>): void {
    // A fourth app-shell-owned gesture that unmounts the diff pane, and so the
    // inline editor with it — same teardown as the × and a tab switch.
    this.warnIfDiscardingEdits();
    // Close diff if open
    dialogs.close('diff');
    this.diffFile = null;
    this.diffCommitFile = null;
    // Open blame
    this.blameFile = e.detail.filePath;
    this.blameCommitOid = e.detail.commitOid ?? null;
    dialogs.open('blame');
  }

  openSearchDialog(mode: SearchDialogMode): void {
    dialogs.open('search', { mode });
  }

  /**
   * A hit from the diff search opens that file's working-tree diff.
   *
   * The search ran against `git diff` output, so the file was modified when
   * the query ran — but a stage/discard/refresh in between can retire the
   * entry. Reporting the miss keeps the row from being a dead click.
   */
  private handleShowWorkingDiff(e: CustomEvent<{ filePath: string; staged: boolean }>): void {
    const status = this.activeRepository?.status ?? [];
    const entry =
      status.find((f) => f.path === e.detail.filePath && f.isStaged === e.detail.staged) ??
      status.find((f) => f.path === e.detail.filePath);
    if (!entry) {
      showToast(
        'That file is no longer in the working-tree changes — refresh and search again',
        'info',
        4000,
      );
      return;
    }
    this.openWorkingTreeDiff(entry);
  }

  private handleSearchChange(e: CustomEvent<{ filter: SearchFilter }>): void {
    // The graph canvas receives this via the reactive `.searchFilter`
    // template binding, so it stays in sync automatically — including being
    // cleared to null when the active repo changes (tab switch). Pushing it
    // imperatively here instead would leave the canvas holding the previous
    // repo's filter on switch, dimming the new repo's graph for a query the
    // user never applied to it.
    this.searchFilter = e.detail.filter;
  }

  /**
   * Open the command palette, optionally with the search box pre-filled.
   *
   * `initialQuery` is what makes the palette usable as a targeted picker: the
   * branch entries are labelled "Switch to <branch>", so "Switch to " scores
   * them 80 (prefix match) and every other command below them. Nothing is
   * hidden — the user can still clear the box and reach the whole list.
   */
  private async openCommandPalette(initialQuery = ''): Promise<void> {
    const requestId = ++this.commandPaletteRequestId;
    // Fetch branches and tracked files for quick switching
    if (this.activeRepository) {
      const path = this.activeRepository.repository.path;
      const [branchResult, filesResult] = await Promise.all([
        gitService.getBranches(path),
        gitService.listTrackedFiles(path),
      ]);
      if (
        requestId !== this.commandPaletteRequestId ||
        this.activeRepository?.repository.path !== path
      ) return;
      // Only a failed command is an error. A repository with no branches or no
      // tracked files succeeds with an empty (or absent) payload, and toasting
      // that as "Unknown error" would cry wolf every time the palette opens.
      if (branchResult.success) {
        this.paletteBranches = branchResult.data ?? [];
      } else {
        this.paletteBranches = [];
        showToast(
          `Failed to load branches: ${branchResult.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
      if (filesResult.success) {
        this.paletteTrackedFiles = filesResult.data ?? [];
      } else {
        this.paletteTrackedFiles = [];
        showToast(
          `Failed to load tracked files: ${filesResult.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
      this.commandPaletteRepositoryPath = path;
    } else {
      this.paletteBranches = [];
      this.paletteTrackedFiles = [];
      this.commandPaletteRepositoryPath = null;
    }
    if (requestId !== this.commandPaletteRequestId) return;
    // Belt and braces on top of the graph-commits-changed subscription: the
    // mirror is re-taken here so the palette can never open on a list the
    // canvas has since moved past (a missed event, or a canvas that was
    // mounted after the last one fired).
    this.syncGraphPaletteData();
    this.commandPaletteQuery = initialQuery;
    dialogs.open('commandPalette');  }

  /**
   * Dismissal must also supersede an in-flight load. Ctrl+P stays live while
   * the palette is up (keyboard.service lets Ctrl/Cmd combos through an open
   * overlay), so a second press starts another loader; pressing Escape before
   * it settled cleared the flag, then the loader — same requestId, same
   * repository — set it straight back and the palette sprang open again over
   * whatever the user had just returned to.
   */
  private handleCommandPaletteClose(): void {
    this.commandPaletteRequestId++;
    dialogs.close('commandPalette');
  }

  requiresRepository(action: () => void): () => void {
    return () => {
      if (!this.activeRepository) {
        uiStore.getState().addToast({
          type: 'warning',
          message: 'Please open a repository first',
          duration: 3000,
        });
        return;
      }
      action();
    };
  }

  /**
   * Wire the native application menu bar (built in `src-tauri/src/menu.rs`).
   *
   * The menu never implements an action of its own: an item's id arrives here
   * and is resolved - through `app-menu.service` - to the very function its
   * command-palette twin runs.
   */
  private async setupAppMenu(): Promise<void> {
    // Watch key presses so a menu action triggered by its own accelerator is
    // not run twice on platforms where the webview sees the key press too.
    this.appMenuWatchDispose = startAcceleratorWatch();

    // Rebinding a shortcut in Settings must re-print it on the menu.
    this.appMenuShortcutUnsubscribe = keyboardService.addSettingsChangeListener(() => {
      this.syncAppMenuState(this.hasOpenRepository(), true);
    });

    try {
      const unlisten = await listenToEvent<string>(MENU_ACTION_EVENT, (id) => {
        this.handleAppMenuAction(id);
      });
      this.updateUnlisteners.push(unlisten);
    } catch (error) {
      // No Tauri host (unit tests, a browser preview): there is no native menu
      // to drive, and every action stays reachable from the palette.
      log.warn('Application menu events are unavailable:', error);
      return;
    }

    this.syncAppMenuState(this.hasOpenRepository(), true);
  }

  private hasOpenRepository(): boolean {
    return repositoryStore.getState().openRepositories.length > 0;
  }

  /**
   * Push the enabled state and current accelerators to the native menu.
   *
   * Repository-scoped items are disabled with no repository open, so they can
   * never fire into nothing - the palette's "open a repository first" guard
   * still backs them up for the keyboard route.
   */
  private syncAppMenuState(hasRepository: boolean, force = false): void {
    if (!force && this.appMenuHasRepository === hasRepository) return;
    this.appMenuHasRepository = hasRepository;
    void syncAppMenu(hasRepository).then((result) => {
      if (!result.success) {
        // A stale menu is not worth interrupting the user for, but it must not
        // disappear silently either.
        log.warn('Failed to update the application menu:', result.error?.message);
      }
    });
  }

  /** Run the action a native menu item stands for. */
  private handleAppMenuAction(id: string): void {
    if (shouldSuppressMenuAction(id)) return;

    const action = resolveMenuAction(id, this.getPaletteCommands(), this.appMenuShellHandlers());
    if (!action) {
      log.warn(`No handler for application menu item "${id}"`);
      showToast('That menu action is not available', 'error');
      return;
    }
    action();
  }

  /**
   * The handful of menu actions with no command-palette entry. Each one calls
   * the code that already owns the action - the toolbar's own handlers for
   * open/clone/init, the repository store for closing a tab.
   */
  private appMenuShellHandlers(): MenuShellHandlers {
    return {
      openRepository: () => this.dispatchToToolbar('open-repository', 'Open Repository'),
      cloneRepository: () => this.dispatchToToolbar('clone-repository', 'Clone Repository'),
      initRepository: () => this.dispatchToToolbar('init-repository', 'New Repository'),
      closeRepositoryTab: this.requiresRepository(() => {
        repositoryStore.getState().removeRepository(this.activeRepository!.repository.path);
      }),
      // The palette lists every branch with its checkout action; opening it is
      // the branch switcher, rather than a second one built for the menu. It
      // opens PRE-FILTERED to those entries — a menu item named "Switch Branch…"
      // that lands on the full command list and leaves the user to type is a
      // dead end, not a switcher.
      switchBranch: this.requiresRepository(() => {
        void this.openCommandPalette(SWITCH_BRANCH_PALETTE_QUERY);
      }),
      commandPalette: () => {
        void this.openCommandPalette();
      },
      keyboardShortcuts: () => {
        dialogs.open('shortcuts');
      },
      about: () => {
        void this.showAboutDialog();
      },
    };
  }

  /**
   * Hand a menu action to the toolbar, which owns the Open/Clone/Init flows and
   * their dialogs - the same route handleToggleSearch already uses.
   */
  private dispatchToToolbar(eventName: string, label: string): void {
    const toolbar = this.shadowRoot?.querySelector('lv-toolbar');
    if (!toolbar) {
      showToast(`${label} is not available right now`, 'error');
      return;
    }
    toolbar.dispatchEvent(new CustomEvent(eventName));
  }

  private async showAboutDialog(): Promise<void> {
    try {
      const version = await updateService.getAppVersion();
      await showMessage(
        'About Leviathan',
        `Leviathan ${version}\n\nA fully-featured, open-source, cross-platform Git GUI client.`
      );
    } catch (error) {
      log.warn('Failed to show the About dialog:', error);
      showToast('Could not show application information', 'error');
    }
  }

  /**
   * The palette command table lives in palette-commands.ts — it is a long,
   * flat list rather than behaviour, and the native menu bar resolves its own
   * item ids against these entries' `action`s, so the ids and shapes here are
   * a contract. The members it reaches for are declared by PaletteCommandHost,
   * which is why they are not private on this class.
   *
   * Memoised: render() calls this on every update of a component with ~90
   * reactive fields, and rebuilding the table handed lv-command-palette a new
   * array identity each time, making it re-filter its whole list while closed.
   * Nothing in the table varies with repository or dialog state — every action
   * reads live state when it RUNS, which is also what lets the native menu
   * resolve an id to a live action — so the modifier-key label is the entire
   * cache key.
   */
  private getPaletteCommands(): PaletteCommand[] {
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
    if (this.paletteCommandsCache && this.paletteCommandsCacheKey === mod) {
      return this.paletteCommandsCache;
    }
    const commands = buildPaletteCommands(this satisfies PaletteCommandHost);
    this.paletteCommandsCacheKey = mod;
    this.paletteCommandsCache = commands;
    return commands;  }

  private async restorePersistedRepositories(): Promise<void> {
    // "Reopen Last Repositories" off means start on the welcome screen. The
    // persisted list is deliberately LEFT ALONE — not pruned, not cleared — so
    // turning the setting back on brings the same tabs (and the same active
    // one) back. Clearing it here would make the toggle destructive and
    // one-way.
    if (!settingsStore.getState().openLastRepository) return;

    const persistedRepos = repositoryStore.getState().getPersistedOpenRepos();
    if (persistedRepos.length === 0) return;

    // Set flag to prevent duplicate notifications during restore
    this.isRestoringRepositories = true;
    uiStore.getState().setGlobalLoading(true);

    try {
      // Open all persisted repositories in PARALLEL — with many repos a
      // sequential open blocks startup for the sum of every repo's open
      // time. Results are added in the original order so tab order is
      // stable regardless of which open finishes first.
      const results = await Promise.all(
        persistedRepos.map(async (persisted) => {
          try {
            const result = await gitService.openRepository({ path: persisted.path });
            return { persisted, repo: result.success && result.data ? result.data : null };
          } catch (error) {
            console.warn(`Failed to restore repository: ${persisted.path}`, error);
            return { persisted, repo: null };
          }
        })
      );

      // Add without activating each one — activation side effects (index
      // builds, profile/integration loads) belong to the single tab that
      // ends up active, chosen below.
      for (const { repo } of results) {
        if (repo) {
          repositoryStore.getState().addRepository(repo, { activate: false });
        }
      }

      // A repo that failed to restore (moved, deleted, corrupted) must be
      // reported — a silently missing tab that silently fails again on every
      // launch looks like data loss. Prune it so it isn't retried forever;
      // it stays available in the Recent list.
      for (const { persisted, repo } of results) {
        if (!repo) {
          repositoryStore.getState().prunePersistedRepo(persisted.path);
          showToast(`Could not restore repository "${persisted.name}" (${persisted.path})`, 'error');
        }
      }

      // Remotes load in parallel too (path-keyed store update, order-free).
      await Promise.all(
        results
          .filter((r) => r.repo !== null)
          .map((r) => this.loadRepositoryRemotes(r.persisted.path))
      );

      // Land on the tab the user had active last session; fall back to the
      // last successfully restored repo when that one is gone
      const restoredPaths = results.filter((r) => r.repo !== null).map((r) => r.persisted.path);
      const lastActivePath = repositoryStore.getState().persistedActivePath;
      const targetPath =
        lastActivePath && restoredPaths.includes(lastActivePath)
          ? lastActivePath
          : restoredPaths[restoredPaths.length - 1];
      if (targetPath) {
        repositoryStore.getState().setActiveByPath(targetPath);
      }

      this.isRestoringRepositories = false;

      // Index builds are deliberately NOT started for every restored repo —
      // a search index walk plus an embedding-model inference pass per repo
      // makes startup CPU-bound with many tabs, and background repos may
      // never be used. The active repo gets its indexes here; the others
      // build lazily when their tab is first activated.
      const activeRepo = repositoryStore.getState().getActiveRepository();
      if (activeRepo) {
        this.ensureRepoIndexes(activeRepo.repository.path);
        this.checkRepositoryIntegration(activeRepo.repository.path);
      }
    } finally {
      uiStore.getState().setGlobalLoading(false);
    }
  }

  /**
   * Kick off background search/embedding index builds for a repo if they
   * aren't ready yet. Safe to call repeatedly — build deduplication and
   * readiness tracking are per repo.
   */
  private ensureRepoIndexes(repoPath: string): void {
    if (!searchIndexService.isReady(repoPath)) {
      searchIndexService.buildIndex(repoPath);
    }
    embeddingIndexService
      .getStatus(repoPath)
      .then((status) => {
        // The tab may have been closed during the status round-trip — don't
        // launch a multi-minute ONNX build for a repo that's gone (the
        // close-time cancelBuild can't cancel a build that hadn't started).
        const stillOpen = repositoryStore
          .getState()
          .openRepositories.some((r) => r.repository.path === repoPath);
        if (!status.isReady && stillOpen) {
          return embeddingIndexService.buildIndex(repoPath).then(() => undefined);
        }
        return undefined;
      })
      .catch(() => {
        /* semantic search is optional — missing model/status is not an error */
      });
  }

  private async loadWorkspaces(): Promise<void> {
    const result = await workspaceService.getWorkspaces();
    if (result.success && result.data) {
      workspaceStore.getState().setWorkspaces(result.data);
    }
  }

  /**
   * Set up auto-fetch for open repositories based on settings
   */
  private setupAutoFetch(): void {
    const settings = settingsStore.getState();

    // Send initial tray settings to backend
    emit('update-tray-settings', { minimizeToTray: settings.minimizeToTray });
    // ...and the security settings the backend enforces for itself. The Rust
    // side keeps its own copy so the very first operation after launch is
    // guarded, but this push is what makes it agree with what Settings shows.
    emitSecuritySettings(settings);

    // Subscribe to settings changes to start/stop auto-fetch and update tray.
    // Newly OPENED repos get auto-fetch from the store subscription's
    // open-set diff (see connectedCallback); this handles interval changes
    // for repos that are already open. Only an ACTUAL interval change may
    // restart the timers — the subscription fires for every settings write
    // (theme, tray, ...) and each backend restart resets the fetch delay, so
    // reacting to unrelated changes would defer fetches indefinitely.
    this.lastAutoFetchInterval = settings.autoFetchInterval;
    this.lastOfflineMode = settings.offlineMode;
    this.lastRemoteAllowlistKey = settings.remoteAllowlist.join('\0');
    this.autoFetchUnsubscribe = settingsStore.subscribe((state) => {
      // Offline mode gates the START call, but the loop it started is a Tokio
      // task with no re-check: turning offline mode on left it fetching every
      // N minutes forever, and turning it back off never revived a repo whose
      // start had been refused. Treat an offline-mode flip like an interval
      // change.
      const offlineChanged = state.offlineMode !== this.lastOfflineMode;
      const allowlistKey = state.remoteAllowlist.join('\0');
      const allowlistChanged = allowlistKey !== this.lastRemoteAllowlistKey;
      if (
        state.autoFetchInterval !== this.lastAutoFetchInterval ||
        offlineChanged ||
        allowlistChanged
      ) {
        this.lastAutoFetchInterval = state.autoFetchInterval;
        this.lastOfflineMode = state.offlineMode;
        this.lastRemoteAllowlistKey = allowlistKey;
        const paths = repositoryStore
          .getState()
          .openRepositories.map((r) => r.repository.path);
        if (allowlistChanged) {
          for (const path of paths) {
            this.stopAutoFetchLogged(path);
          }
        }
        if (state.autoFetchInterval > 0 && !state.offlineMode) {
          for (const path of paths) {
            this.startAutoFetchLogged(path, state.autoFetchInterval);
          }
        } else {
          for (const path of paths) {
            this.stopAutoFetchLogged(path);
          }
        }
      }
      // Update tray settings
      emit('update-tray-settings', { minimizeToTray: state.minimizeToTray });
      // Offline mode and the allowlist are enforced in Rust as well as here,
      // so every change has to reach it — the backend has no way to read the
      // frontend's persisted settings.
      emitSecuritySettings(state);
    });
  }

  /**
   * Listen for auto-fetch completion and remote update events
   */
  private async setupAutoFetchListeners(): Promise<void> {
    const unlistenFetch = await listenToEvent<{
      repoPath: string;
      success: boolean;
      behind: number;
      ahead: number;
      message?: string;
    }>('autofetch-completed', this.handleAutoFetchCompleted);
    this.updateUnlisteners.push(unlistenFetch);

    const unlistenUpdates = await listenToEvent<{
      repoPath: string;
      behind: number;
      ahead: number;
    }>('remote-updates-available', this.handleRemoteUpdatesAvailable);
    this.updateUnlisteners.push(unlistenUpdates);
  }

  /** Repos whose auto-fetch failure has already been reported. Auto-fetch
   * retries on a timer, so an un-deduped toast would repeat forever; a silent
   * failure is worse, though — it freezes the ahead/behind badge the user reads
   * before deciding to push or force-push. Report once per repo per outage. */
  private autoFetchFailureReported = new Set<string>();

  private reportAutoFetchFailure(repoPath: string, message?: string): void {
    if (this.autoFetchFailureReported.has(repoPath)) return;
    this.autoFetchFailureReported.add(repoPath);
    const repoName = repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath;
    showToast(
      `${repoName}: auto-fetch failed${message ? ` — ${message}` : ''}. Ahead/behind counts may be stale.`,
      'warning',
      6000,
    );
  }

  /**
   * Mirror freshly computed ahead/behind counts into a repo's store entry.
   *
   * Both remote badges — the tab bar's and the status bar's — render this one
   * field, so a writer that updates only one of them puts them out of step.
   * Path-keyed: a result belongs to the repo it was computed for, never to
   * whichever tab happens to be active when it lands.
   */
  private applyAheadBehind(repoPath: string, ahead: number, behind: number): void {
    const store = repositoryStore.getState();
    const repo = store.openRepositories.find((r) => r.repository.path === repoPath);
    if (!repo?.currentBranch) return;
    store.updateRepoData(repoPath, {
      currentBranch: { ...repo.currentBranch, aheadBehind: { ahead, behind } },
    });
  }

  // Auto-fetch runs for every open repo. Every successful result updates that
  // repo's ahead/behind in the store, which is the single field BOTH badges
  // (tab bar and status bar) render — so a background repo's result freshens
  // its own tab badge and can never paint under the active tab.
  private handleAutoFetchCompleted = (event: {
    repoPath: string;
    success: boolean;
    behind: number;
    ahead: number;
    message?: string;
  }): void => {
    if (!event.success) {
      if (event.message === 'FETCH_REMOTE_CHANGED') {
        const settings = settingsStore.getState();
        const isOpen = repositoryStore
          .getState()
          .openRepositories.some((repo) => repo.repository.path === event.repoPath);
        if (isOpen && settings.autoFetchInterval > 0 && !settings.offlineMode) {
          this.startAutoFetchLogged(event.repoPath, settings.autoFetchInterval, true);
        }
        return;
      }
      this.reportAutoFetchFailure(event.repoPath, event.message);
      return;
    }
    // Recovered — let the next failure speak again.
    this.autoFetchFailureReported.delete(event.repoPath);

    this.applyAheadBehind(event.repoPath, event.ahead, event.behind);
  };

  // With several repos auto-fetching, an unattributed toast is noise — name
  // the repo the commits arrived in. Split on both separators: Windows is a
  // shipped target and its paths use backslashes.
  private handleRemoteUpdatesAvailable = (event: {
    repoPath: string;
    behind: number;
    ahead: number;
  }): void => {
    const repoName = event.repoPath.split(/[\\/]/).filter(Boolean).pop() || event.repoPath;
    showToast(
      `${repoName}: remote has ${event.behind} new commit${event.behind !== 1 ? 's' : ''} available`,
      'info',
      5000,
    );
  };

  /**
   * Load remotes for a repository and update the store
   */
  private async loadRepositoryRemotes(repoPath: string): Promise<void> {
    try {
      const remotesResult = await gitService.getRemotes(repoPath);
      if (remotesResult.success && remotesResult.data) {
        repositoryStore.getState().updateRepoData(repoPath, { remotes: remotesResult.data });
      }
    } catch (error) {
      console.warn(`Failed to load remotes for ${repoPath}:`, error);
    }
  }

  handleFetch(): Promise<void> {
    // Pinned before the runner's awaits: a fetch is a slow network op, so if
    // the user switches tabs while it runs the refresh and any error must name
    // the repo the fetch ran ON, not whichever tab is active when it returns.
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    // The lock, the cancellable progress row, the failure reporting and the
    // refresh all live in remote-operations.service, shared with the context
    // dashboard's and the toolbar's Fetch/Pull/Push buttons — the only
    // mouse-reachable routes to these three operations, which used to run
    // their own divergent copies of all of it. The runner starts the row with
    // `{cancellable: true}` and hands its id to the backend, so the row's
    // Cancel button really aborts the transfer whichever surface started it.
    // The coalescing that matters here is still in force: keyboardService has
    // no e.repeat guard, so HOLDING Ctrl+Shift+F fires many times a second,
    // and every repeat used to launch a fully concurrent fetch.
    return runFetch(repoPath);
  }

  handlePull(pinnedRepoPath?: string): Promise<void> {
    // pinnedRepoPath comes from a suggestion toast's Pull Now, which must pull
    // the repo whose push failed even if the user has since switched tabs.
    const repoPath = pinnedRepoPath ?? this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    // Claims the SHARED working-tree lock inside the runner, not a private
    // key: a pull's fast-forward runs checkout_tree and its merge and rebase
    // paths rewrite the tree outright, so it must exclude every sidebar
    // checkout, discard and reset — not just other pulls. The runner also owns
    // the cancellable progress row and the MERGE_CONFLICT/REBASE_CONFLICT
    // routing into the resolution dialog.
    return runPull(repoPath);
  }

  handlePush(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    // The runner claims the same push slot handleForcePush holds across its
    // confirm, which is what keeps Push and Force Push mutually exclusive on
    // one repository.
    return runPush(repoPath);
  }

  private handleCancelOperation(e: CustomEvent<{ id: string }>): void {
    progressService.cancelOperation(e.detail.id);
  }

  handleCreateStash(): Promise<void> {
    if (!this.activeRepository) return Promise.resolve();
    // Pinned: if the user switches tabs while the stash is being created, the
    // refresh must target the repo that was stashed, not the active tab.
    const repoPath = this.activeRepository.repository.path;
    // `git stash push` resets the working tree to HEAD and prepends to the
    // stash list, renumbering every entry — a full working-tree mutation. The
    // shortcut fires through open dialogs, and it was for a long time the only
    // route to a stash at all, so it was never in the enumeration the lock
    // sweep worked from.
    return this.runRefExclusive(repoPath, () => this.createStashOnRepo(repoPath));
  }

  private async createStashOnRepo(repoPath: string): Promise<void> {
    // Prompted here too, not only in the stash panel: the shortcut, the palette
    // and the panel button run the same operation and report the same "Stash
    // created", so a keyboard-started stash must be nameable as well —
    // otherwise it is an indistinguishable "WIP on <branch>". null is a
    // dismissal; '' keeps git's default name. The lock is claimed by
    // runRefExclusive before this runs and released in its finally, so the
    // cancel path needs no extra bookkeeping.
    const message = await showPrompt(
      'Stash Changes',
      'Message for this stash (optional):',
      '',
      'WIP'
    );
    if (message === null) return;
    const stashMessage = message.trim();

    // includeUntracked matches the stash-list button (lv-stash-list.ts): both
    // surfaces report an identical "Stash created", so they must stash the same
    // set — otherwise the shortcut silently leaves untracked files behind and
    // the divergence only surfaces during a later checkout or clean.
    const result = await gitService.createStash({
      path: repoPath,
      // Undefined, not '': the backend only falls back to git's WIP name when
      // no message is sent (src-tauri/src/commands/stash.rs).
      message: stashMessage || undefined,
      includeUntracked: true,
    });
    if (result.success) {
      if (result.data === null) {
        // Clean working tree: nothing to stash — informational, not an error.
        showToast('No local changes to save', 'info');
        return;
      }
      showToast('Stash created', 'success');
      this.refreshConflictDialogRepo(repoPath);
    } else {
      showToast(result.error?.message ?? 'Failed to create stash', 'error');
    }
  }

  async handleRunGc(aggressive = false): Promise<void> {
    if (!this.activeRepository) return;

    // Pinned before the confirm await, like every other destructive handler —
    // and because reading it afterwards would also re-dereference a possibly
    // null activeRepository inside a floating promise.
    const repoPath = this.activeRepository.repository.path;

    // Checked before the confirm so a destructive prompt is never shown for a
    // run the shared claim below was always going to refuse.
    if (isMaintenanceBlocked(repoPath)) {
      this.warnRepositoryBusy();
      return;
    }

    // Claimed BEFORE the confirm, not only checked. showConfirm is an IPC round
    // trip before the native dialog takes focus, and the palette entry can be
    // re-invoked through it — so a double-invoke read and dismissed the same
    // "permanently deletes unreachable objects" warning twice for one gesture.
    // runExclusive owns the release, including on a declined confirm.
    const claim = `maintenance:${repoPath}`;
    if (this.destructiveActionsInFlight.has(claim)) return;
    this.destructiveActionsInFlight.add(claim);
    try {

    // Shared with the Repository Health dialog so the two surfaces that reach
    // this command cannot drift apart on whether it is gated.
    if (!(await confirmGarbageCollection(aggressive))) return;

    // Claimed AFTER the confirm (a declined confirm must not hold the slot) and
    // shared with the Repository Health dialog, which reaches the same three
    // commands. Only the dialog tracked concurrency, so a palette run could
    // start a second gc over the dialog's — or race a prune against it on the
    // objects directory, which git does not serialise at all.
    if (!tryAcquireMaintenance(repoPath)) {
      this.warnRepositoryBusy();
      return;
    }

    try {
      // silent: the service toasts by default; this handler owns the message.
      const result = await gitService.runGc({ path: repoPath, aggressive, silent: true });
      showToast(
        result.success
          ? aggressive
            ? 'Aggressive garbage collection completed'
            : 'Garbage collection completed'
          : `Garbage collection failed: ${result.error?.message ?? 'Unknown error'}`,
        result.success ? 'success' : 'error'
      );
    } finally {
      releaseMaintenance(repoPath);
    }
    } finally {
      this.destructiveActionsInFlight.delete(claim);
    }
  }

  async handleRunFsck(): Promise<void> {
    if (!this.activeRepository) return;

    const repoPath = this.activeRepository.repository.path;

    // Read-only: fsck writes nothing, so it must not take the exclusive
    // working-tree lock — see tryAcquireMaintenanceReadOnly.
    if (!tryAcquireMaintenanceReadOnly(repoPath)) {
      this.warnRepositoryBusy();
      return;
    }

    // silent: the service toasts by default; this handler owns the message.
    const result = await gitService
      .runFsck({ path: repoPath, full: true, silent: true })
      .finally(() => releaseMaintenance(repoPath));

    // Reporting IS this command's purpose, so report what git actually said.
    // `git fsck` exits 0 while printing "dangling commit" / "unreachable blob"
    // warnings, and run_fsck packs that output into `message` — asserting a
    // clean bill of health from the exit code alone would hide it.
    showToast(
      result.success
        ? summariseFsck(result.data?.message)
        : `Repository integrity check failed: ${result.error?.message ?? 'Unknown error'}`,
      result.success ? 'success' : 'error'
    );
  }

  async handleRunPrune(): Promise<void> {
    if (!this.activeRepository) return;

    const repoPath = this.activeRepository.repository.path;

    if (isMaintenanceBlocked(repoPath)) {
      this.warnRepositoryBusy();
      return;
    }

    // Claimed before the confirm — see handleRunGc.
    const claim = `maintenance:${repoPath}`;
    if (this.destructiveActionsInFlight.has(claim)) return;
    this.destructiveActionsInFlight.add(claim);
    try {
      if (!(await confirmPrune())) return;

      if (!tryAcquireMaintenance(repoPath)) {
        this.warnRepositoryBusy();
        return;
      }

      // silent: the service toasts by default; this handler owns the message.
      const result = await gitService
        .runPrune({ path: repoPath, silent: true })
        .finally(() => releaseMaintenance(repoPath));
      showToast(
        result.success
          ? 'Pruned unreachable objects'
          : `Prune failed: ${result.error?.message ?? 'Unknown error'}`,
        result.success ? 'success' : 'error'
      );
    } finally {
      this.destructiveActionsInFlight.delete(claim);
    }
  }

  private handleCheckoutBranch(
    e: CustomEvent<{ branch: string; repositoryPath: string }>,
  ): Promise<void> {
    // The third checkout surface. Round 33 folded the ref menu's and the graph
    // label's into this lock and left the palette's out — the same stale
    // enumeration again. Two concurrent auto-stash checkouts cross-apply and
    // cross-drop each other's stash, because a stash index is a position.
    const repoPath = e.detail.repositoryPath;
    if (!repoPath || this.activeRepository?.repository.path !== repoPath) {
      return Promise.resolve();
    }
    return this.runRefExclusive(repoPath, () =>
      this.checkoutBranchFromPalette(repoPath, e.detail.branch)
    );
  }

  private async checkoutBranchFromPalette(
    repoPath: string,
    branch: string,
  ): Promise<void> {
    const result = await gitService.checkoutWithAutoStash(repoPath, branch);

    if (result.success && result.data?.success) {
      this.handleAutoStashToast(result.data, branch, repoPath);
      // Pinned: the checkout ran on repoPath, which may be backgrounded by
      // the time it completes — refresh by path, not via the active tab.
      this.refreshConflictDialogRepo(repoPath);
    } else {
      log.error('Failed to checkout branch:', result.data?.message || result.error);
      showErrorWithSuggestion(result.data?.message || result.error?.message || '', 'Failed to checkout branch');
    }
  }

  private async handleOpenFileFromPalette(
    e: CustomEvent<{ path: string; repositoryPath: string }>,
  ): Promise<void> {
    const activeRepoPath = this.activeRepository?.repository.path;
    if (!activeRepoPath || activeRepoPath !== e.detail.repositoryPath) return;
    // gitService.openInConfiguredEditor returns a CommandResult (invokeCommand
    // never throws), so we must inspect result.success — the catch-only path
    // could never fire, so a file deleted since the palette listed it, or an
    // editor that fails to launch, closed the palette and did nothing at all.
    const result = await gitService.openInConfiguredEditor(
      e.detail.repositoryPath,
      e.detail.path,
    );
    if (!result.success || !result.data?.success) {
      const message =
        result.data?.message || result.error?.message || 'Failed to open file in editor';
      log.error('Failed to open file in editor:', message);
      showToast(message, 'error');
    }
  }

  private async handleWorkspaceOpenRepoFile(e: CustomEvent<{ repoPath: string; filePath: string; lineNumber: number }>): Promise<void> {
    const { repoPath, filePath, lineNumber } = e.detail;

    // Close the workspace manager
    dialogs.close('workspaceManager');

    try {
      const currentRepoPath = this.activeRepository?.repository.path;

      if (repoPath !== currentRepoPath) {
        // Open the different repository
        const result = await gitService.openRepository({ path: repoPath });
        if (result.success && result.data) {
          repositoryStore.getState().addRepository(result.data);
        } else {
          showToast(result.error?.message ?? 'Failed to open repository', 'error');
          return;
        }
      }

      // Show blame view for the file
      this.blameFile = filePath;
      this.blameCommitOid = null;
      dialogs.open('blame');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to open repository', 'error');
    }
  }

  /**
   * Select a commit in the graph, telling the user when it isn't loaded
   * (below the paginated window or hidden by a branch filter) instead of
   * silently doing nothing. ALL reveal-in-graph flows must go through this.
   */
  revealCommitInGraph(oid: string): void {
    if (this.graphCanvas?.selectCommit(oid)) {
      return;
    }
    // Two distinct miss cases need different guidance: a commit hidden by
    // the branch-visibility filter will NEVER appear through scrolling
    if (this.graphCanvas?.hasLoadedCommit(oid)) {
      showToast('Commit is hidden by the branch visibility filter — show its branch to reveal it', 'info', 4000);
    } else {
      showToast('Commit is not loaded in the graph yet — scroll further back to load it', 'info', 4000);
    }
  }

  private handleNavigateToCommit(
    e: CustomEvent<{ oid: string; repositoryPath: string }>,
  ): void {
    if (this.activeRepository?.repository.path !== e.detail.repositoryPath) return;
    this.revealCommitInGraph(e.detail.oid);
  }

  private handleShowFileHistory(e: CustomEvent<{ filePath: string }>): void {
    // The center pane renders one view at a time — diff first, then blame,
    // then file history — while the right panel that raises this event stays
    // interactive underneath a diff. So opening history has to close whatever
    // is already up, exactly like handleShowBlame does; otherwise the click
    // does nothing the user can see and the history pane ambushes them later,
    // when closing the diff (or Escape) uncovers it. Dropping the diff
    // unmounts the inline editor with it, same teardown as the x button.
    this.warnIfDiscardingEdits();
    // Close diff if open
    dialogs.close('diff');
    this.diffFile = null;
    this.diffCommitFile = null;
    // Close blame if open
    dialogs.close('blame');
    this.blameFile = null;
    this.blameCommitOid = null;
    // Open file history
    dialogs.open('fileHistory', { filePath: e.detail.filePath });
  }

  private handleCloseFileHistory(): void {
    dialogs.close('fileHistory');
  }

  private handleFileHistoryCommitSelected(e: CustomEvent<{ commit: Commit }>): void {
    // Select the commit in the graph and navigate to it
    this.selectedCommit = e.detail.commit;
    this.revealCommitInGraph(e.detail.commit.oid);
  }

  private handleFileHistoryViewDiff(e: CustomEvent<{ commitOid: string; filePath: string }>): void {
    // Open the diff view for this file at the specific commit
    this.diffCommitFile = {
      commitOid: e.detail.commitOid,
      filePath: e.detail.filePath,
    };
    dialogs.open('diff');
  }

  private handleVimModeChange(e: CustomEvent<{ enabled: boolean }>): void {
    this.vimMode = e.detail.enabled;
    keyboardService.setVimMode(e.detail.enabled);
  }

  /**
   * The status bar's ahead/behind badge.
   *
   * Read from the ACTIVE repo's `currentBranch.aheadBehind` — the SAME field
   * the tab badge renders — not from a private `remoteStatus` field. That
   * field was written only by the tab switch, the fetch-on-focus handler and
   * auto-fetch: nothing in push/pull/fetch touched it, and handleRefresh
   * refreshes the repository, the graph and the indexes but not that. So a
   * push of three commits left the status bar reading up-3 until the next
   * auto-fetch tick, tab switch or refocus — forever with auto-fetch off —
   * which reads as "the push didn't land" and invites a second push, while
   * the tab badge an inch away already showed nothing. One source of truth is
   * the only way the two can never disagree.
   */
  private renderRemoteBadges() {
    const ab = this.activeRepository?.currentBranch?.aheadBehind;
    if (!ab) return nothing;
    return html`
      ${ab.ahead > 0
        ? html`<span
            class="status-ahead"
            title="${ab.ahead} commit${ab.ahead !== 1 ? 's' : ''} to push"
            style="margin-left: 12px; color: var(--color-success, #4caf50);"
            >&uarr;${ab.ahead}</span
          >`
        : nothing}
      ${ab.behind > 0
        ? html`<span
            class="status-behind"
            title="${ab.behind} commit${ab.behind !== 1 ? 's' : ''} to pull"
            style="margin-left: ${ab.ahead > 0 ? '4' : '12'}px; color: var(--color-warning, #ff9800);"
            >&darr;${ab.behind}</span
          >`
        : nothing}
    `;
  }

  /**
   * The drag-over affordance for a window that already has a repository open.
   *
   * lv-welcome renders its own copy (via `.dragActive`), so this one is only
   * for the other state — otherwise a drag over the welcome screen would show
   * two dashed frames. Without it the window silently accepted a drop it gave
   * no sign of accepting: `startRepositoryDropListener` is bound for the whole
   * window, and dropping a folder with a repo open really does open it in a
   * new tab.
   */
  private renderWindowDropOverlay() {
    if (!this.fileDragActive || !this.activeRepository) return nothing;
    return html`
      <div class="window-drop-overlay" role="status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <div class="window-drop-overlay-title">Drop a folder to open it</div>
        <div class="window-drop-overlay-hint">
          It opens in a new tab. Git repositories open straight away; any other folder can be
          scanned or initialized.
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <a class="skip-link" href="#main-content" @click=${(e: Event) => {
        e.preventDefault();
        const main = this.shadowRoot?.querySelector('#main-content') as HTMLElement;
        main?.focus();
      }}>Skip to main content</a>

      ${this.globalLoading ? html`<div class="global-loading-bar"></div>` : ''}

      ${this.renderWindowDropOverlay()}

      <lv-toolbar
        @open-settings=${() => { dialogs.open('settings'); }}
        @open-shortcuts=${() => { dialogs.open('shortcuts'); }}
        @open-command-palette=${() => {
            // Through openCommandPalette, like Ctrl+P. Setting the flag alone
            // skipped the loader, so the toolbar button opened a palette with
            // no branch or file entries at all on a cold start — and after a
            // tab switch, with the PREVIOUS repo's branches. Selecting one ran
            // a checkout against the active repo, stashing its whole working
            // tree for a ref it does not have, and offered "Switch to <current
            // branch>" — the no-op the palette excludes on purpose.
            void this.openCommandPalette();
          }}
        @open-profile-manager=${() => { dialogs.open('profileManager'); }}
        @open-workspace-manager=${() => { dialogs.open('workspaceManager'); }}
        @search-change=${this.handleSearchChange}
        @remote-fetch=${this.requiresRepository(() => {
            // The toolbar's Fetch/Pull/Push buttons run the SAME handlers the
            // keyboard shortcuts and the command palette do: the shared locks,
            // the progress rows, the suggestion-toast recovery and the closing
            // handleRefresh() all live there and must not be reimplemented per
            // surface.
            void this.handleFetch();
          })}
        @remote-pull=${this.requiresRepository(() => void this.handlePull())}
        @remote-push=${this.requiresRepository(() => void this.handlePush())}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-toolbar>

      ${this.activeRepository
        ? html`
            <lv-context-dashboard
              @open-profile-manager=${() => { dialogs.open('profileManager'); }}
              @open-github=${() => this.openIntegrationStandalone('github')}
              @open-gitlab=${() => this.openIntegrationStandalone('gitlab')}
              @open-bitbucket=${() => this.openIntegrationStandalone('bitbucket')}
              @open-azure-devops=${() => this.openIntegrationStandalone('azure-devops')}
              @open-oidc=${() => this.openIntegrationStandalone('oidc')}
              @refresh-account=${this.handleRefreshAccount}
              @repository-refresh=${() => this.handleRefresh()}
            ></lv-context-dashboard>

            <div class="main-content">
              <aside
                class="left-panel ${this.leftPanelVisible ? '' : 'hidden'}"
                style="width: ${this.leftPanelWidth}px"
                @tag-selected=${this.handleTagSelected}
                @branch-selected=${this.handleBranchSelected}
                @repository-changed=${() => this.handleRefresh()}
                @create-tag=${(e: CustomEvent<{ targetRef?: string }>) =>
                  this.createTagDialog?.open(e.detail?.targetRef)}
                @create-branch=${(e: CustomEvent<{ startPoint?: string }>) =>
                  this.createBranchDialog?.open(e.detail?.startPoint)}
                @interactive-rebase=${(e: CustomEvent<{ onto?: string }>) => {
                  const onto = e.detail?.onto;
                  if (onto) this.interactiveRebaseDialog?.open(onto);
                }}
                @compare-branch=${(e: CustomEvent<{ compareRef?: string }>) =>
                  this.compareBranchesDialog?.open(e.detail?.compareRef)}
                @create-pull-request=${this.handleCreatePullRequest}
                @open-provider-connection=${(e: CustomEvent<{ provider?: PullRequestProviderId }>) => {
                  const provider = e.detail?.provider;
                  if (provider) this.openIntegrationStandalone(provider);
                }}
              >
                <lv-left-panel></lv-left-panel>
              </aside>

              <div
                class="resize-handle-h ${this.resizing === 'left' ? 'dragging' : ''} ${this.leftPanelVisible ? '' : 'hidden'}"
                @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, 'left')}
              ></div>

              <main id="main-content" class="center-panel" tabindex="-1">
                ${this.activeRepository.repository.state !== 'clean' || this.hasConflictedFiles
                  ? html`
                      <div class="operation-banner ${this.activeRepository.repository.state}">
                        <span class="operation-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="12"></line>
                            <line x1="12" y1="16" x2="12.01" y2="16"></line>
                          </svg>
                        </span>
                        <span class="operation-text">
                          ${this.activeRepository.repository.state === 'cherrypick' ? 'Cherry-pick in progress' :
                            this.activeRepository.repository.state === 'merge' ? 'Merge in progress' :
                            this.activeRepository.repository.state === 'rebase' ||
                            this.activeRepository.repository.state === 'rebase-interactive' ||
                            this.activeRepository.repository.state === 'rebase-merge' ? 'Rebase in progress' :
                            this.activeRepository.repository.state === 'revert' ? 'Revert in progress' :
                            this.activeRepository.repository.state === 'bisect' ? 'Bisect in progress' :
                            this.activeRepository.repository.state === 'clean' ? 'Conflicts need resolution' :
                            `Operation in progress: ${this.activeRepository.repository.state}`}
                        </span>
                        <div class="operation-banner-actions">
                          ${this.canResolveConflicts(this.activeRepository.repository.state) ||
                          (this.activeRepository.repository.state === 'clean' && this.hasConflictedFiles)
                            ? html`
                                <button class="operation-btn operation-btn-primary" @click=${this.handleOpenConflictDialog}>
                                  Resolve Conflicts
                                </button>
                              `
                            : ''}
                          ${SKIPPABLE_STATES.includes(this.activeRepository.repository.state)
                            ? html`
                                <button
                                  class="operation-btn operation-skip-btn"
                                  ?disabled=${this.skipInProgress ||
                                  this.abortInProgress ||
                                  this.isRefOperationInFlight()}
                                  @click=${() => this.handleSkipOperation()}
                                  title="Do not apply this commit; keep what is already applied"
                                >
                                  Skip
                                </button>
                              `
                            : ''}
                          ${ABORTABLE_STATES.includes(this.activeRepository.repository.state)
                            ? html`
                                <button
                                  class="operation-abort-btn"
                                  ?disabled=${this.skipInProgress ||
                                  this.abortInProgress ||
                                  this.isRefOperationInFlight()}
                                  @click=${() => this.handleAbortOperation()}
                                >
                                  Abort
                                </button>
                              `
                            : ''}
                          ${this.activeRepository.repository.state === 'bisect'
                            ? html`
                                <button
                                  class="operation-btn operation-btn-primary"
                                  @click=${() => { dialogs.open('bisect'); }}
                                >
                                  Manage Bisect
                                </button>
                              `
                            : ''}
                        </div>
                      </div>
                    `
                  : ''}
                <div class="graph-area">
                  <lv-graph-canvas
                    repositoryPath=${this.activeRepository.repository.path}
                    .searchFilter=${this.searchFilter}
                    @commit-selected=${this.handleCommitSelected}
                    @commit-context-menu=${this.handleCommitContextMenu}
                    @ref-context-menu=${this.handleRefContextMenu}
                    @checkout-branch=${this.handleCheckoutBranchFromGraph}
                    @copy-sha=${this.handleCopySha}
                    @graph-notice=${this.handleGraphNotice}
                    @graph-commits-changed=${this.handleGraphCommitsChanged}
                  ></lv-graph-canvas>
                </div>

                ${dialogs.isOpen('diff')
                  ? html`
                      <div class="diff-area">
                        <div class="diff-header">
                          <div class="diff-header-left">
                            <span class="diff-title">${this.getDiffTitle()}</span>
                            <span class="diff-path" title="${this.getDiffPath()}">${this.getDiffPath()}</span>
                          </div>
                          <button
                            class="diff-close-btn"
                            @click=${this.handleCloseDiff}
                            title="Close diff (Esc)"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18"></line>
                              <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                          </button>
                        </div>
                        <div class="diff-content">
                          <lv-diff-view
                            .repositoryPath=${this.activeRepository.repository.path}
                            .file=${this.diffFile}
                            .commitFile=${this.diffCommitFile}
                            .hasPartialStaging=${this.diffFilePartiallyStaged}
                            @file-edited=${() => this.handleRefresh()}
                            @status-changed=${() => this.handleRefresh()}
                            @file-cleared=${this.handleCloseDiff}
                          ></lv-diff-view>
                        </div>
                      </div>
                    `
                  : dialogs.isOpen('blame') && this.blameFile
                    ? html`
                        <div class="diff-area">
                          <lv-blame-view
                            .repositoryPath=${this.activeRepository.repository.path}
                            .filePath=${this.blameFile}
                            .commitOid=${this.blameCommitOid}
                            @close=${this.handleCloseBlame}
                            @commit-click=${this.handleBlameCommitClick}
                          ></lv-blame-view>
                        </div>
                      `
                    : dialogs.isOpen('fileHistory') && this.fileHistoryPath
                      ? html`
                          <div class="diff-area">
                            <lv-file-history
                              .repositoryPath=${this.activeRepository.repository.path}
                              .filePath=${this.fileHistoryPath}
                              @close=${this.handleCloseFileHistory}
                              @commit-selected=${this.handleFileHistoryCommitSelected}
                              @view-diff=${this.handleFileHistoryViewDiff}
                              @show-blame=${this.handleShowBlame}
                            ></lv-file-history>
                          </div>
                        `
                      : ''}
                ${dialogs.isOpen('outputPanel')
                  ? html`
                      <div class="output-panel-container">
                        <lv-output-panel
                          closable
                          .repositoryPath=${this.activeRepository.repository.path}
                          @close=${() => { dialogs.close('outputPanel'); }}
                        ></lv-output-panel>
                      </div>
                    `
                  : ''}
              </main>

              ${this.rightPanelVisible ? html`
                <div
                  class="resize-handle-h ${this.resizing === 'right' ? 'dragging' : ''}"
                  @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, 'right')}
                ></div>

                <aside
                  class="right-panel"
                  style="width: ${this.rightPanelWidth}px"
                  @file-selected=${this.handleFileSelected}
                  @select-commit=${this.handleSelectCommit}
                  @commit-file-selected=${this.handleCommitFileSelected}
                  @show-blame=${this.handleShowBlame}
                  @show-file-history=${this.handleShowFileHistory}
                  @copy-sha=${this.handleCopySha}
                  @notes-changed=${this.handleNotesChanged}
                  @repository-changed=${() => this.handleRefresh()}
                >
                  <lv-right-panel
                    .commit=${this.selectedCommit}
                    .refs=${this.selectedCommitRefs}
                    @open-settings=${() => { dialogs.open('settings'); }}
                    @tab-changed=${(e: CustomEvent) => { this.activeRightPanelTab = e.detail?.tab; }}
                  ></lv-right-panel>
                </aside>
              ` : ''}
            </div>

            <footer class="status-bar">
              <span>${this.activeRepository.repository.path}</span>
              ${this.renderRemoteBadges()}
            </footer>
          `
        : html`<lv-welcome
            .dragActive=${this.fileDragActive}
            @open-workspace-manager=${() => { dialogs.open('workspaceManager'); }}
            @open-profile-manager=${() => { dialogs.open('profileManager'); }}
            @open-repository-scan=${this.handleOpenRepositoryScan}
            @manage-accounts=${this.handleManageAccounts}
          ></lv-welcome>`}

      ${dialogs.isOpen('settings')
        ? html`
            <lv-modal
              open
              modalTitle=${msg('Settings')}
              @close=${this.handleCloseSettings}
            >
              <lv-settings-dialog
                @close=${this.handleCloseSettings}
                @open-profile-manager=${() => { dialogs.open('profileManager'); }}
              ></lv-settings-dialog>
            </lv-modal>
          `
        : ''}

      ${dialogs.isOpen('conflict') && this.conflictDialogConfig
        ? html`
            <lv-conflict-resolution-dialog
              open
              repositoryPath=${this.conflictDialogConfig.repoPath}
              operationType=${this.conflictDialogConfig.operationType}
              .initialFilePath=${this.conflictDialogConfig.initialFilePath}
              .stashSourceCertain=${this.conflictDialogConfig.stashSourceCertain}
              .stashIndex=${this.conflictDialogConfig.stashIndex}
              .stashOid=${this.conflictDialogConfig.stashOid}
              .dropStashOnComplete=${this.conflictDialogConfig.dropStashOnComplete}
              .squashMerge=${this.conflictDialogConfig.squashMerge}
              .gitflowFinish=${this.conflictDialogConfig.gitflowFinish}
              @operation-completed=${this.handleConflictResolved}
              @operation-aborted=${this.handleConflictAborted}
            ></lv-conflict-resolution-dialog>
          `
        : ''}

      ${this.contextMenu.visible && this.contextMenu.commit
        ? html`
            <div
              class="context-menu"
              style="left: ${this.contextMenu.x}px; top: ${this.contextMenu.y}px;"
              @click=${(e: Event) => e.stopPropagation()}
            >
              <div class="context-menu-header">
                <span class="context-menu-oid">${this.contextMenu.commit.oid.substring(0, 7)}</span>
                <span class="context-menu-summary">${this.contextMenu.commit.summary}</span>
              </div>
              ${this.renderMultiCommitActions()}
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${() => void this.handleQuickAmend()} title="Amend (edit) this commit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                Amend
              </button>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRewordCommit} title="Change the commit message">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="17" y1="10" x2="3" y2="10"></line>
                  <line x1="21" y1="6" x2="3" y2="6"></line>
                  <line x1="21" y1="14" x2="3" y2="14"></line>
                  <line x1="17" y1="18" x2="3" y2="18"></line>
                </svg>
                Reword
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleFixupCommit} title="Create fixup commit for this commit (requires staged changes)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                Fixup into this
              </button>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleSquashCommit} title="Create squash commit for this commit (requires staged changes)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="9" y1="3" x2="9" y2="21"></line>
                  <line x1="15" y1="3" x2="15" y2="21"></line>
                </svg>
                Squash into this
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleCherryPick}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"/>
                  <path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" fill="none"/>
                </svg>
                Cherry-pick
              </button>
              <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRevertCommit}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0zM8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z"/>
                  <path d="M8 4v4l3 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                </svg>
                Revert
              </button>
              <button class="context-menu-item" @click=${this.handleCreateTagFromContext}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"></path>
                  <line x1="7" y1="7" x2="7.01" y2="7"></line>
                </svg>
                Create tag
              </button>
              <button class="context-menu-item" @click=${this.handleCreateBranchFromContext}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="6" y1="3" x2="6" y2="15"></line>
                  <circle cx="18" cy="6" r="3"></circle>
                  <circle cx="6" cy="18" r="3"></circle>
                  <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
                Create branch
              </button>
              <button class="context-menu-item" @click=${this.handleDescribeFromContext} title="Name this commit after the nearest tag (git describe)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                Describe this commit
              </button>
              <button class="context-menu-item" @click=${this.handleCreatePatchFromContext}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="12" y1="18" x2="12" y2="12"></line>
                  <line x1="9" y1="15" x2="15" y2="15"></line>
                </svg>
                Create patch…
              </button>
              <div class="context-menu-divider"></div>
              <div class="context-menu-submenu">
                <span class="context-menu-label">Reset to this commit</span>
                <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${() => this.handleResetToCommit('soft')}>
                  Soft (keep changes staged)
                </button>
                <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${() => this.handleResetToCommit('mixed')}>
                  Mixed (keep changes unstaged)
                </button>
                <button class="context-menu-item danger" ?disabled=${this.isRefOperationInFlight()} @click=${() => this.handleResetToCommit('hard')}>
                  Hard (discard all changes)
                </button>
              </div>
            </div>
          `
        : ''}

      ${this.refContextMenu.visible
        ? html`
            <div
              class="context-menu"
              style="left: ${this.refContextMenu.x}px; top: ${this.refContextMenu.y}px;"
              @click=${(e: Event) => e.stopPropagation()}
            >
              <div class="context-menu-header">
                <span class="context-menu-oid">${this.refContextMenu.refType === 'tag' ? 'Tag' : this.refContextMenu.refType === 'remoteBranch' ? 'Remote' : 'Branch'}</span>
                <span class="context-menu-summary">${this.refContextMenu.refName}</span>
              </div>
              <div class="context-menu-divider"></div>
              ${this.refContextMenu.refType === 'localBranch'
                ? html`
                    <button
                      class="context-menu-item"
                      ?disabled=${this.isRefOperationInFlight()}
                      @click=${this.handleRefCheckout}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                      Checkout
                    </button>
                    <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRefMerge}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="18" cy="18" r="3"></circle>
                        <circle cx="6" cy="6" r="3"></circle>
                        <path d="M6 21V9a9 9 0 0 0 9 9"></path>
                      </svg>
                      Merge into current branch
                    </button>
                    <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRefRebase}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="6" y1="3" x2="6" y2="15"></line>
                        <circle cx="18" cy="6" r="3"></circle>
                        <circle cx="6" cy="18" r="3"></circle>
                        <path d="M18 9a9 9 0 0 1-9 9"></path>
                      </svg>
                      Rebase current branch onto this
                    </button>
                    ${this.refContextMenu.isHead
                      ? nothing
                      : html`
                          <div class="context-menu-divider"></div>
                          <!-- Hidden on the checked-out branch: libgit2 refuses
                               to delete the current HEAD, so the item could only
                               ever produce a confirm followed by an error. The
                               sidebar branch list already hides it; the graph
                               did not. -->
                          <button
                            class="context-menu-item danger"
                            ?disabled=${this.isRefOperationInFlight()}
                            @click=${this.handleRefDeleteBranch}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                            Delete branch
                          </button>
                        `}
                  `
                : this.refContextMenu.refType === 'remoteBranch'
                  ? html`
                      <button
                        class="context-menu-item"
                        ?disabled=${this.isRefOperationInFlight()}
                        @click=${this.handleRefCheckout}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        Checkout
                      </button>
                      <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRefMerge}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="18" cy="18" r="3"></circle>
                          <circle cx="6" cy="6" r="3"></circle>
                          <path d="M6 21V9a9 9 0 0 0 9 9"></path>
                        </svg>
                        Merge into current branch
                      </button>
                      <button class="context-menu-item" ?disabled=${this.isRefOperationInFlight()} @click=${this.handleRefRebase}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="6" y1="3" x2="6" y2="15"></line>
                          <circle cx="18" cy="6" r="3"></circle>
                          <circle cx="6" cy="18" r="3"></circle>
                          <path d="M18 9a9 9 0 0 1-9 9"></path>
                        </svg>
                        Rebase current branch onto this
                      </button>
                    `
                  : html`
                      <button
                        class="context-menu-item"
                        ?disabled=${this.isRefOperationInFlight()}
                        @click=${this.handleRefCheckout}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        Checkout tag
                      </button>
                      <button
                        class="context-menu-item"
                        ?disabled=${this.isRefOperationInFlight() ||
                        this.isTagPushInFlight(this.refContextMenu.refName)}
                        @click=${this.handleRefPushTag}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="19" x2="12" y2="5"></line>
                          <polyline points="5 12 12 5 19 12"></polyline>
                        </svg>
                        Push tag to remote
                      </button>
                      <div class="context-menu-divider"></div>
                      <button
                        class="context-menu-item danger"
                        ?disabled=${this.isRefOperationInFlight()}
                        @click=${this.handleRefDeleteTag}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        Delete tag
                      </button>
                    `}
              <!-- Rendered for local branches, remote branches AND tags: an
                   archive is a read-only export of whatever tree the ref points
                   at, so offering it for only one ref type would be an
                   inconsistency the user has to discover by right-clicking. -->
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click=${this.handleExportArchiveFromContext}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="21 8 21 21 3 21 3 8"></polyline>
                  <rect x="1" y="3" width="22" height="5"></rect>
                  <line x1="10" y1="12" x2="14" y2="12"></line>
                </svg>
                Export archive…
              </button>
            </div>
          `
        : ''}

      <lv-command-palette
        ?open=${dialogs.isOpen('commandPalette')}
        .repositoryPath=${this.commandPaletteRepositoryPath ?? ''}
        .initialQuery=${this.commandPaletteQuery}
        .commands=${this.getPaletteCommands()}
        .branches=${this.paletteBranches}
        .files=${this.paletteTrackedFiles}
        .commits=${this.graphPaletteCommits}
        .tags=${this.graphPaletteTags}
        @close=${() => { this.handleCommandPaletteClose(); }}
        @checkout-branch=${this.handleCheckoutBranch}
        @open-file=${this.handleOpenFileFromPalette}
        @navigate-to-commit=${this.handleNavigateToCommit}
      ></lv-command-palette>

      ${this.activeRepository ? html`
        <lv-reflog-dialog
          ?open=${dialogs.isOpen('reflog')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('reflog'); }}
          @undo-complete=${(e: CustomEvent<{ repositoryPath?: string }>) => {
            dialogs.close('reflog');
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null);
          }}
          @show-commit=${(e: CustomEvent<{ oid: string }>) => { dialogs.close('reflog'); this.revealCommitInGraph(e.detail.oid); }}
        ></lv-reflog-dialog>

        <lv-search-dialog
          ?open=${dialogs.isOpen('search')}
          .mode=${this.searchDialogMode}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('search'); }}
          @mode-changed=${(e: CustomEvent<{ mode: SearchDialogMode }>) => { dialogs.setContext('search', { mode: e.detail.mode }); }}
          @show-blame=${this.handleShowBlame}
          @show-working-diff=${this.handleShowWorkingDiff}
        ></lv-search-dialog>
      ` : ''}

      <lv-keyboard-shortcuts-dialog
        ?open=${dialogs.isOpen('shortcuts')}
        ?vimMode=${this.vimMode}
        @close=${() => { dialogs.close('shortcuts'); }}
        @vim-mode-change=${this.handleVimModeChange}
      ></lv-keyboard-shortcuts-dialog>

      ${this.activeRepository ? html`
        <lv-remote-dialog
          ?open=${dialogs.isOpen('remotes')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('remotes'); }}
          @remotes-changed=${() => this.handleRefresh()}
        ></lv-remote-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-clean-dialog
          ?open=${dialogs.isOpen('clean')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('clean'); }}
          @files-cleaned=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-clean-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-changelog-dialog
          .repositoryPath=${this.activeRepository.repository.path}
        ></lv-changelog-dialog>
      ` : ''}

      ${this.activeRepository && dialogs.isOpen('repositoryHealth') ? html`
        <lv-modal
          modalTitle="Repository Health"
          ?open=${dialogs.isOpen('repositoryHealth')}
          @close=${this.handleRepositoryHealthClose}
        >
          <lv-repository-health-dialog
            .repositoryPath=${this.activeRepository.repository.path}
            @close=${this.handleRepositoryHealthClose}
          ></lv-repository-health-dialog>
        </lv-modal>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-bisect-dialog
          ?open=${dialogs.isOpen('bisect')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('bisect'); }}
          @bisect-step=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
          @bisect-complete=${(e: CustomEvent<{ repositoryPath?: string }>) => {
            dialogs.close('bisect');
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null);
          }}
        ></lv-bisect-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-submodule-dialog
          ?open=${dialogs.isOpen('submodules')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('submodules'); }}
          @submodules-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            // Routed to the repo the operation RAN ON. handleRefresh resolves
            // activeRepository at call time, so a Ctrl+Tab during a slow
            // operation refreshed the wrong repo — and left the right one out
            // of staleRepoPaths, so it never recovered on re-activation either.
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-submodule-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-worktree-dialog
          ?open=${dialogs.isOpen('worktrees')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('worktrees'); }}
          @worktrees-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            // Routed to the repo the operation RAN ON. handleRefresh resolves
            // activeRepository at call time, so a Ctrl+Tab during a slow
            // operation refreshed the wrong repo — and left the right one out
            // of staleRepoPaths, so it never recovered on re-activation either.
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-worktree-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-lfs-dialog
          ?open=${dialogs.isOpen('lfs')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('lfs'); }}
          @lfs-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            // Routed to the repo the operation RAN ON. handleRefresh resolves
            // activeRepository at call time, so a Ctrl+Tab during a slow
            // operation refreshed the wrong repo — and left the right one out
            // of staleRepoPaths, so it never recovered on re-activation either.
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-lfs-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-gpg-dialog
          ?open=${dialogs.isOpen('gpg')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('gpg'); }}
          @gpg-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-gpg-dialog>
      ` : ''}

      <lv-ssh-dialog
        ?open=${dialogs.isOpen('ssh')}
        @close=${() => { dialogs.close('ssh'); }}
      ></lv-ssh-dialog>

      ${this.activeRepository ? html`
        <lv-config-dialog
          ?open=${dialogs.isOpen('config')}
          .repositoryPath=${this.activeRepository.repository.path}
          @git-identity-changed=${() => this.handleRefresh()}
          @close=${() => { dialogs.close('config'); }}
        ></lv-config-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-credentials-dialog
          ?open=${dialogs.isOpen('credentials')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('credentials'); }}
        ></lv-credentials-dialog>
      ` : ''}

      <lv-github-dialog
        ?open=${dialogs.isOpen('gitHub')}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('github')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-github-dialog>

      <lv-gitlab-dialog
        ?open=${dialogs.isOpen('gitLab')}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('gitlab')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-gitlab-dialog>

      <lv-bitbucket-dialog
        ?open=${dialogs.isOpen('bitbucket')}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('bitbucket')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-bitbucket-dialog>

      <lv-azure-devops-dialog
        ?open=${dialogs.isOpen('azureDevOps')}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('azure-devops')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-azure-devops-dialog>

      <lv-oidc-dialog
        ?open=${dialogs.isOpen('oidc')}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        @close=${() => this.handleIntegrationDialogClose('oidc')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-oidc-dialog>

      <lv-profile-manager-dialog
        ?open=${dialogs.isOpen('profileManager')}
        ?demoted=${this.profileManagerDemoted}
        .repoPath=${this.activeRepository?.repository.path ?? ''}
        .initialView=${this.profileManagerView}
        @close=${this.handleProfileManagerClose}
        @open-github=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('github', e)}
        @open-gitlab=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('gitlab', e)}
        @open-bitbucket=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('bitbucket', e)}
        @open-azure-devops=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('azure-devops', e)}
        @open-oidc=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('oidc', e)}
        @migration-needed=${() => { dialogs.open('migration'); }}
        @request-restore-provider=${this.handleRestoreProvider}
      ></lv-profile-manager-dialog>

      <lv-migration-dialog
        ?open=${dialogs.isOpen('migration')}
        @close=${() => { dialogs.close('migration'); }}
        @open-profile-manager=${() => { dialogs.open('profileManager'); }}
      ></lv-migration-dialog>

      <lv-workspace-manager-dialog
        ?open=${dialogs.isOpen('workspaceManager')}
        @close=${() => { dialogs.close('workspaceManager'); }}
        @open-repo-file=${this.handleWorkspaceOpenRepoFile}
      ></lv-workspace-manager-dialog>

      <lv-scan-repositories-dialog
        ?open=${dialogs.isOpen('repositoryScan')}
        .scanPath=${this.repositoryScanPath}
        .mode=${this.repositoryScanMode}
        @close=${() => { dialogs.close('repositoryScan'); }}
        @initialize-repository=${this.handleInitializeRepositoryRequest}
      ></lv-scan-repositories-dialog>

      ${this.activeRepository
        // The welcome screen mounts its own init dialog, so this one exists
        // only while a repository is open — never two at once.
        ? html`<lv-init-dialog></lv-init-dialog>`
        : ''}

      ${this.activeRepository ? html`
        <lv-hooks-dialog
          ?open=${dialogs.isOpen('hooks')}
          .repoPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('hooks'); }}
        ></lv-hooks-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-gitignore-dialog
          ?open=${dialogs.isOpen('gitignore')}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { dialogs.close('gitignore'); }}
          @ignore-rules-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            // Writing .gitignore/.gitattributes changes the working tree, so the
            // file list must be reloaded. Routed to the repo the write RAN ON:
            // handleRefresh resolves activeRepository at call time, so a Ctrl+Tab
            // during the write would otherwise refresh the wrong repository.
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-gitignore-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-create-tag-dialog
          .repositoryPath=${this.activeRepository.repository.path}
          @tag-created=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-create-tag-dialog>
        <lv-create-branch-dialog
          .repositoryPath=${this.activeRepository.repository.path}
          @branch-created=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-create-branch-dialog>
        <lv-describe-dialog
          .repositoryPath=${this.activeRepository.repository.path}
          @describe-create-tag=${(e: CustomEvent<{ target?: string; repositoryPath?: string }>) =>
            this.createTagDialog?.open(e.detail?.target || undefined, e.detail?.repositoryPath || undefined)}
        ></lv-describe-dialog>
        <lv-compare-branches-dialog
          .repositoryPath=${this.activeRepository.repository.path}
        ></lv-compare-branches-dialog>
        <lv-export-import-dialog
          .repositoryPath=${this.activeRepository.repository.path}
          .graphRepositoryPath=${this.graphPaletteRepositoryPath}
          .branches=${this.activeRepository?.branches ?? []}
          .tags=${this.graphPaletteTags}
          .commits=${this.graphPaletteCommits}
          @patch-applied=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
          @bundle-imported=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-export-import-dialog>
        <lv-cherry-pick-dialog
          .repositoryPath=${this.activeRepository.repository.path}
          .currentBranch=${this.activeRepository.currentBranch?.shorthand ?? 'HEAD'}
          @cherry-pick-complete=${this.handleCherryPickComplete}
          @cherry-pick-conflict=${this.handleCherryPickConflict}
        ></lv-cherry-pick-dialog>
        <lv-interactive-rebase-dialog
          id="app-rebase-dialog"
          .repositoryPath=${this.activeRepository.repository.path}
        ></lv-interactive-rebase-dialog>
      ` : ''}

      <lv-toast-container></lv-toast-container>
      <lv-progress-indicator
        .operations=${this.progressOperations}
        @cancel-operation=${this.handleCancelOperation}
      ></lv-progress-indicator>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-app-shell': AppShell;
  }
}
