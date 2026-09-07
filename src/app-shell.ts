import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { sharedStyles } from './styles/shared-styles.ts';
import { repositoryStore, uiStore, type OpenRepository } from './stores/index.ts';
import { registerDefaultShortcuts, keyboardService } from './services/keyboard.service.ts';
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
import * as gitService from './services/git.service.ts';
import * as updateService from './services/update.service.ts';
import * as unifiedProfileService from './services/unified-profile.service.ts';
import { settingsStore } from './stores/settings.store.ts';
import { workspaceStore } from './stores/workspace.store.ts';
import * as workspaceService from './services/workspace.service.ts';
import { listenToEvent } from './services/tauri-api.ts';
import { showToast, notifyWarning } from './services/notification.service.ts';
import { showErrorWithSuggestion } from './services/error-suggestion.service.ts';
import {
  openRepositoryInTerminal,
  openRepositoryInFileManager,
  openRepositoryInEditor,
} from './services/open-location.service.ts';
import { showConfirm, showPrompt } from './services/dialog.service.ts';
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

/**
 * Main application shell component
 * Provides the top-level layout and routing
 */
@customElement('lv-app-shell')
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

  @state() private activeRepository: OpenRepository | null = null;
  @state() private selectedCommit: Commit | null = null;
  @state() private selectedCommitRefs: RefInfo[] = [];

  // Diff view state
  @state() private showDiff = false;
  @state() private diffFile: StatusEntry | null = null;
  @state() private diffCommitFile: { commitOid: string; filePath: string } | null = null;
  @state() private diffFilePartiallyStaged = false;

  // Blame view state
  @state() private showBlame = false;
  @state() private blameFile: string | null = null;
  @state() private blameCommitOid: string | null = null;

  // Progress operations
  @state() private progressOperations: ProgressOperation[] = [];
  private progressUnsubscribe?: () => void;

  // Settings dialog
  @state() private showSettings = false;
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

  // Conflict resolution dialog
  @state() private showConflictDialog = false;
  /**
   * The open dialog's inputs, SNAPSHOTTED at open time. The dialog must
   * keep operating on the repository and operation it was opened for even
   * if the user switches repo tabs (Ctrl+Tab still works behind the
   * full-screen dialog) or another conflicting operation fires while it is
   * up — live-binding the loose fields below would let a second conflict
   * source retarget an in-flight resolution's repo/operation, aiming its
   * abort/resolve/stage commands at the wrong repository.
   */
  @state() private conflictDialogConfig: {
    repoPath: string;
    operationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash';
    initialFilePath: string | null;
    stashSourceCertain: boolean;
    stashIndex: number;
    stashOid: string | null;
    dropStashOnComplete: boolean;
    squashMerge: boolean;
    gitflowFinish: GitflowFinishContext | null;
  } | null = null;
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
  @state() private showCommandPalette = false;
  @state() private showOutputPanel = false;
  @state() private paletteBranches: Branch[] = [];
  @state() private paletteTrackedFiles: string[] = [];
  private commandPaletteRepositoryPath: string | null = null;
  private commandPaletteRequestId = 0;

  // File history
  @state() private showFileHistory = false;
  @state() private fileHistoryPath: string | null = null;

  // Reflog dialog
  @state() private showReflog = false;

  // Content/diff/pickaxe search dialog. The `show[A-Z]` name is load-bearing:
  // closeRepoScopedDialogs() enumerates Lit's reactive properties for it.
  @state() private showSearchDialog = false;
  @state() private searchDialogMode: SearchDialogMode = 'files';

  // Keyboard shortcuts dialog
  @state() private showShortcuts = false;
  @state() private vimMode = false;

  // Remote management dialog
  @state() private showRemotes = false;

  // Clean dialog
  @state() private showClean = false;

  // Repository health dialog
  @state() private showRepositoryHealth = false;

  // Bisect dialog
  @state() private showBisect = false;

  // Submodule dialog
  @state() private showSubmodules = false;

  // Worktree dialog
  @state() private showWorktrees = false;

  // LFS dialog
  @state() private showLfs = false;

  // Changelog dialog

  // GPG dialog
  @state() private showGpg = false;

  // SSH dialog
  @state() private showSsh = false;

  // Config dialog
  @state() private showConfig = false;

  // Credentials dialog
  @state() private showCredentials = false;

  // GitHub dialog
  @state() private showGitHub = false;

  // GitLab dialog
  @state() private showGitLab = false;

  // Bitbucket dialog
  @state() private showBitbucket = false;

  // Azure DevOps dialog
  @state() private showAzureDevOps = false;

  // OIDC / Enterprise SSO dialog
  @state() private showOidc = false;

  // Profile Manager dialog
  @state() private showProfileManager = false;
  // Which view the Profile Manager should open to. 'accounts' is set when the
  // user picks "Manage Accounts" from an integration dialog; reset on close.
  @state() private profileManagerView: '' | 'accounts' = '';

  // EXPLICIT navigation context for a provider/OIDC dialog opened FROM the
  // profile manager's "Connect a new account" flow. Non-null ONLY while such a
  // dialog is open: it drives the Back arrow, the "Adding to <name>" breadcrumb,
  // and the deterministic return + attach-after-connect. Cleared on every
  // standalone open (command palette/dashboard/toolbar) so those never show a
  // back arrow or auto-attach. Replaces the old `showProfileManager` inference.
  @state() private integrationContext: IntegrationOpenContext | null = null;
  // When "Manage Accounts" is opened from a provider dialog, remember which
  // provider so closing the Accounts view can return there — making that
  // navigation reversible rather than a one-way teleport.
  private manageAccountsReturnProvider: IntegrationType | null = null;

  // Migration dialog
  @state() private showMigrationDialog = false;

  // Workspace Manager dialog
  @state() private showWorkspaceManager = false;
  @state() private showHooksDialog = false;
  @state() private showGitignoreDialog = false;

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

  @query('lv-graph-canvas') private graphCanvas?: LvGraphCanvas;
  @query('lv-diff-view') private diffView?: LvDiffView;
  @query('lv-create-tag-dialog') private createTagDialog?: LvCreateTagDialog;
  @query('lv-create-branch-dialog') private createBranchDialog?: LvCreateBranchDialog;
  @query('lv-cherry-pick-dialog') private cherryPickDialog?: LvCherryPickDialog;
  @query('lv-export-import-dialog') private exportImportDialog?: LvExportImportDialog;
  @query('#app-rebase-dialog') private interactiveRebaseDialog?: LvInteractiveRebaseDialog;
  @query('lv-profile-manager-dialog') private profileManagerDialog?: LvProfileManagerDialog;
  @query('lv-reflog-dialog') private reflogDialog?: LvReflogDialog;
  @query('lv-describe-dialog') private describeDialog?: LvDescribeDialog;
  @query('lv-compare-branches-dialog') private compareBranchesDialog?: LvCompareBranchesDialog;
  @query('lv-clean-dialog') private cleanDialog?: LvCleanDialog;
  @query('lv-remote-dialog') private remoteDialog?: LvRemoteDialog;
  @query('lv-repository-health-dialog') private repositoryHealthDialog?: LvRepositoryHealthDialog;
  @query('lv-changelog-dialog') private changelogDialog?: LvChangelogDialog;

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
  private warnRepositoryBusy(): void {
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
  private claimRefOperation(repoPath: string): boolean {
    return tryAcquireRefOp(repoPath);
  }

  private releaseRefOperation(repoPath: string): void {
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
  private async openBranchCleanup(): Promise<void> {
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
    if (this.showConflictDialog) {
      showToast(
        'A conflict resolution is already in progress — finish or close it first',
        'warning',
      );
      return;
    }
    this.conflictDialogConfig = {
      repoPath,
      operationType: this.conflictOperationType,
      initialFilePath: this.conflictInitialFilePath,
      stashSourceCertain: this.conflictStashSourceCertain,
      stashIndex: this.conflictStashIndex,
      stashOid: this.conflictStashOid,
      dropStashOnComplete: this.conflictDropStashOnComplete,
      squashMerge: this.conflictSquashMerge,
      gitflowFinish: this.conflictGitflowFinish,
    };
    this.showConflictDialog = true;
  }

  /**
   * Dialog flags that are NOT tied to an open repository.
   *
   * The criterion is where the dialog RENDERS. The sweep exists because a
   * dialog inside the `${this.activeRepository ? ...}` block has its ELEMENT
   * destroyed while its flag stays true, so it springs back open over the next
   * repository. A dialog rendered outside that block is never destroyed and has
   * no such problem: clearing its flag just kills a session the user started,
   * and skips the `@close` binding that unwinds its navigation state
   * (`integrationContext`, `manageAccountsReturnProvider`).
   *
   * Every flag below is reachable with zero repositories open — the welcome
   * screen offers the profile manager, and the palette's SSH, profiles and
   * provider entries are deliberately not wrapped in `requiresRepository`.
   */
  private static readonly REPO_INDEPENDENT_DIALOGS = new Set([
    'showSettings',
    'showShortcuts',
    'showOutputPanel',
    'showCommandPalette',
    'showWorkspaceManager',
    'showSsh',
    'showProfileManager',
    // Fires from checkUnifiedProfilesMigration on startup, before any repo.
    'showMigrationDialog',
    // Account connection is repo-independent; only the PR/issue/pipeline tabs
    // inside these dialogs guard themselves on a repository.
    'showGitHub',
    'showGitLab',
    'showBitbucket',
    'showAzureDevOps',
    'showOidc',
  ]);

  /**
   * Clear every repo-scoped `show*` flag. See the call site for why this is an
   * exclusion list: an inclusion list has gone stale here more than once.
   */
  private closeRepoScopedDialogs(): void {
    // Enumerated from Lit's own reactive-property map, NOT Object.keys: an
    // @state() field is an accessor on the prototype backed by a private slot,
    // so it never appears as an own enumerable key.
    const self = this as unknown as Record<string, unknown>;
    const declared = (this.constructor as unknown as {
      elementProperties: Map<PropertyKey, unknown>;
    }).elementProperties;
    for (const key of declared.keys()) {
      if (typeof key !== 'string') continue;
      if (!/^show[A-Z]/.test(key)) continue;
      if (AppShell.REPO_INDEPENDENT_DIALOGS.has(key)) continue;
      if (self[key] === true) self[key] = false;
    }
  }

  private closeConflictDialog(): void {
    this.showConflictDialog = false;
    this.conflictDialogConfig = null;
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

    this.unsubscribe = repositoryStore.subscribe((state) => {
      const newActiveRepo = state.getActiveRepository();
      const repoChanged = this.activeRepository?.repository.path !== newActiveRepo?.repository.path;
      this.activeRepository = newActiveRepo;

      // Every repo-scoped dialog flag must die with the last repository.
      //
      // These dialogs render inside the `${this.activeRepository ? ...}` block,
      // so closing the last tab destroys the ELEMENT while its `show*` flag
      // stays true. Open the next repository and the element is reconstructed
      // with ?open=true — a full-screen overlay springing up unbidden over a
      // repo the user just opened, freshly constructed with every button
      // re-enabled. lv-repository-health-dialog carries that exact story, and
      // lv-bisect-dialog then reproduced it because it has no pinned path and
      // so was in neither hand-written sweep.
      //
      // Written as an EXCLUSION list, not an inclusion one. A list of dialogs
      // to close goes stale every time one is added — which is how this keeps
      // recurring — whereas the handful that are genuinely not repo-scoped is
      // stable, and a new dialog defaults to the safe behaviour.
      if (state.openRepositories.length === 0) {
        this.closeRepoScopedDialogs();
      }

      // Closing the pinned repo's TAB while its conflict dialog is up
      // would leave the dialog floating over whatever renders next, with
      // dead completion plumbing (the open-time guard only covers closes
      // during the triggering operation's await). Close it with an
      // explanation — the operation itself persists on disk and resurfaces
      // when the repo is reopened.
      if (
        this.showConflictDialog &&
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
            clearFlag: () => { this.showClean = false; },
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
            clearFlag: () => { this.showReflog = false; },
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
            clearFlag: () => { this.showSearchDialog = false; },
          },
          'lv-remote-dialog': {
            dismissed: 'remote management closed',
            running: 'remote update',
            clearFlag: () => { this.showRemotes = false; },
          },
          // Closing this one DESTROYS the element (its render block is gated on
          // showRepositoryHealth), so it implements closeWhenIdle() and the
          // sweep hands the close over rather than orphaning a running gc.
          'lv-repository-health-dialog': {
            dismissed: 'repository health closed',
            running: 'maintenance operation',
            clearFlag: () => { this.showRepositoryHealth = false; },
          },
          'lv-worktree-dialog': {
            dismissed: 'worktrees closed',
            running: 'worktree removal',
            clearFlag: () => { this.showWorktrees = false; },
          },
          'lv-submodule-dialog': {
            dismissed: 'submodules closed',
            running: 'submodule removal',
            clearFlag: () => { this.showSubmodules = false; },
          },
          'lv-lfs-dialog': {
            dismissed: 'Git LFS closed',
            running: 'LFS prune',
            clearFlag: () => { this.showLfs = false; },
          },
          'lv-gpg-dialog': {
            dismissed: 'signing settings closed',
            running: 'signing update',
            clearFlag: () => { this.showGpg = false; },
          },
          'lv-config-dialog': {
            dismissed: 'configuration closed',
            running: 'configuration save',
            clearFlag: () => { this.showConfig = false; },
          },
          'lv-credentials-dialog': {
            dismissed: 'credentials closed',
            running: 'credential test',
            clearFlag: () => { this.showCredentials = false; },
          },
          'lv-hooks-dialog': {
            dismissed: 'hooks closed',
            running: 'hook save',
            clearFlag: () => { this.showHooksDialog = false; },
          },
          'lv-gitignore-dialog': {
            dismissed: 'ignore rules closed',
            running: 'ignore rule update',
            clearFlag: () => { this.showGitignoreDialog = false; },
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
          this.showDiff = false;
        }
      }

      // Start/stop per-repo services as tabs open and close. Every OPEN repo
      // gets a watcher (not just the active one) so background repos don't go
      // silently stale; closed repos release their watcher and search index.
      const openPaths = new Set(state.openRepositories.map((r) => r.repository.path));
      for (const path of openPaths) {
        if (!this.watchedRepoPaths.has(path)) {
          watcherService.startWatching(path).catch((err) => {
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
        this.showCommandPalette = false;
        this.commandPaletteRepositoryPath = null;
        this.paletteBranches = [];
        this.paletteTrackedFiles = [];
        // Clear selected commit and refs
        this.selectedCommit = null;
        this.selectedCommitRefs = [];

        // Same gesture-owned teardown as handleCloseDiff: the tab switch
        // unmounts the editor along with the pane.
        this.warnIfDiscardingEdits();

        // Close any open overlays
        this.showDiff = false;
        this.diffFile = null;
        this.diffCommitFile = null;
        this.showBlame = false;
        this.blameFile = null;
        this.blameCommitOid = null;
        this.showFileHistory = false;
        this.fileHistoryPath = null;

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
    window.addEventListener('trigger-pull', this.handleTriggerPull);
    window.addEventListener('force-delete-branch', this.handleForceDeleteBranch as EventListener);
    window.addEventListener('open-settings', this.handleOpenSettings);
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

    // Load vim mode from keyboard service
    this.vimMode = keyboardService.isVimMode();

    // Set up remote operation event listeners (for auto-fetch notifications)
    gitService.setupRemoteOperationListeners();

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
      openSettings: () => { this.showSettings = true; },
      openShortcuts: () => { this.showShortcuts = true; },
      toggleLeftPanel: () => this.toggleLeftPanel(),
      toggleRightPanel: () => uiStore.getState().togglePanel('right'),
      openCommandPalette: () => this.openCommandPalette(),
      openReflog: this.requiresRepository(() => { this.showReflog = true; }),
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

    // Subscribe to progress updates
    this.progressUnsubscribe = progressService.subscribe((operations) => {
      this.progressOperations = operations;
    });
  }

  // SAFETY: All event listeners registered in connectedCallback are properly removed here.
  // Verified: every addEventListener has a corresponding removeEventListener below.
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
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
    document.removeEventListener('mousemove', this.boundHandleMouseMove);
    document.removeEventListener('mouseup', this.boundHandleMouseUp);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('repository-refresh', this.handleWindowRefresh);
    window.removeEventListener('trigger-pull', this.handleTriggerPull);
    window.removeEventListener('force-delete-branch', this.handleForceDeleteBranch as EventListener);
    window.removeEventListener('open-settings', this.handleOpenSettings);
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
          this.showMigrationDialog = true;
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
  private toggleLeftPanel(): void {
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
    this.showRepositoryHealth = false;
  };

  private handleCloseOverlay(): void {
    // Close any open overlay in priority order
    if (this.hasModalDialogOpen()) {
      // A modal owns this Escape and dismisses itself, through lv-modal's
      // handler or its own — each now gated on being the TOPMOST overlay.
      //
      // This arm is FIRST. The showShortcuts and showCommandPalette arms used
      // to precede it and closed unconditionally, without consulting the
      // stack: opening the undo-history dialog over the shortcuts dialog and
      // pressing Escape once closed BOTH. Both dialogs clear their own flag
      // through their `close` event, so letting the topmost one dismiss itself
      // is all that is needed.
      // Stop here so one keypress cannot also close the diff behind it, and
      // so a dialog that deliberately blocks dismissal mid-operation does not
      // leak the key either.
      //
      // This subsumes the old showReflog arm, which assumed reflog was always
      // topmost: a dialog opened over it (via the palette) made Escape discard
      // the reflog session underneath. The dialog's own handler applies the
      // isResetting guard and its `close` event clears showReflog.
      return;
    } else if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    } else if (this.refContextMenu.visible) {
      this.refContextMenu = { ...this.refContextMenu, visible: false };
    } else if (this.showDiff) {
      this.handleCloseDiff();
    } else if (this.showBlame) {
      this.handleCloseBlame();
    } else if (this.showFileHistory) {
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
    if (!await showConfirm(
      'Merge Branch',
      `Merge "${refName}" into the current branch?`,
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
    // Show conflict resolution dialog
    this.conflictOperationType = 'cherry-pick';
    this.resetConflictDetailState();
    this.openConflictDialogPinned(detail?.repositoryPath);
    notifyWarning(
      'Cherry-pick Conflict',
      'Conflicts detected during cherry-pick. Please resolve conflicts to continue.',
      !settingsStore.getState().showNativeNotifications
    );
    this.refreshConflictDialogRepo(detail?.repositoryPath ?? null);
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
    this.showSettings = true;
  };

  // True while any integration dialog is open.
  private get integrationDialogOpen(): boolean {
    return this.showGitHub || this.showGitLab || this.showBitbucket || this.showAzureDevOps || this.showOidc;
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
  private openIntegrationStandalone(type: IntegrationType): void {
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

  private setIntegrationDialogOpen(type: IntegrationType, open: boolean): void {
    switch (type) {
      case 'github': this.showGitHub = open; break;
      case 'gitlab': this.showGitLab = open; break;
      case 'bitbucket': this.showBitbucket = open; break;
      case 'azure-devops': this.showAzureDevOps = open; break;
      case 'oidc': this.showOidc = open; break;
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
   * suggestion said to delete the remote tag first, which Gitnado cannot do.
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
  private refreshConflictDialogRepo(pinnedPath: string | null): void {
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

    const delta = e.clientX - this.resizeStartPos;
    if (this.resizing === 'left') {
      const newWidth = Math.max(150, Math.min(400, this.resizeStartValue + delta));
      this.leftPanelWidth = newWidth;
    } else {
      const newWidth = Math.max(280, Math.min(600, this.resizeStartValue - delta));
      this.rightPanelWidth = newWidth;
    }
  }

  private handleResizeEnd(): void {
    this.resizing = null;
    this.classList.remove('resizing', 'resizing-h');
    document.removeEventListener('mousemove', this.boundHandleMouseMove);
    document.removeEventListener('mouseup', this.boundHandleMouseUp);
  }

  private handleCommitSelected(e: CustomEvent<CommitSelectedEvent>): void {
    this.selectedCommit = e.detail.commit;
    this.selectedCommitRefs = e.detail.refs;
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
    this.showBlame = false;
    this.blameFile = null;
    this.blameCommitOid = null;
    // Close file history if open. It sits last in the center pane's
    // priority order, so leaving it set hides it under the new diff and then
    // uncovers it — history for a file the user moved on from — the moment
    // the diff is closed. Unlike the diff a file-history pane opens
    // (`handleFileHistoryViewDiff`), this selection comes from the right
    // panel, not from history, so there is no drill-down to return to.
    this.showFileHistory = false;
    this.fileHistoryPath = null;
    // Working directory file selected - show diff
    this.diffFile = file;
    this.diffFilePartiallyStaged = isPartiallyStaged;
    this.diffCommitFile = null;
    this.showDiff = true;
  }

  private handleCommitFileSelected(e: CustomEvent<{ commitOid: string; filePath: string }>): void {
    // Close blame if open
    this.showBlame = false;
    this.blameFile = null;
    this.blameCommitOid = null;
    // Close file history if open — same reason as handleFileSelected: it
    // would otherwise reappear under the user when this diff is closed.
    this.showFileHistory = false;
    this.fileHistoryPath = null;
    // Commit file selected - show diff
    this.diffCommitFile = {
      commitOid: e.detail.commitOid,
      filePath: e.detail.filePath,
    };
    this.diffFile = null;
    this.showDiff = true;
  }

  /**
   * Closing the diff pane unmounts the inline editor with it.
   *
   * The editor guards every teardown it can see — Cancel confirms, a file
   * change warns — but the × button, Escape and a repository tab switch are all
   * owned by app-shell and simply set `showDiff = false`, dropping typed text
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
    this.showDiff = false;
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

  private handleStageAll(): void {
    void this.dispatchToFileStatus('stage-all');
  }

  private handleUnstageAll(): void {
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

  private async handleRefresh(): Promise<void> {
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
    this.showGitHub = false;
    this.showGitLab = false;
    this.showBitbucket = false;
    this.showAzureDevOps = false;
    this.showOidc = false;
    // If we're pivoting from a provider dialog that was stacked on top of the manager,
    // preserve the integrationContext so we can restore the stacked state later.
    if (!this.showProfileManager) {
      this.integrationContext = null;
    }
    this.manageAccountsReturnProvider = from;
    this.profileManagerView = 'accounts';
    // If the manager is ALREADY open (the provider dialog was launched FROM it,
    // so it's open & demoted), the `open` property won't transition false→true and
    // the manager's willUpdate/open-transition logic that applies `initialView`
    // never runs — it would reveal on its prior view (select-account/edit). Drive
    // the Accounts view explicitly instead so the click isn't a no-op.
    if (this.showProfileManager) {
      this.profileManagerDialog?.showAccountsView(true);
    } else {
      this.showProfileManager = true;
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
    this.showProfileManager = false;
    this.profileManagerView = '';
    this.manageAccountsReturnProvider = null;
    if (returnProvider && closedFromAccounts) {
      this.openIntegrationStandalone(returnProvider);
    }
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

  private handleToggleSearch(): void {
    const toolbar = this.shadowRoot?.querySelector('lv-toolbar');
    if (toolbar) {
      (toolbar as HTMLElement).dispatchEvent(new CustomEvent('focus-search'));
    }
  }

  private handleCloseSettings(): void {
    this.showSettings = false;
  }

  private handleBlameCommitClick(e: CustomEvent<{ oid: string }>): void {
    this.showBlame = false;
    this.revealCommitInGraph(e.detail.oid);
  }

  private handleCloseBlame(): void {
    this.showBlame = false;
    this.blameFile = null;
    this.blameCommitOid = null;
  }

  private handleShowBlame(e: CustomEvent<{ filePath: string; commitOid?: string }>): void {
    // A fourth app-shell-owned gesture that unmounts the diff pane, and so the
    // inline editor with it — same teardown as the × and a tab switch.
    this.warnIfDiscardingEdits();
    // Close diff if open
    this.showDiff = false;
    this.diffFile = null;
    this.diffCommitFile = null;
    // Open blame
    this.blameFile = e.detail.filePath;
    this.blameCommitOid = e.detail.commitOid ?? null;
    this.showBlame = true;
  }

  private openSearchDialog(mode: SearchDialogMode): void {
    this.searchDialogMode = mode;
    this.showSearchDialog = true;
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

  private async openCommandPalette(): Promise<void> {
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
    this.showCommandPalette = true;
  }

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
    this.showCommandPalette = false;
  }

  private requiresRepository(action: () => void): () => void {
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

  private getPaletteCommands(): PaletteCommand[] {
    const isMac = navigator.platform.includes('Mac');
    const mod = isMac ? '⌘' : 'Ctrl';

    const commands: PaletteCommand[] = [
      {
        id: 'fetch',
        label: 'Fetch from remote',
        category: 'action',
        icon: 'fetch',
        action: this.requiresRepository(() => this.handleFetch()),
      },
      {
        id: 'pull',
        label: 'Pull from remote',
        category: 'action',
        icon: 'pull',
        action: this.requiresRepository(() => this.handlePull()),
      },
      {
        id: 'push',
        label: 'Push to remote',
        category: 'action',
        icon: 'push',
        action: this.requiresRepository(() => this.handlePush()),
      },
      {
        id: 'refresh',
        label: 'Refresh repository',
        category: 'action',
        icon: 'refresh',
        shortcut: `${mod}R`,
        action: () => this.handleRefresh(),
      },
      {
        id: 'graph-jump-head',
        label: 'Graph: Jump to HEAD',
        category: 'navigation',
        icon: 'commit',
        action: this.requiresRepository(() => {
          if (this.graphCanvas?.jumpToHead()) {
            return;
          }
          // Route the miss through the shared reveal helper so the toast
          // distinguishes loaded-but-filtered from not-loaded
          const headOid = this.graphCanvas?.getHeadOid();
          if (headOid !== undefined) {
            this.revealCommitInGraph(headOid);
          } else {
            showToast('HEAD commit is not loaded in the graph', 'info', 4000);
          }
        }),
      },
      {
        id: 'toggle-output-panel',
        label: 'Toggle Output Panel',
        category: 'action',
        icon: 'terminal',
        action: () => { this.showOutputPanel = !this.showOutputPanel; },
      },
      {
        id: 'stash',
        label: 'Create stash',
        category: 'action',
        icon: 'stash',
        action: this.requiresRepository(() => this.handleCreateStash()),
      },
      {
        id: 'create-branch',
        label: 'Create branch',
        category: 'action',
        icon: 'branch',
        shortcut: `${mod}⇧N`,
        action: this.requiresRepository(() => this.createBranchDialog?.open()),
      },
      {
        id: 'create-tag',
        label: 'Create tag',
        category: 'action',
        icon: 'tag',
        action: this.requiresRepository(() => this.createTagDialog?.open()),
      },
      {
        id: 'export-archive',
        label: 'Export archive…',
        category: 'action',
        icon: 'file',
        action: this.requiresRepository(() => this.exportImportDialog?.open({ tab: 'archive' })),
      },
      {
        id: 'create-patch',
        label: 'Create patch from commits…',
        category: 'action',
        icon: 'commit',
        action: this.requiresRepository(() =>
          this.exportImportDialog?.open({
            tab: 'patch',
            patchMode: 'create',
            commitOid: this.selectedCommit?.oid,
          }),
        ),
      },
      {
        id: 'apply-patch',
        label: 'Apply patch file…',
        category: 'action',
        icon: 'commit',
        action: this.requiresRepository(() =>
          this.exportImportDialog?.open({ tab: 'patch', patchMode: 'apply' }),
        ),
      },
      {
        id: 'create-bundle',
        label: 'Create bundle…',
        category: 'action',
        icon: 'file',
        action: this.requiresRepository(() =>
          this.exportImportDialog?.open({ tab: 'bundle', bundleMode: 'create' }),
        ),
      },
      {
        id: 'import-bundle',
        label: 'Import bundle…',
        category: 'action',
        icon: 'file',
        action: this.requiresRepository(() =>
          this.exportImportDialog?.open({ tab: 'bundle', bundleMode: 'import' }),
        ),
      },
      {
        id: 'settings',
        label: 'Open settings',
        category: 'action',
        icon: 'settings',
        shortcut: `${mod},`,
        action: () => { this.showSettings = true; },
      },
      {
        id: 'remotes',
        label: 'Manage remotes',
        category: 'action',
        icon: 'globe',
        action: this.requiresRepository(() => { this.showRemotes = true; }),
      },
      {
        id: 'changelog',
        label: 'Generate Changelog',
        category: 'action',
        icon: 'tag',
        action: this.requiresRepository(() => {
          const dialog = this.shadowRoot?.querySelector('lv-changelog-dialog');
          if (dialog) (dialog as import('./components/dialogs/lv-changelog-dialog.ts').LvChangelogDialog).open();
        }),
      },
      {
        id: 'smart-undo',
        label: 'Smart Undo (AI)',
        category: 'action',
        icon: 'undo',
        action: this.requiresRepository(async () => {
          // Captured BEFORE the prompt/AI/confirm awaits (all yield): the
          // reflog reset must run on the repo it was invoked on, even if the
          // user switches tabs while any of those dialogs/calls are pending.
          const repoPath = this.activeRepository!.repository.path;
          const query = await showPrompt('Smart Undo (AI)', 'Describe what you want to undo (e.g., "before the rebase", "undo last 3 commits"):');
          if (!query) return;

          const result = await import('./services/ai.service.ts').then(m =>
            m.findReflogEntry(repoPath, query)
          );

          if (result.success && result.data) {
            const match = result.data;

            // Resolve the index to a commit BEFORE the confirm. An AI round
            // trip plus a prompt plus a confirm all elapse between the reflog
            // being read and the reset firing, and any commit or checkout in
            // that window renumbers every entry. Pinning the oid means the
            // reset either lands on the commit named here or is refused.
            const git = await import('./services/git.service.ts');
            const reflog = await git.getReflog(repoPath);
            const target = reflog.success ? reflog.data?.[match.index] : undefined;

            if (!target) {
              showToast('Could not resolve that reflog entry — try again', 'error');
              return;
            }

            const confirmed = await showConfirm(
              'Smart Undo',
              `${match.description}\n\nReset to ${target.shortId} (HEAD@{${match.index}})?\n\n` +
                `This branch will point at ${target.shortId}. Any commit no longer ` +
                `reachable from it is recoverable only through the reflog. Your ` +
                `changes remain staged.`,
              'warning'
            );
            if (confirmed) {
              // The other caller of reset_to_reflog — lv-reflog-dialog — claims
              // the shared working-tree lock; this palette route to the same
              // command was missed by that sweep. The expected_oid pin guards
              // against a STALE index, not against a checkout moving the branch
              // underneath the reset.
              // runRefExclusive returns silently when the lock is held, which
              // suits context-menu items whose buttons carry a ?disabled
              // binding. This one sits behind a prompt, an AI call and a
              // confirm, so a silent return reads as "the reset happened".
              if (!this.claimRefOperation(repoPath)) {
                this.warnRepositoryBusy();
                return;
              }
              try {
                const resetResult = await git.resetToReflog(
                  repoPath,
                  match.index,
                  'soft',
                  target.oid
                );
                if (resetResult.success) {
                  showToast('Undo successful', 'success');
                  this.refreshConflictDialogRepo(repoPath);
                } else {
                  showToast(resetResult.error?.message ?? 'Undo failed', 'error');
                }
              } finally {
                this.releaseRefOperation(repoPath);
              }
            }
          } else {
            showToast(result.error?.message ?? 'Could not find matching reflog entry', 'error');
          }
        }),
      },
      {
        id: 'clean',
        label: 'Clean working directory',
        category: 'action',
        icon: 'trash',
        action: this.requiresRepository(() => { this.showClean = true; }),
      },
      {
        id: 'branch-cleanup',
        label: 'Clean up branches',
        category: 'action',
        icon: 'git-branch',
        action: this.requiresRepository(() => { void this.openBranchCleanup(); }),
      },
      {
        id: 'bisect',
        label: 'Start bisect (find bug)',
        category: 'action',
        icon: 'search',
        action: this.requiresRepository(() => { this.showBisect = true; }),
      },
      {
        id: 'submodules',
        label: 'Manage submodules',
        category: 'action',
        icon: 'folder',
        action: this.requiresRepository(() => { this.showSubmodules = true; }),
      },
      {
        id: 'worktrees',
        label: 'Manage worktrees',
        category: 'action',
        icon: 'folder',
        action: this.requiresRepository(() => { this.showWorktrees = true; }),
      },
      {
        id: 'lfs',
        label: 'Manage Git LFS',
        category: 'action',
        icon: 'folder',
        action: this.requiresRepository(() => { this.showLfs = true; }),
      },
      {
        id: 'gpg',
        label: 'GPG Signing Settings',
        category: 'action',
        icon: 'key',
        action: this.requiresRepository(() => { this.showGpg = true; }),
      },
      {
        id: 'ssh',
        label: 'SSH Key Management',
        category: 'action',
        icon: 'key',
        action: () => { this.showSsh = true; },
      },
      {
        id: 'config',
        label: 'Git Configuration',
        category: 'action',
        icon: 'settings',
        action: this.requiresRepository(() => { this.showConfig = true; }),
      },
      {
        id: 'credentials',
        label: 'Credential Management',
        category: 'action',
        icon: 'key',
        action: this.requiresRepository(() => { this.showCredentials = true; }),
      },
      {
        id: 'gc',
        label: 'Run Garbage Collection',
        category: 'action',
        icon: 'trash',
        action: this.requiresRepository(() => this.handleRunGc()),
      },
      {
        id: 'gc-aggressive',
        label: 'Run Garbage Collection (Aggressive)',
        category: 'action',
        icon: 'trash',
        action: this.requiresRepository(() => this.handleRunGc(true)),
      },
      {
        id: 'fsck',
        label: 'Check Repository Integrity',
        category: 'action',
        icon: 'search',
        action: this.requiresRepository(() => this.handleRunFsck()),
      },
      {
        id: 'prune',
        label: 'Prune Unreachable Objects',
        category: 'action',
        icon: 'trash',
        action: this.requiresRepository(() => this.handleRunPrune()),
      },
      {
        id: 'repository-health',
        label: 'Repository Health & Maintenance',
        category: 'action',
        icon: 'activity',
        action: this.requiresRepository(() => { this.showRepositoryHealth = true; }),
      },
      {
        id: 'github',
        label: 'GitHub Integration',
        category: 'action',
        icon: 'github',
        // Account connection is repo-independent; only PR/issue/pipeline tabs guard themselves.
        action: () => this.openIntegrationStandalone('github'),
      },
      {
        id: 'gitlab',
        label: 'GitLab Integration',
        category: 'action',
        icon: 'gitlab',
        action: () => this.openIntegrationStandalone('gitlab'),
      },
      {
        id: 'bitbucket',
        label: 'Bitbucket Integration',
        category: 'action',
        icon: 'bitbucket',
        action: () => this.openIntegrationStandalone('bitbucket'),
      },
      {
        id: 'azure-devops',
        label: 'Azure DevOps Integration',
        category: 'action',
        icon: 'azure',
        action: () => this.openIntegrationStandalone('azure-devops'),
      },
      {
        id: 'oidc',
        label: 'Enterprise SSO (OIDC) Integration',
        category: 'action',
        icon: 'key',
        action: () => this.openIntegrationStandalone('oidc'),
      },
      {
        id: 'profiles',
        label: 'Profiles & Accounts',
        category: 'action',
        icon: 'user',
        action: () => { this.showProfileManager = true; },
      },
      {
        id: 'search',
        label: 'Search commits',
        category: 'action',
        icon: 'search',
        shortcut: `${mod}F`,
        action: () => this.handleToggleSearch(),
      },
      {
        id: 'search-in-files',
        label: 'Search in files',
        category: 'action',
        icon: 'search',
        action: this.requiresRepository(() => this.openSearchDialog('files')),
      },
      {
        id: 'search-in-diff',
        label: 'Search in current diff',
        category: 'action',
        icon: 'search',
        action: this.requiresRepository(() => this.openSearchDialog('diff')),
      },
      {
        id: 'search-commit-content',
        label: 'Find commits that changed text',
        category: 'action',
        icon: 'search',
        action: this.requiresRepository(() => this.openSearchDialog('commits')),
      },
      {
        id: 'stage-all',
        label: 'Stage all changes',
        category: 'action',
        icon: 'commit',
        action: this.requiresRepository(() => this.handleStageAll()),
      },
      {
        id: 'unstage-all',
        label: 'Unstage all changes',
        category: 'action',
        icon: 'commit',
        action: this.requiresRepository(() => this.handleUnstageAll()),
      },
      {
        id: 'toggle-left-panel',
        label: 'Toggle left panel',
        category: 'navigation',
        shortcut: `${mod}B`,
        action: () => this.toggleLeftPanel(),
      },
      {
        id: 'toggle-right-panel',
        label: 'Toggle right panel',
        category: 'navigation',
        shortcut: `${mod}J`,
        action: () => uiStore.getState().togglePanel('right'),
      },
      {
        id: 'undo',
        label: 'Undo (open reflog)',
        category: 'action',
        icon: 'refresh',
        shortcut: `${mod}Z`,
        action: this.requiresRepository(() => { this.showReflog = true; }),
      },
      {
        id: 'describe',
        label: 'Describe commit (git describe)',
        category: 'action',
        icon: 'tag',
        action: this.requiresRepository(() => { this.describeDialog?.open(); }),
      },
      {
        id: 'compare-branches',
        label: 'Compare branches',
        category: 'action',
        icon: 'branch',
        action: this.requiresRepository(() => { this.compareBranchesDialog?.open(); }),
      },
      {
        id: 'workspaces',
        label: 'Manage workspaces',
        category: 'action',
        icon: 'folder',
        action: () => { this.showWorkspaceManager = true; },
      },
      {
        id: 'hooks',
        label: 'Manage git hooks',
        category: 'action',
        icon: 'terminal',
        action: this.requiresRepository(() => { this.showHooksDialog = true; }),
      },
      {
        id: 'gitignore',
        label: 'Edit .gitignore & .gitattributes',
        category: 'action',
        icon: 'file',
        action: this.requiresRepository(() => { this.showGitignoreDialog = true; }),
      },
      // The palette acts on the ACTIVE repository; the same three actions are
      // on the repository tab context menu for any open tab. Failures (no
      // terminal emulator, a path that has gone away, an editor that cannot be
      // spawned) are toasted by the shared service with the backend message.
      {
        id: 'open-in-terminal',
        label: 'Open in Terminal',
        category: 'action',
        icon: 'terminal',
        action: this.requiresRepository(() => {
          void openRepositoryInTerminal(this.activeRepository!.repository.path);
        }),
      },
      {
        id: 'reveal-in-file-manager',
        label: 'Reveal in File Manager',
        category: 'action',
        icon: 'folder',
        action: this.requiresRepository(() => {
          void openRepositoryInFileManager(this.activeRepository!.repository.path);
        }),
      },
      {
        id: 'open-in-editor',
        label: 'Open in Editor',
        category: 'action',
        icon: 'file',
        action: this.requiresRepository(() => {
          void openRepositoryInEditor(this.activeRepository!.repository.path);
        }),
      },
    ];

    return commands;
  }

  private async restorePersistedRepositories(): Promise<void> {
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

  private async handleFetch(): Promise<void> {
    if (!this.activeRepository) return;
    // Coalesced like its pull and push siblings. keyboardService has no
    // e.repeat guard, so HOLDING Ctrl+Shift+F fires many times a second and
    // every repeat launched a fully concurrent fetch — each with its own
    // progress row, and a stacked toast per repeat from the backend's
    // remote-operation-completed. Fetch must NOT take the working-tree lock
    // (it touches no working tree), so it gets its own key.
    const fetchRepo = this.activeRepository.repository.path;
    const fetchKey = `fetch:${fetchRepo}`;
    if (!tryAcquirePush(fetchKey)) return;
    try {
      await this.fetchRepository();
    } finally {
      releasePush(fetchKey);
    }
  }

  private async fetchRepository(): Promise<void> {
    if (!this.activeRepository) return;
    const opId = progressService.startOperation('fetch', 'Fetching from remote...', {
      cancellable: true,
    });
    // gitService.fetch returns a CommandResult (invokeCommand never throws), so we
    // must inspect result.success — a catch-only path always reported success and
    // the backend emits remote-operation-completed only on success, so failures
    // were fully silent.
    // Pinned: fetch is a slow network op; if the user switches tabs while it
    // runs, the refresh must target the repo that fetched, not the active tab.
    const repoPath = this.activeRepository.repository.path;
    // silent: this handler owns the messaging (and the backend's
    // remote-operation-completed event toasts the success). Without it every
    // toolbar fetch stacked two toasts, and every failure two errors.
    const result = await gitService.fetch({ path: repoPath, silent: true, operationId: opId });
    if (result.success) {
      progressService.completeOperation(opId);
      this.refreshConflictDialogRepo(repoPath);
    } else {
      progressService.failOperation(opId);
      // A cancel the user asked for is not a failure — say it took effect
      // rather than showing them a red error for their own click.
      if (gitService.isOperationCancelled(result.error)) {
        showToast('Fetch cancelled', 'info');
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // A security-gate refusal already announced itself, and a declined
        // confirm is the user's own decision — reporting either as a red error
        // tells them their own click failed.
        showToast(result.error?.message ?? 'Fetch failed', 'error');
      }
    }
  }

  private handlePull(pinnedRepoPath?: string): Promise<void> {
    // pinnedRepoPath comes from a suggestion toast's Pull Now, which must pull
    // the repo whose push failed even if the user has since switched tabs.
    const repoPath = pinnedRepoPath ?? this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    // Three surfaces reach this — Ctrl+Shift+P, the palette, and the Pull Now
    // toast action — and none guarded against a second call. ensure_pullable
    // in the backend only refuses when a merge is ALREADY unresolved; two pulls
    // that both start clean both pass it, and the second calls repo.merge() on
    // top of the first, which deletes MERGE_HEAD and leaves a conflicted index
    // that abort_merge then refuses to clean up. Keyboard auto-repeat alone
    // fires this ~30x a second.
    //
    // Held on the SHARED working-tree lock, not a private key: a pull's
    // fast-forward runs checkout_tree and moves the branch ref, and its merge
    // and rebase paths rewrite the tree outright. Keying it separately
    // serialized pull against pull but left every sidebar checkout, discard
    // and reset fully enabled beside it — the exact split ref-lock.ts exists
    // to close. Claimed before the network-permission confirm so that round
    // trip is covered too.
    return this.runRefExclusive(repoPath, () => this.pullRepository(repoPath));
  }

  private async pullRepository(repoPath: string): Promise<void> {
    // Cancellable, but only up to the point the merge starts: the backend's
    // pull aborts during its fetch phase and refuses to begin a merge it
    // cannot safely stop halfway. See commands/remote.rs::pull_branch.
    const opId = progressService.startOperation('pull', 'Pulling from remote...', {
      cancellable: true,
    });
    // gitService.pull returns a CommandResult (invokeCommand never throws), so we
    // must inspect result.success — the old catch-only path always reported success.
    const result = await gitService.pull({ path: repoPath, silent: true, operationId: opId });
    if (result.success) {
      progressService.completeOperation(opId);
      // Pinned: a ref-only pull emits no working-tree watcher event, so a
      // pull that completed on a now-backgrounded repo must be refreshed
      // (or marked stale) by path, not via the active tab.
      this.refreshConflictDialogRepo(repoPath);
    } else if (result.error?.code === 'MERGE_CONFLICT') {
      progressService.failOperation(opId);
      // Not a failure from the user's side — the pull landed and now needs
      // resolving. A red "Pull failed" here reads as "nothing happened".
      showToast('Pull produced conflicts — resolve them to finish the merge', 'warning');
      this.conflictOperationType = 'merge';
      this.resetConflictDetailState();
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
    } else if (result.error?.code === 'REBASE_CONFLICT') {
      progressService.failOperation(opId);
      showToast('Pull produced conflicts — resolve them to finish the rebase', 'warning');
      this.conflictOperationType = 'rebase';
      this.resetConflictDetailState();
      this.openConflictDialogPinned(repoPath);
      this.refreshConflictDialogRepo(repoPath);
    } else {
      progressService.failOperation(opId);
      if (gitService.isOperationCancelled(result.error)) {
        // Stopped during the fetch, so nothing was merged — the repository is
        // exactly where a plain Fetch would have left it.
        showToast('Pull cancelled', 'info');
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // A security-gate refusal already announced itself, and a declined
        // confirm is the user's own decision — reporting either as a red error
        // tells them their own click failed.
        showToast(result.error?.message ?? 'Pull failed', 'error');
      }
    }
  }

  private handlePush(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    // Keyed like the force-push sibling, which was hardened against exactly
    // this: the shortcut has no e.repeat guard, so holding Ctrl+Shift+U fires
    // it many times a second and every repeat launched a fully concurrent
    // push. Sharing the key also makes Push and Force Push mutually exclusive
    // on one repo.
    return this.runPushExclusive(repoPath, () => this.pushRepository());
  }

  private async pushRepository(): Promise<void> {
    if (!this.activeRepository) return;
    const opId = progressService.startOperation('push', 'Pushing to remote...', {
      cancellable: true,
    });
    // gitService.push returns a CommandResult (invokeCommand never throws), so we
    // must inspect result.success — a catch-only path always reported success and
    // the backend emits remote-operation-completed only on success, so failures
    // were fully silent.
    // Pinned: push is a slow network op; if the user switches tabs while it
    // runs, the refresh must target the repo that pushed, not the active tab.
    const repoPath = this.activeRepository.repository.path;
    const result = await gitService.push({ path: repoPath, silent: true, operationId: opId });
    if (result.success) {
      progressService.completeOperation(opId);
      this.refreshConflictDialogRepo(repoPath);
    } else {
      progressService.failOperation(opId);
      if (gitService.isOperationCancelled(result.error)) {
        showToast('Push cancelled', 'info');
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // A security-gate refusal already announced itself, and a declined
        // confirm is the user's own decision — reporting either as a red error
        // tells them their own click failed.
        //
        // Through the suggestion service so a non-fast-forward rejection offers
        // the Pull Now action the app already implements — a plain toast made
        // that recovery unreachable from the only push surface there is.
        showErrorWithSuggestion(result.error?.message ?? '', 'Push failed', {
          operation: 'push',
          repoPath,
        });
      }
    }
  }

  private handleCancelOperation(e: CustomEvent<{ id: string }>): void {
    progressService.cancelOperation(e.detail.id);
  }

  private handleCreateStash(): Promise<void> {
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

  private async handleRunGc(aggressive = false): Promise<void> {
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

  private async handleRunFsck(): Promise<void> {
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

  private async handleRunPrune(): Promise<void> {
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
    this.showWorkspaceManager = false;

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
      this.showBlame = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to open repository', 'error');
    }
  }

  /**
   * Select a commit in the graph, telling the user when it isn't loaded
   * (below the paginated window or hidden by a branch filter) instead of
   * silently doing nothing. ALL reveal-in-graph flows must go through this.
   */
  private revealCommitInGraph(oid: string): void {
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
    this.showDiff = false;
    this.diffFile = null;
    this.diffCommitFile = null;
    // Close blame if open
    this.showBlame = false;
    this.blameFile = null;
    this.blameCommitOid = null;
    // Open file history
    this.fileHistoryPath = e.detail.filePath;
    this.showFileHistory = true;
  }

  private handleCloseFileHistory(): void {
    this.showFileHistory = false;
    this.fileHistoryPath = null;
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
    this.showDiff = true;
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

  render() {
    return html`
      <a class="skip-link" href="#main-content" @click=${(e: Event) => {
        e.preventDefault();
        const main = this.shadowRoot?.querySelector('#main-content') as HTMLElement;
        main?.focus();
      }}>Skip to main content</a>

      ${this.globalLoading ? html`<div class="global-loading-bar"></div>` : ''}

      <lv-toolbar
        @open-settings=${() => { this.showSettings = true; }}
        @open-shortcuts=${() => { this.showShortcuts = true; }}
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
        @open-profile-manager=${() => { this.showProfileManager = true; }}
        @open-workspace-manager=${() => { this.showWorkspaceManager = true; }}
        @search-change=${this.handleSearchChange}
      ></lv-toolbar>

      ${this.activeRepository
        ? html`
            <lv-context-dashboard
              @open-profile-manager=${() => { this.showProfileManager = true; }}
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
                                  @click=${() => { this.showBisect = true; }}
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
                  ></lv-graph-canvas>
                </div>

                ${this.showDiff
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
                  : this.showBlame && this.blameFile
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
                    : this.showFileHistory && this.fileHistoryPath
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
                ${this.showOutputPanel
                  ? html`
                      <div class="output-panel-container">
                        <lv-output-panel
                          closable
                          .repositoryPath=${this.activeRepository.repository.path}
                          @close=${() => { this.showOutputPanel = false; }}
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
                    @open-settings=${() => { this.showSettings = true; }}
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
            @open-workspace-manager=${() => { this.showWorkspaceManager = true; }}
            @open-profile-manager=${() => { this.showProfileManager = true; }}
          ></lv-welcome>`}

      ${this.showSettings
        ? html`
            <lv-modal
              open
              modalTitle="Settings"
              @close=${this.handleCloseSettings}
            >
              <lv-settings-dialog
                @close=${this.handleCloseSettings}
                @open-profile-manager=${() => { this.showProfileManager = true; }}
              ></lv-settings-dialog>
            </lv-modal>
          `
        : ''}

      ${this.showConflictDialog && this.conflictDialogConfig
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
        ?open=${this.showCommandPalette}
        .repositoryPath=${this.commandPaletteRepositoryPath ?? ''}
        .commands=${this.getPaletteCommands()}
        .branches=${this.paletteBranches}
        .files=${this.paletteTrackedFiles}
        .commits=${this.graphCanvas?.getLoadedCommits() ?? []}
        .tags=${this.graphCanvas?.getTagTips() ?? []}
        @close=${() => { this.handleCommandPaletteClose(); }}
        @checkout-branch=${this.handleCheckoutBranch}
        @open-file=${this.handleOpenFileFromPalette}
        @navigate-to-commit=${this.handleNavigateToCommit}
      ></lv-command-palette>

      ${this.activeRepository ? html`
        <lv-reflog-dialog
          ?open=${this.showReflog}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showReflog = false; }}
          @undo-complete=${(e: CustomEvent<{ repositoryPath?: string }>) => {
            this.showReflog = false;
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null);
          }}
          @show-commit=${(e: CustomEvent<{ oid: string }>) => { this.showReflog = false; this.revealCommitInGraph(e.detail.oid); }}
        ></lv-reflog-dialog>

        <lv-search-dialog
          ?open=${this.showSearchDialog}
          .mode=${this.searchDialogMode}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showSearchDialog = false; }}
          @mode-changed=${(e: CustomEvent<{ mode: SearchDialogMode }>) => { this.searchDialogMode = e.detail.mode; }}
          @show-blame=${this.handleShowBlame}
          @show-working-diff=${this.handleShowWorkingDiff}
        ></lv-search-dialog>
      ` : ''}

      <lv-keyboard-shortcuts-dialog
        ?open=${this.showShortcuts}
        ?vimMode=${this.vimMode}
        @close=${() => { this.showShortcuts = false; }}
        @vim-mode-change=${this.handleVimModeChange}
      ></lv-keyboard-shortcuts-dialog>

      ${this.activeRepository ? html`
        <lv-remote-dialog
          ?open=${this.showRemotes}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showRemotes = false; }}
          @remotes-changed=${() => this.handleRefresh()}
        ></lv-remote-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-clean-dialog
          ?open=${this.showClean}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showClean = false; }}
          @files-cleaned=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-clean-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-changelog-dialog
          .repositoryPath=${this.activeRepository.repository.path}
        ></lv-changelog-dialog>
      ` : ''}

      ${this.activeRepository && this.showRepositoryHealth ? html`
        <lv-modal
          modalTitle="Repository Health"
          ?open=${this.showRepositoryHealth}
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
          ?open=${this.showBisect}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showBisect = false; }}
          @bisect-step=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
          @bisect-complete=${(e: CustomEvent<{ repositoryPath?: string }>) => {
            this.showBisect = false;
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null);
          }}
        ></lv-bisect-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-submodule-dialog
          ?open=${this.showSubmodules}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showSubmodules = false; }}
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
          ?open=${this.showWorktrees}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showWorktrees = false; }}
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
          ?open=${this.showLfs}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showLfs = false; }}
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
          ?open=${this.showGpg}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showGpg = false; }}
          @gpg-changed=${(e: CustomEvent<{ repositoryPath?: string }>) =>
            this.refreshConflictDialogRepo(e.detail?.repositoryPath ?? null)}
        ></lv-gpg-dialog>
      ` : ''}

      <lv-ssh-dialog
        ?open=${this.showSsh}
        @close=${() => { this.showSsh = false; }}
      ></lv-ssh-dialog>

      ${this.activeRepository ? html`
        <lv-config-dialog
          ?open=${this.showConfig}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showConfig = false; }}
        ></lv-config-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-credentials-dialog
          ?open=${this.showCredentials}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showCredentials = false; }}
        ></lv-credentials-dialog>
      ` : ''}

      <lv-github-dialog
        ?open=${this.showGitHub}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('github')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-github-dialog>

      <lv-gitlab-dialog
        ?open=${this.showGitLab}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('gitlab')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-gitlab-dialog>

      <lv-bitbucket-dialog
        ?open=${this.showBitbucket}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('bitbucket')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-bitbucket-dialog>

      <lv-azure-devops-dialog
        ?open=${this.showAzureDevOps}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        .repositoryPath=${this.activeRepository?.repository.path ?? ''}
        @close=${() => this.handleIntegrationDialogClose('azure-devops')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-azure-devops-dialog>

      <lv-oidc-dialog
        ?open=${this.showOidc}
        ?backButton=${this.integrationBackButton}
        .attachToProfileName=${this.integrationAttachName}
        @close=${() => this.handleIntegrationDialogClose('oidc')}
        @manage-accounts=${this.handleManageAccounts}
      ></lv-oidc-dialog>

      <lv-profile-manager-dialog
        ?open=${this.showProfileManager}
        ?demoted=${this.profileManagerDemoted}
        .repoPath=${this.activeRepository?.repository.path ?? ''}
        .initialView=${this.profileManagerView}
        @close=${this.handleProfileManagerClose}
        @open-github=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('github', e)}
        @open-gitlab=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('gitlab', e)}
        @open-bitbucket=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('bitbucket', e)}
        @open-azure-devops=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('azure-devops', e)}
        @open-oidc=${(e: CustomEvent<IntegrationOpenContext>) => this.handleOpenIntegrationFromManager('oidc', e)}
        @migration-needed=${() => { this.showMigrationDialog = true; }}
        @request-restore-provider=${this.handleRestoreProvider}
      ></lv-profile-manager-dialog>

      <lv-migration-dialog
        ?open=${this.showMigrationDialog}
        @close=${() => { this.showMigrationDialog = false; }}
        @open-profile-manager=${() => { this.showProfileManager = true; }}
      ></lv-migration-dialog>

      <lv-workspace-manager-dialog
        ?open=${this.showWorkspaceManager}
        @close=${() => { this.showWorkspaceManager = false; }}
        @open-repo-file=${this.handleWorkspaceOpenRepoFile}
      ></lv-workspace-manager-dialog>

      ${this.activeRepository ? html`
        <lv-hooks-dialog
          ?open=${this.showHooksDialog}
          .repoPath=${this.activeRepository.repository.path}
          @close=${() => { this.showHooksDialog = false; }}
        ></lv-hooks-dialog>
      ` : ''}

      ${this.activeRepository ? html`
        <lv-gitignore-dialog
          ?open=${this.showGitignoreDialog}
          .repositoryPath=${this.activeRepository.repository.path}
          @close=${() => { this.showGitignoreDialog = false; }}
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
          .graphRepositoryPath=${this.graphCanvas?.repositoryPath ?? ''}
          .branches=${this.activeRepository?.branches ?? []}
          .tags=${this.graphCanvas?.getTagTips() ?? []}
          .commits=${this.graphCanvas?.getLoadedCommits() ?? []}
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
