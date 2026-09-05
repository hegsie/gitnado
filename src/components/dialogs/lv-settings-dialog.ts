import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { localized, msg, str } from '@lit/localize';
import {
  settingsStore,
  getGraphColorSchemes,
  clampDiffContextLines,
  getDiffWhitespaceModes,
  MIN_DIFF_CONTEXT_LINES,
  MAX_DIFF_CONTEXT_LINES,
  type Theme,
  type FontSize,
  type Density,
  type GraphColorScheme,
} from '../../stores/settings.store.ts';
import type { DiffWhitespaceMode } from '../../types/api.types.ts';
import { supportedLocales, resolveLocale, type Locale } from '../../i18n/index.ts';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { getAppVersion, checkForUpdate } from '../../services/update.service.ts';
import { openCloneDestinationDialog, showConfirm } from '../../services/dialog.service.ts';
import * as aiService from '../../services/ai.service.ts';
import * as localAiService from '../../services/local-ai.service.ts';
import * as mcpService from '../../services/mcp.service.ts';
import * as gitService from '../../services/git.service.ts';
import type { MergeToolInfo, AvailableDiffTool } from '../../services/git.service.ts';
import { avatarBlockedExplanation, GRAVATAR_HOST } from '../../utils/avatar-policy.ts';
import { showToast } from '../../services/notification.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import type { AiProviderInfo, AiProviderType } from '../../services/ai.service.ts';
import type { SystemCapabilities, ModelEntry, DownloadedModel, DownloadProgress, LocalModelStatus } from '../../services/local-ai.service.ts';
import type { McpStatus } from '../../services/mcp.service.ts';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import '../common/lv-toggle.ts';

/**
 * How a provider's state reads in the picker.
 *
 * "Not probed" is its own answer, distinct from "Unavailable": with offline
 * mode on (or the provider's host outside the allowlist) the backend
 * deliberately does not reach out to find out, so the list still renders —
 * which is what lets the user get to the switch that turns the cloud provider
 * off — without a request leaving the machine. Calling that "Unavailable"
 * would be telling the user their provider is broken.
 */
export function providerStatusLabel(provider: AiProviderInfo): string {
  if (provider.available) return msg('(Available)');
  if (provider.requiresApiKey && !provider.hasApiKey) return msg('(API key required)');
  // Compared against `false` rather than truthiness so a payload without the
  // field (an older backend) keeps reading "(Unavailable)" instead of claiming
  // nothing was checked.
  if (provider.probed === false) return msg('(Not checked - offline)');
  return msg('(Unavailable)');
}

@customElement('lv-settings-dialog')
@localized()
export class LvSettingsDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        width: 500px;
      }

      .settings-content {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      .settings-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .section-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 8px;
      }

      .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }

      .setting-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .setting-name {
        font-size: 13px;
        color: var(--text-primary);
      }

      .setting-description {
        font-size: 11px;
        color: var(--text-secondary);
      }

      /* A setting another setting has taken away: dimmed, with the reason
         spelled out under it rather than left for the user to guess. */
      .setting-row.setting-unavailable .setting-label {
        opacity: 0.6;
      }

      .setting-unavailable-reason {
        font-size: 11px;
        color: var(--color-warning);
      }

      select, input[type="text"], input[type="number"] {
        padding: 6px 10px;
        border: 1px solid var(--border-color);
        border-radius: 4px;
        background: var(--input-background);
        color: var(--text-primary);
        font-size: 13px;
        min-width: 150px;
      }

      select:focus, input:focus {
        outline: none;
        border-color: var(--accent-color);
      }

      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--accent-color);
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 16px;
      }

      button {
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid var(--border-color);
        background: var(--button-background);
        color: var(--text-primary);
      }

      button:hover {
        background: var(--button-hover-background);
      }

      button.primary {
        background: var(--accent-color);
        border-color: var(--accent-color);
        color: white;
      }

      button.primary:hover {
        opacity: 0.9;
      }

      button.danger {
        color: var(--error-color);
      }

      .version-info {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .version-text {
        font-size: 13px;
        color: var(--text-secondary);
      }

      .version-number {
        font-weight: 600;
        color: var(--text-primary);
      }

      .update-status {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .update-status.available {
        color: var(--accent-color);
      }

      .check-update-btn {
        padding: 4px 8px;
        font-size: 12px;
        min-width: auto;
      }

      .progress-bar {
        height: 4px;
        background: var(--border-color);
        border-radius: 2px;
        overflow: hidden;
        margin-top: 8px;
      }

      .progress-fill {
        height: 100%;
        background: var(--accent-color);
        transition: width 0.2s ease;
      }

      .progress-text {
        font-size: 11px;
        color: var(--text-secondary);
        margin-top: 4px;
      }

      .model-status {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .model-status.available {
        color: var(--success-color, #22c55e);
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .error-text {
        font-size: 11px;
        color: var(--error-color);
        margin-top: 4px;
      }

      /* The About row lays its status out inline next to the version, so the
         shared .error-text top margin would drop it off the baseline. */
      .error-text.update-error {
        margin-top: 0;
        font-size: 12px;
      }

      .mcp-token-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 8px;
      }

      .mcp-token-value {
        font-family: monospace;
        font-size: 12px;
        color: var(--text-primary);
        background: var(--input-background);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        padding: 4px 8px;
        max-width: 280px;
        overflow-wrap: anywhere;
      }

      .mcp-client-config {
        margin: 0;
        padding: 8px 10px;
        background: var(--input-background);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        font-family: monospace;
        font-size: 11px;
        color: var(--text-secondary);
        overflow-x: auto;
        white-space: pre;
      }

      .status-indicator {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
      }

      .status-indicator.configured {
        color: var(--success-color, #22c55e);
        background: rgba(34, 197, 94, 0.1);
      }

      .status-indicator.not-configured {
        color: var(--text-secondary);
        background: var(--border-color);
      }

      .status-indicator.testing {
        color: var(--accent-color);
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }

      .provider-status-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
      }

      .color-scheme-preview {
        display: flex;
        gap: 2px;
        margin-left: 8px;
      }

      .color-swatch {
        width: 12px;
        height: 12px;
        border-radius: 2px;
      }

      .auto-scheme-note {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm, 4px);
        font-size: 11px;
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      /* Forced colors would flatten every swatch to the same system color,
         turning the palette preview into a row of identical squares. These
         squares ARE the information, so opt them out and outline them. */
      @media (forced-colors: active) {
        .color-swatch {
          forced-color-adjust: none;
          border: 1px solid CanvasText;
        }

        .auto-scheme-note {
          border-color: CanvasText;
        }
      }

      .scheme-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .path-input-group {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .path-input-group input[type="text"] {
        min-width: 220px;
      }

      .browse-button {
        padding: 6px 10px;
        font-size: 12px;
        white-space: nowrap;
      }
    `,
  ];

  @state() private language: Locale = 'en';
  @state() private theme: Theme = 'dark';
  @state() private appVersion = '';
  @state() private updateStatus:
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'failed' = 'idle';
  /** Why the last check did not produce an answer — a security-gate refusal
   * naming the setting that refused it, or the backend's error. */
  @state() private updateError: string | null = null;
  @state() private resetting = false;
  @state() private latestVersion = '';
  @state() private fontSize: FontSize = 'medium';
  @state() private density: Density = 'comfortable';
  @state() private graphColorScheme: GraphColorScheme = 'default';
  @state() private graphColorSchemeAuto = true;
  @state() private systemHighContrast = false;
  @state() private defaultBranchName = 'main';
  @state() private defaultClonePath = '';
  @state() private showAvatars = false;
  @state() private showCommitSize = true;
  @state() private wordWrap = true;
  @state() private diffIgnoreWhitespace: DiffWhitespaceMode = 'none';
  @state() private diffContextLines = 3;
  @state() private confirmBeforeDiscard = true;
  @state() private openLastRepository = true;
  @state() private offlineMode = false;
  @state() private confirmNetworkOps = false;
  @state() private remoteAllowlist: string[] = [];
  @state() private autoStashOnCheckout = false;
  @state() private alwaysSignOff = false;
  @state() private staleBranchDays = 90;
  @state() private networkOperationTimeout = 300;

  // Network & sync settings
  @state() private autoFetchInterval = 0;
  @state() private fetchOnFocus = false;

  // System tray settings
  @state() private minimizeToTray = false;
  @state() private showNativeNotifications = true;

  // AI settings
  @state() private aiProviders: AiProviderInfo[] = [];
  @state() private activeProvider: AiProviderType | null = null;
  @state() private aiError: string | null = null;
  @state() private testingProvider: AiProviderType | null = null;
  @state() private providerTestStatus: Record<string, 'untested' | 'success' | 'failed'> = {};
  @state() private apiKeyInputs: Record<string, string> = {};

  // Local AI settings
  @state() private systemCapabilities: SystemCapabilities | null = null;
  @state() private availableModels: ModelEntry[] = [];
  @state() private downloadedModels: DownloadedModel[] = [];
  @state() private downloadProgress: Record<string, DownloadProgress> = {};
  @state() private localModelStatus: LocalModelStatus = 'unloaded';
  @state() private loadedModelName: string | null = null;
  @state() private loadingModelId: string | null = null;
  @state() private recommendedModel: ModelEntry | null = null;

  // MCP settings
  @state() private mcpStatus: McpStatus = {
    running: false,
    port: 3001,
    url: null,
    lastError: null,
  };
  @state() private mcpPort = 3001;
  @state() private mcpEnabled = false;
  @state() private mcpToggling = false;
  @state() private mcpError: string | null = null;
  /** Bearer token required by every MCP request. Treated as a secret: masked unless revealed. */
  @state() private mcpToken = '';
  @state() private mcpTokenRevealed = false;
  @state() private mcpRegenerating = false;
  /**
   * Origins the backend enforces on the MCP request path. Carried through every
   * save so persisting the port or the enabled flag cannot wipe the list.
   */
  @state() private mcpAllowedOrigins: string[] = [];

  // Event listener cleanup
  private downloadProgressUnlisten: UnlistenFn | null = null;
  private downloadCompleteUnlisten: UnlistenFn | null = null;
  private downloadErrorUnlisten: UnlistenFn | null = null;

  // External tools settings
  @state() private mergeToolName: string | null = null;
  @state() private mergeToolCmd: string | null = null;
  @state() private availableMergeTools: MergeToolInfo[] = [];
  @state() private diffToolName: string | null = null;
  @state() private diffToolCmd: string | null = null;
  @state() private availableDiffTools: AvailableDiffTool[] = [];
  @state() private loadingTools = false;

  // Monotonic write tokens. Only the newest write for a tool owns its controls,
  // so a slow failure can no longer roll the UI back over a newer save that
  // already landed.
  private mergeToolWriteToken = 0;
  private diffToolWriteToken = 0;

  private settingsUnsubscribe: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.loadSettings();
    // The graph colour scheme can change underneath an open dialog when the OS
    // high-contrast setting flips, so mirror it from the store.
    this.settingsUnsubscribe = settingsStore.subscribe((state) => {
      this.graphColorScheme = state.graphColorScheme;
      this.graphColorSchemeAuto = state.graphColorSchemeAuto;
      this.systemHighContrast = state.systemHighContrast;
    });
    this.loadVersion();
    this.loadAiProviders();
    this.loadExternalToolsConfig();
    this.loadLocalAiData();
    this.loadMcpStatus();
    this.setupDownloadListeners();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.settingsUnsubscribe?.();
    this.settingsUnsubscribe = null;
    this.downloadProgressUnlisten?.();
    this.downloadCompleteUnlisten?.();
    this.downloadErrorUnlisten?.();
  }

  protected updated(): void {
    // A <select>'s `.value` binding commits before the <option>s rendered inside
    // it in the same Lit update, so a value whose option only appears in that
    // update is dropped and the select falls back to "None". Re-apply both tool
    // selects once their options exist.
    this.syncSelectValue('#merge-tool-select', this.mergeToolName);
    this.syncSelectValue('#diff-tool-select', this.diffToolName);
    // Same hazard: the graph scheme select and its options render in one
    // update, and the automatic high-contrast scheme is a value that is only
    // ever set before the options exist.
    this.syncSelectValue('#graph-scheme-select', this.graphColorScheme);
    this.syncSelectValue('#diff-whitespace-select', this.diffIgnoreWhitespace);
    // Same hazard again: the language select and its options render in the same
    // update, so a non-default locale would fall back to the first option.
    this.syncSelectValue('#language-select', this.language);
  }

  private syncSelectValue(selector: string, value: string | null): void {
    const select = this.shadowRoot?.querySelector<HTMLSelectElement>(selector);
    if (select && select.value !== (value ?? '')) {
      select.value = value ?? '';
    }
  }

  private async loadVersion(): Promise<void> {
    this.appVersion = await getAppVersion();
  }

  private async loadAiProviders(): Promise<void> {
    const [providersResult, activeResult] = await Promise.all([
      aiService.getAiProviders(),
      aiService.getActiveAiProvider(),
    ]);

    if (providersResult.success && providersResult.data) {
      this.aiProviders = providersResult.data;
    }

    if (activeResult.success && activeResult.data !== undefined) {
      this.activeProvider = activeResult.data;
    }
  }

  private async handleProviderSelect(providerType: AiProviderType): Promise<void> {
    this.aiError = null;
    const result = await aiService.setAiProvider(providerType);
    if (result.success) {
      this.activeProvider = providerType;
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } else {
      this.aiError = result.error?.message ?? 'Failed to set provider';
    }
  }

  private async handleApiKeyChange(providerType: AiProviderType, apiKey: string): Promise<void> {
    this.apiKeyInputs = { ...this.apiKeyInputs, [providerType]: apiKey };
  }

  private async handleSaveApiKey(providerType: AiProviderType): Promise<void> {
    this.aiError = null;
    const apiKey = this.apiKeyInputs[providerType] || '';
    const result = await aiService.setAiApiKey(providerType, apiKey || null);
    if (result.success) {
      await this.loadAiProviders();
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } else {
      this.aiError = result.error?.message ?? 'Failed to save API key';
    }
  }

  private async handleModelChange(providerType: AiProviderType, model: string): Promise<void> {
    this.aiError = null;
    const result = await aiService.setAiModel(providerType, model || null);
    if (result.success) {
      await this.loadAiProviders();
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } else {
      this.aiError = result.error?.message ?? 'Failed to set model';
    }
  }

  private async handleTestProvider(providerType: AiProviderType): Promise<void> {
    this.testingProvider = providerType;
    this.aiError = null;

    const result = await aiService.testAiProvider(providerType);
    this.testingProvider = null;

    if (result.success && result.data) {
      this.providerTestStatus = { ...this.providerTestStatus, [providerType]: 'success' };
    } else {
      this.providerTestStatus = { ...this.providerTestStatus, [providerType]: 'failed' };
      // A security-gate refusal names the setting that refused and how to undo
      // it. Overwriting that with "check your API key" sent the user to fix a
      // key that was never the problem.
      this.aiError = gitService.isNetworkGateRefusal(result.error)
        ? (result.error?.message ?? msg('Blocked by security settings'))
        : `${aiService.getProviderDisplayName(providerType)} is not available. Check your API key and try again.`;
    }
  }

  private async handleCheckForUpdate(): Promise<void> {
    this.updateStatus = 'checking';
    this.updateError = null;
    const result = await checkForUpdate();
    if (result.success && result.data) {
      if (result.data.updateAvailable) {
        this.updateStatus = 'available';
        this.latestVersion = result.data.latestVersion ?? '';
      } else {
        this.updateStatus = 'up-to-date';
      }
      return;
    }
    // A refusal from the security gate names the setting that refused it and
    // how to undo it; anything else is a failed check. Both used to collapse
    // into `idle`, which showed the user nothing at all.
    this.updateStatus = 'failed';
    this.updateError =
      result.error?.message ?? msg('Could not check for updates. Try again later.');
  }

  private loadSettings(): void {
    const settings = settingsStore.getState();
    this.language = settings.language;
    this.theme = settings.theme;
    this.fontSize = settings.fontSize;
    this.density = settings.density;
    this.graphColorScheme = settings.graphColorScheme;
    this.graphColorSchemeAuto = settings.graphColorSchemeAuto;
    this.systemHighContrast = settings.systemHighContrast;
    this.defaultBranchName = settings.defaultBranchName;
    this.defaultClonePath = settings.defaultClonePath;
    this.showAvatars = settings.showAvatars;
    this.showCommitSize = settings.showCommitSize;
    this.wordWrap = settings.wordWrap;
    this.diffIgnoreWhitespace = settings.diffIgnoreWhitespace;
    this.diffContextLines = settings.diffContextLines;
    this.confirmBeforeDiscard = settings.confirmBeforeDiscard;
    this.openLastRepository = settings.openLastRepository;
    this.offlineMode = settings.offlineMode;
    this.confirmNetworkOps = settings.confirmNetworkOps;
    this.remoteAllowlist = settings.remoteAllowlist;
    this.autoStashOnCheckout = settings.autoStashOnCheckout;
    this.alwaysSignOff = settings.alwaysSignOff;
    this.staleBranchDays = settings.staleBranchDays;
    this.networkOperationTimeout = settings.networkOperationTimeout;
    this.autoFetchInterval = settings.autoFetchInterval;
    this.fetchOnFocus = settings.fetchOnFocus;
    this.minimizeToTray = settings.minimizeToTray;
    this.showNativeNotifications = settings.showNativeNotifications;
  }

  /**
   * Switching the language reloads the active locale's templates. Every
   * migrated component re-renders itself off lit-localize's status event, so
   * nothing needs a restart — but the load can fail, and a picker that silently
   * keeps showing a language the app never switched to would be a lie.
   */
  private async handleLanguageChange(e: Event): Promise<void> {
    const select = e.target as HTMLSelectElement;
    const requested = resolveLocale(select.value);
    const applied = await settingsStore.getState().setLanguage(requested);
    this.language = applied;
    if (applied !== requested) {
      select.value = applied;
      showToast(msg('Could not load that language. Keeping the current one.'), 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleThemeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.theme = select.value as Theme;
    settingsStore.getState().setTheme(this.theme);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleFontSizeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.fontSize = select.value as FontSize;
    settingsStore.getState().setFontSize(this.fontSize);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleDensityChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.density = select.value as Density;
    settingsStore.getState().setDensity(this.density);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleGraphColorSchemeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.graphColorScheme = select.value as GraphColorScheme;
    // Picking a scheme by hand pins it — the OS high-contrast watcher stops
    // overriding it from here on.
    settingsStore.getState().setGraphColorScheme(this.graphColorScheme);
    this.graphColorSchemeAuto = settingsStore.getState().graphColorSchemeAuto;
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleBranchNameChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.defaultBranchName = input.value;
    settingsStore.getState().setDefaultBranchName(this.defaultBranchName);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleDefaultClonePathChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.defaultClonePath = input.value;
    settingsStore.getState().setDefaultClonePath(this.defaultClonePath);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private async handleBrowseDefaultClonePath(): Promise<void> {
    const path = await openCloneDestinationDialog(this.defaultClonePath || undefined);
    if (path) {
      this.defaultClonePath = path;
      settingsStore.getState().setDefaultClonePath(path);
      window.dispatchEvent(new CustomEvent('settings-changed'));
    }
  }

  private async loadExternalToolsConfig(): Promise<void> {
    const repo = repositoryStore.getState().getActiveRepository();
    if (!repo) return;

    this.loadingTools = true;
    try {
      const path = repo.repository.path;
      const [mergeConfig, diffConfig, mergeTools, diffTools] = await Promise.all([
        gitService.getMergeToolConfig(path),
        gitService.getDiffToolConfig(path),
        gitService.getAvailableMergeTools(),
        gitService.listDiffTools(path),
      ]);

      if (mergeConfig.success && mergeConfig.data) {
        this.mergeToolName = mergeConfig.data.toolName;
        this.mergeToolCmd = mergeConfig.data.toolCmd;
      }
      if (diffConfig.success && diffConfig.data) {
        this.diffToolName = diffConfig.data.tool;
        this.diffToolCmd = diffConfig.data.cmd;
      }
      if (mergeTools.success && mergeTools.data) {
        this.availableMergeTools = mergeTools.data;
      }
      if (diffTools.success && diffTools.data) {
        this.availableDiffTools = diffTools.data;
      }
    } catch (err) {
      console.error('Failed to load external tools config:', err);
      showToast(
        `Failed to load external tools config: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      this.loadingTools = false;
    }
  }

  private async handleMergeToolChange(e: Event): Promise<void> {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    const token = ++this.mergeToolWriteToken;
    const repo = repositoryStore.getState().getActiveRepository();
    if (!repo) return;

    if (value === '') {
      // "None" must actually clear merge.tool in the repo config. Clearing only
      // local state leaves git (and launch_merge_tool) on the old tool, and the
      // next loadExternalToolsConfig() reads it back, undoing the user's choice.
      const result = await gitService.unsetGitConfig(repo.repository.path, 'merge.tool');
      if (!result.success) {
        // A newer change already owns the control and reports its own outcome,
        // so this stale failure must not roll it back.
        if (token !== this.mergeToolWriteToken) return;
        // Keep the select showing the tool that is still configured.
        select.value = this.mergeToolName ?? '';
        showToast(result.error?.message ?? 'Failed to clear merge tool', 'error');
        return;
      }
      // A newer change already owns the control and reports its own outcome,
      // so this stale response must not overwrite it.
      if (token !== this.mergeToolWriteToken) return;
      // The unset only touches this repository's config, but the dialog shows —
      // and launch_merge_tool uses — the effective value. A merge.tool inherited
      // from the global/system config survives, so re-read before claiming it is
      // gone; otherwise the UI says "None" while git still launches the tool.
      const remaining = await gitService.getMergeToolConfig(repo.repository.path);
      if (token !== this.mergeToolWriteToken) return;
      if (remaining.success && remaining.data?.toolName) {
        this.mergeToolName = remaining.data.toolName;
        this.mergeToolCmd = remaining.data.toolCmd;
        select.value = remaining.data.toolName;
        showToast(
          `merge.tool is still set to "${remaining.data.toolName}" outside this repository ` +
            `(global or system git config); clear it there to use no merge tool.`,
          'error',
        );
        return;
      }
      this.mergeToolName = null;
      this.mergeToolCmd = null;
      window.dispatchEvent(new CustomEvent('settings-changed'));
      return;
    }

    if (value === '__custom__') {
      this.mergeToolName = '__custom__';
      this.mergeToolCmd = '';
      return;
    }

    const previousName = this.mergeToolName;
    const previousCmd = this.mergeToolCmd;
    this.mergeToolName = value;
    this.mergeToolCmd = null;
    const result = await gitService.setMergeToolConfig(repo.repository.path, value);
    if (!result.success) {
      // A newer change already owns the control and reports its own outcome,
      // so this stale failure must not roll it back.
      if (token !== this.mergeToolWriteToken) return;
      // The write never landed, so put the control back on what git still holds
      // instead of letting the choice silently snap back on the next open.
      this.mergeToolName = previousName;
      this.mergeToolCmd = previousCmd;
      select.value = previousName ?? '';
      showToast(
        `Failed to save merge tool: ${result.error?.message ?? 'Unknown error'}`,
        'error',
      );
      return;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private async handleMergeToolCmdChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const token = ++this.mergeToolWriteToken;
    const previousCmd = this.mergeToolCmd;
    this.mergeToolCmd = input.value;
    const repo = repositoryStore.getState().getActiveRepository();
    if (!repo || !this.mergeToolCmd) return;

    const result = await gitService.setMergeToolConfig(
      repo.repository.path,
      'custom',
      this.mergeToolCmd,
    );
    if (!result.success) {
      // A newer change already owns the control and reports its own outcome,
      // so this stale failure must not roll it back.
      if (token !== this.mergeToolWriteToken) return;
      // Keep mergeToolName on '__custom__' so the command row stays on screen
      // and the user can retry rather than hitting a dead end.
      this.mergeToolCmd = previousCmd;
      input.value = previousCmd ?? '';
      showToast(
        `Failed to save merge tool command: ${result.error?.message ?? 'Unknown error'}`,
        'error',
      );
      return;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private async handleDiffToolChange(e: Event): Promise<void> {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    const token = ++this.diffToolWriteToken;
    const repo = repositoryStore.getState().getActiveRepository();
    if (!repo) return;

    if (value === '') {
      // "None" must actually clear diff.tool in the repo config, otherwise git
      // (and launch_diff_tool) keeps using the old tool and reopening Settings
      // reloads it, silently reverting the user's choice.
      const result = await gitService.unsetGitConfig(repo.repository.path, 'diff.tool');
      if (!result.success) {
        // A newer change already owns the control and reports its own outcome,
        // so this stale failure must not roll it back.
        if (token !== this.diffToolWriteToken) return;
        // Keep the select showing the tool that is still configured.
        select.value = this.diffToolName ?? '';
        showToast(result.error?.message ?? 'Failed to clear diff tool', 'error');
        return;
      }
      // A newer change already owns the control and reports its own outcome,
      // so this stale response must not overwrite it.
      if (token !== this.diffToolWriteToken) return;
      // As above: the unset is repository-local while the dialog and
      // launch_diff_tool read the effective value, so a diff.tool inherited from
      // a wider scope survives and must be reported rather than shown as "None".
      const remaining = await gitService.getDiffToolConfig(repo.repository.path);
      if (token !== this.diffToolWriteToken) return;
      if (remaining.success && remaining.data?.tool) {
        this.diffToolName = remaining.data.tool;
        this.diffToolCmd = remaining.data.cmd;
        select.value = remaining.data.tool;
        showToast(
          `diff.tool is still set to "${remaining.data.tool}" outside this repository ` +
            `(global or system git config); clear it there to use no diff tool.`,
          'error',
        );
        return;
      }
      this.diffToolName = null;
      this.diffToolCmd = null;
      window.dispatchEvent(new CustomEvent('settings-changed'));
      return;
    }

    if (value === '__custom__') {
      this.diffToolName = '__custom__';
      this.diffToolCmd = '';
      return;
    }

    const previousName = this.diffToolName;
    const previousCmd = this.diffToolCmd;
    this.diffToolName = value;
    this.diffToolCmd = null;
    const result = await gitService.setDiffTool(repo.repository.path, value);
    if (!result.success) {
      // A newer change already owns the control and reports its own outcome,
      // so this stale failure must not roll it back.
      if (token !== this.diffToolWriteToken) return;
      // The write never landed, so put the control back on what git still holds
      // instead of letting the choice silently snap back on the next open.
      this.diffToolName = previousName;
      this.diffToolCmd = previousCmd;
      select.value = previousName ?? '';
      showToast(
        `Failed to save diff tool: ${result.error?.message ?? 'Unknown error'}`,
        'error',
      );
      return;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private async handleDiffToolCmdChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const token = ++this.diffToolWriteToken;
    const previousCmd = this.diffToolCmd;
    this.diffToolCmd = input.value;
    const repo = repositoryStore.getState().getActiveRepository();
    if (!repo || !this.diffToolCmd) return;

    const result = await gitService.setDiffTool(
      repo.repository.path,
      'custom',
      this.diffToolCmd,
    );
    if (!result.success) {
      // A newer change already owns the control and reports its own outcome,
      // so this stale failure must not roll it back.
      if (token !== this.diffToolWriteToken) return;
      // Keep diffToolName on '__custom__' so the command row stays on screen
      // and the user can retry rather than hitting a dead end.
      this.diffToolCmd = previousCmd;
      input.value = previousCmd ?? '';
      showToast(
        `Failed to save diff tool command: ${result.error?.message ?? 'Unknown error'}`,
        'error',
      );
      return;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleStaleBranchDaysChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const value = Math.max(0, parseInt(input.value, 10) || 0);
    this.staleBranchDays = value;
    settingsStore.getState().setStaleBranchDays(value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleNetworkOperationTimeoutChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const value = Math.max(0, parseInt(input.value, 10) || 0);
    this.networkOperationTimeout = value;
    settingsStore.getState().setNetworkOperationTimeout(value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  /**
   * Diff render options. The diff view's toolbar writes the same two settings
   * and re-reads them from the store, so a change here shows up in an open diff
   * immediately — there is no second copy of either preference.
   */
  private handleDiffIgnoreWhitespaceChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const mode = select.value as DiffWhitespaceMode;
    this.diffIgnoreWhitespace = mode;
    settingsStore.getState().setDiffIgnoreWhitespace(mode);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleDiffContextLinesChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const value = clampDiffContextLines(parseInt(input.value, 10));
    // Write the clamped number back so an out-of-range entry does not sit in
    // the field claiming to be in effect.
    input.value = String(value);
    this.diffContextLines = value;
    settingsStore.getState().setDiffContextLines(value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  private handleAutoFetchIntervalChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const value = Math.max(0, parseInt(input.value, 10) || 0);
    this.autoFetchInterval = value;
    settingsStore.getState().setAutoFetchInterval(value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  }

  /** Comma-separated in the UI, string[] in the store. Empty means "no
   * allowlist" — the gate only filters when the list is non-empty. */
  private handleRemoteAllowlistChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const domains = input.value
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    this.remoteAllowlist = domains;
    settingsStore.getState().setRemoteAllowlist(domains);
    window.dispatchEvent(new CustomEvent('settings-changed'));
    // The allowlist decides whether a cloud AI provider may be reached, so the
    // surfaces that cache "is AI available" have to re-ask. They listen for
    // `ai-settings-changed`; nothing listens to `settings-changed` for this.
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }

  private handleToggle(setting: string, value: boolean): void {
    const store = settingsStore.getState();

    switch (setting) {
      case 'showAvatars':
        this.showAvatars = value;
        store.setShowAvatars(value);
        break;
      case 'showCommitSize':
        this.showCommitSize = value;
        store.setShowCommitSize(value);
        break;
      case 'wordWrap':
        this.wordWrap = value;
        store.setWordWrap(value);
        break;
      case 'confirmBeforeDiscard':
        this.confirmBeforeDiscard = value;
        store.setConfirmBeforeDiscard(value);
        break;
      case 'openLastRepository':
        this.openLastRepository = value;
        store.setOpenLastRepository(value);
        break;
      case 'offlineMode':
        this.offlineMode = value;
        store.setOfflineMode(value);
        break;
      case 'confirmNetworkOps':
        this.confirmNetworkOps = value;
        store.setConfirmNetworkOps(value);
        break;
      case 'autoStashOnCheckout':
        this.autoStashOnCheckout = value;
        store.setAutoStashOnCheckout(value);
        break;
      case 'alwaysSignOff':
        this.alwaysSignOff = value;
        store.setAlwaysSignOff(value);
        break;
      case 'fetchOnFocus':
        this.fetchOnFocus = value;
        store.setFetchOnFocus(value);
        break;
      case 'minimizeToTray':
        this.minimizeToTray = value;
        store.setMinimizeToTray(value);
        break;
      case 'showNativeNotifications':
        this.showNativeNotifications = value;
        store.setShowNativeNotifications(value);
        break;
    }
    window.dispatchEvent(new CustomEvent('settings-changed'));
    // Offline mode decides whether a cloud AI provider may be reached, so the
    // Generate / Vibe Check / AI-resolve surfaces have to re-ask rather than
    // keep offering a button the gate is now guaranteed to refuse.
    if (setting === 'offlineMode') {
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    }
  }

  // =====================================================
  // Local AI Methods
  // =====================================================

  private async loadLocalAiData(): Promise<void> {
    const [capsResult, modelsResult, downloadedResult, recommendedResult, statusResult, nameResult] = await Promise.all([
      localAiService.getSystemCapabilities(),
      localAiService.getAvailableModels(),
      localAiService.getDownloadedModels(),
      localAiService.getRecommendedModel(),
      localAiService.getModelStatus(),
      localAiService.getLoadedModelName(),
    ]);

    if (capsResult.success && capsResult.data) {
      this.systemCapabilities = capsResult.data;
    }
    if (modelsResult.success && modelsResult.data) {
      this.availableModels = modelsResult.data;
    }
    if (downloadedResult.success && downloadedResult.data) {
      this.downloadedModels = downloadedResult.data;
    }
    if (recommendedResult.success && recommendedResult.data !== undefined) {
      this.recommendedModel = recommendedResult.data;
    }
    if (statusResult.success && statusResult.data !== undefined) {
      this.localModelStatus = statusResult.data;
    }
    if (nameResult.success) {
      this.loadedModelName = nameResult.data ?? null;
    }
  }

  private async setupDownloadListeners(): Promise<void> {
    this.downloadProgressUnlisten = await listen<DownloadProgress>('model-download-progress', (event) => {
      this.downloadProgress = {
        ...this.downloadProgress,
        [event.payload.modelId]: event.payload,
      };
    });

    this.downloadCompleteUnlisten = await listen<{ modelId: string; loaded?: boolean; loadError?: string }>('model-download-complete', (event) => {
      // Remove from progress tracking and refresh the model list
      const { [event.payload.modelId]: _, ...rest } = this.downloadProgress;
      this.downloadProgress = rest;
      this.loadLocalAiData();

      // If the model was auto-loaded, refresh provider list and notify other components
      if (event.payload.loaded) {
        this.loadAiProviders();
        window.dispatchEvent(new CustomEvent('ai-settings-changed'));
      } else if (event.payload.loaded === false) {
        // The download succeeded but the engine refused the model - the user
        // still has no AI, so say so instead of silently refreshing the list.
        this.aiError = `Loading failed for ${event.payload.modelId}: ${event.payload.loadError ?? 'unknown error'}`;
      }
    });

    this.downloadErrorUnlisten = await listen<{ modelId: string; error: string }>('model-download-error', (event) => {
      this.aiError = `Download failed for ${event.payload.modelId}: ${event.payload.error}`;
      // Remove from progress tracking and refresh downloaded models list
      const { [event.payload.modelId]: _, ...rest } = this.downloadProgress;
      this.downloadProgress = rest;
      this.loadLocalAiData();
    });
  }

  private async handleDownloadModel(modelId: string): Promise<void> {
    this.aiError = null;
    const result = await localAiService.downloadModel(modelId);
    if (!result.success) {
      this.aiError = result.error?.message ?? 'Failed to start download';
    }
  }

  private async handleCancelDownload(modelId: string): Promise<void> {
    this.aiError = null;
    const result = await localAiService.cancelModelDownload(modelId);
    // If the cancel failed, keep the progress entry (the download is still
    // running) and surface the error instead of silently dropping the UI row.
    if (!result.success) {
      this.aiError = result.error?.message ?? 'Failed to cancel download';
      return;
    }
    const { [modelId]: _, ...rest } = this.downloadProgress;
    this.downloadProgress = rest;
    await this.loadLocalAiData();
  }

  private async handleDeleteModel(modelId: string): Promise<void> {
    this.aiError = null;
    // Unload first if this model is currently loaded
    if (this.localModelStatus === 'ready') {
      await localAiService.unloadModel();
    }
    const result = await localAiService.deleteModel(modelId);
    if (result.success) {
      await Promise.all([this.loadLocalAiData(), this.loadAiProviders()]);
      // Deleting a model changes what the local provider can answer with, and
      // `deleteModel` — unlike load/unload — makes no announcement of its own.
      // The AI surfaces cache availability and listen only to this event.
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } else {
      this.aiError = result.error?.message ?? 'Failed to delete model';
    }
  }

  private async handleLoadModel(modelId: string): Promise<void> {
    this.aiError = null;
    this.localModelStatus = 'loading';
    this.loadingModelId = modelId;
    const result = await localAiService.loadModel(modelId);
    this.loadingModelId = null;
    if (result.success) {
      // localAiService.loadModel already announces `ai-settings-changed`.
      await Promise.all([this.loadLocalAiData(), this.loadAiProviders()]);
    } else {
      this.aiError = result.error?.message ?? 'Failed to load model';
      await this.loadLocalAiData();
    }
  }

  private async handleUnloadModel(): Promise<void> {
    this.aiError = null;
    const result = await localAiService.unloadModel();
    if (result.success) {
      // localAiService.unloadModel already announces `ai-settings-changed`.
      await Promise.all([this.loadLocalAiData(), this.loadAiProviders()]);
    } else {
      this.aiError = result.error?.message ?? 'Failed to unload model';
    }
  }

  private isModelDownloaded(modelId: string): boolean {
    return this.downloadedModels.some(m => m.id === modelId);
  }

  private isModelDownloading(modelId: string): boolean {
    return modelId in this.downloadProgress;
  }

  // =====================================================
  // MCP Methods
  // =====================================================

  private async loadMcpStatus(): Promise<void> {
    const [statusResult, configResult] = await Promise.all([
      mcpService.getMcpStatus(),
      mcpService.getMcpConfig(),
    ]);

    if (statusResult.success && statusResult.data) {
      this.mcpStatus = statusResult.data;
    }
    if (configResult.success && configResult.data) {
      this.mcpPort = configResult.data.port;
      this.mcpEnabled = configResult.data.enabled;
      this.mcpToken = configResult.data.authToken ?? '';
      this.mcpAllowedOrigins = configResult.data.allowedOrigins ?? [];
    }
  }

  private async handleMcpToggle(): Promise<void> {
    this.mcpToggling = true;
    this.mcpError = null;

    if (this.mcpStatus.running) {
      const result = await mcpService.stopMcpServer();
      if (!result.success) {
        this.mcpError = result.error?.message ?? 'Failed to stop MCP server';
      }
    } else {
      // Persist the config first so the server comes back on the next launch
      const saved = await mcpService.setMcpConfig({
        enabled: true,
        port: this.mcpPort,
        allowedOrigins: this.mcpAllowedOrigins,
      });
      if (!saved.success) {
        this.mcpError = saved.error?.message ?? 'Failed to save MCP settings';
        this.mcpToggling = false;
        return;
      }
      this.mcpEnabled = true;
      const result = await mcpService.startMcpServer();
      if (!result.success) {
        this.mcpError = result.error?.message ?? 'Failed to start MCP server';
      }
    }

    await this.loadMcpStatus();
    this.mcpToggling = false;
  }

  /**
   * Turn off the launch-time restart for a server that is enabled but not running.
   * `stopMcpServer` rejects when nothing is running, so persisting `enabled: false`
   * is the only way out of a start that keeps failing on every launch.
   */
  private async handleMcpDisable(): Promise<void> {
    this.mcpToggling = true;
    this.mcpError = null;

    const result = await mcpService.setMcpConfig({
      enabled: false,
      port: this.mcpPort,
      allowedOrigins: this.mcpAllowedOrigins,
    });
    if (!result.success) {
      this.mcpError = result.error?.message ?? 'Failed to disable the MCP server';
    }

    await this.loadMcpStatus();
    this.mcpToggling = false;
  }

  private async handleMcpPortChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    this.mcpPort = Math.max(1024, Math.min(65535, parseInt(input.value, 10) || 3001));

    // Persist the port so it survives a restart even while the server is stopped.
    // Keep the saved enabled flag: a server that failed to bind is still enabled,
    // and changing its port must not silently turn off the launch-time restart.
    const result = await mcpService.setMcpConfig({
      enabled: this.mcpEnabled,
      port: this.mcpPort,
      allowedOrigins: this.mcpAllowedOrigins,
    });
    this.mcpError = result.success
      ? null
      : (result.error?.message ?? 'Failed to save MCP port');
  }

  /**
   * The MCP client configuration block a user pastes into Cursor, VS Code or any
   * other MCP client. The token is masked in the rendered snippet; Copy always
   * puts the real one on the clipboard.
   */
  private mcpClientConfigSnippet(reveal: boolean): string {
    const token = reveal ? this.mcpToken : this.maskedMcpToken();
    return JSON.stringify(
      {
        mcpServers: {
          leviathan: {
            url: `http://127.0.0.1:${this.mcpPort}`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    );
  }

  /** The token as shown while it is hidden — never a partial of the real value */
  private maskedMcpToken(): string {
    return this.mcpToken ? '•'.repeat(this.mcpToken.length) : '';
  }

  private handleMcpTokenReveal(): void {
    this.mcpTokenRevealed = !this.mcpTokenRevealed;
  }

  /**
   * Copy a secret to the clipboard, always telling the user what happened.
   * `label` arrives already translated, so it is never case-folded here — a
   * translated noun cannot be lowercased safely in every language.
   */
  private async copyMcpValue(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      showToast(msg(str`${label} copied to clipboard`), 'success');
    } catch {
      showToast(msg(str`Failed to copy ${label} to clipboard`), 'error');
    }
  }

  private async handleMcpTokenCopy(): Promise<void> {
    await this.copyMcpValue(this.mcpToken, msg('MCP access token'));
  }

  private async handleMcpSnippetCopy(): Promise<void> {
    await this.copyMcpValue(this.mcpClientConfigSnippet(true), msg('MCP client configuration'));
  }

  /**
   * Replace the access token. Every client still using the old one starts
   * failing immediately, so the confirmation says so before anything changes.
   */
  private async handleMcpRegenerateToken(): Promise<void> {
    if (this.mcpRegenerating) return;
    this.mcpRegenerating = true;

    try {
      const confirmed = await showConfirm(
        'Regenerate MCP Token',
        'Generate a new MCP access token? Every MCP client configured with the current token will stop working until you paste the new token into its configuration.',
        'warning'
      );
      if (!confirmed) return;

      const result = await mcpService.regenerateMcpToken();
      if (result.success && result.data) {
        this.mcpToken = result.data;
        this.mcpError = null;
        showToast(msg('MCP access token regenerated — update your MCP clients'), 'success');
      } else {
        this.mcpError =
          result.error?.message ?? msg('Failed to regenerate the MCP access token');
        showToast(this.mcpError, 'error');
      }
    } finally {
      this.mcpRegenerating = false;
    }
  }

  private async handleReset(): Promise<void> {
    // Claimed BEFORE the confirm, not after. showConfirm is an IPC round trip
    // that runs before the native dialog takes focus, and this button stays on
    // screen for that whole window, so a flag claimed after the await lets a
    // double-click stack a second prompt for the same reset.
    if (this.resetting) return;
    this.resetting = true;
    try {
      // One click here wipes the remote allowlist, offline mode, the default
      // clone path and every other preference on this screen, with no undo —
      // the same bar as every other destructive action in the app.
      const confirmed = await showConfirm(
        'Reset Settings',
        'Reset all settings to their defaults? This clears the remote allowlist, offline mode, the default clone path and every other preference on this screen.',
        'warning'
      );
      if (!confirmed) return;

      settingsStore.getState().resetToDefaults();
      this.loadSettings();
      // The same notification every other handler in this file performs.
      // app-shell re-renders avatars, commit size, graph colours and
      // stale-branch marking off this event, so without it the rest of the app
      // keeps painting the pre-reset settings until some other setting is
      // touched.
      window.dispatchEvent(new CustomEvent('settings-changed'));
      // The reset clears offline mode and the remote allowlist, which is
      // exactly the state `handleToggle('offlineMode')` and
      // `handleRemoteAllowlistChange` announce with `ai-settings-changed`.
      // The commit panel's Generate / Vibe Check buttons listen ONLY to that
      // event, so without it they keep showing the pre-reset reason ("offline
      // mode is on") for a setting the reset has just turned off.
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
      showToast('Settings reset to defaults', 'success');
    } finally {
      this.resetting = false;
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private handleOpenProfileManager(): void {
    this.dispatchEvent(new CustomEvent('open-profile-manager', {
      bubbles: true,
      composed: true,
    }));
    this.handleClose();
  }

  /**
   * "Show Avatars" is the only setting on this screen that sends data to a
   * third party, so the row says so — a user cannot opt out of something the
   * copy never told them about. Offline Mode and the remote allowlist take the
   * control away, and the row explains which one did it rather than leaving a
   * toggle that silently does nothing.
   *
   * It has its own renderer rather than going through `renderToggleRow` because
   * that row has no disabled state and no place to put the reason.
   */
  private renderShowAvatarsRow(): unknown {
    const reason = avatarBlockedExplanation({
      showAvatars: this.showAvatars,
      offlineMode: this.offlineMode,
      remoteAllowlist: this.remoteAllowlist,
    });
    const description = msg(
      str`Display author avatars in commit nodes. Avatars are fetched from Gravatar (${GRAVATAR_HOST}), a third-party service: each request sends an MD5 hash of the commit author's email address and your IP address. Off by default; Offline Mode disables it.`
    );
    return html`
      <div class="setting-row ${reason ? 'setting-unavailable' : ''}">
        <div class="setting-label">
          <span class="setting-name">${msg('Show Avatars')}</span>
          <span class="setting-description">${description}</span>
          ${reason
            ? html`<span class="setting-unavailable-reason" role="note">${reason}</span>`
            : nothing}
        </div>
        <lv-toggle
          .label=${msg('Show Avatars')}
          .description=${reason ? `${description} ${reason}` : description}
          .checked=${this.showAvatars}
          ?disabled=${reason !== null}
          title=${reason ?? nothing}
          @change=${(e: CustomEvent<{ checked: boolean }>) =>
            this.handleToggle('showAvatars', e.detail.checked)}
        ></lv-toggle>
      </div>
    `;
  }

  /**
   * A labelled boolean setting row. The visible name/description and the
   * switch's accessible name come from the same strings, so the switch can
   * never go unnamed the way the previous bare checkbox did.
   */
  private renderToggleRow(
    name: string,
    description: string,
    checked: boolean,
    setting: string
  ): unknown {
    return html`
      <div class="setting-row">
        <div class="setting-label">
          <span class="setting-name">${name}</span>
          <span class="setting-description">${description}</span>
        </div>
        <lv-toggle
          .label=${name}
          .description=${description}
          .checked=${checked}
          @change=${(e: CustomEvent<{ checked: boolean }>) =>
            this.handleToggle(setting, e.detail.checked)}
        ></lv-toggle>
      </div>
    `;
  }

  render() {
    return html`
      <div class="settings-content">
        <div class="settings-section">
          <div class="section-title">${msg('Appearance')}</div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Language')}</span>
              <span class="setting-description">${msg('Language used across the app. Applies immediately — no restart needed.')}</span>
            </div>
            <select
              id="language-select"
              aria-label=${msg('Language')}
              .value=${this.language}
              @change=${this.handleLanguageChange}
            >
              ${supportedLocales.map(
                (locale) => html`<option value=${locale.code}>${locale.name}</option>`
              )}
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Theme')}</span>
              <span class="setting-description">${msg('Choose your preferred color scheme')}</span>
            </div>
            <select id="theme-select" .value=${this.theme} @change=${this.handleThemeChange}>
              <option value="dark">${msg('Dark')}</option>
              <option value="light">${msg('Light')}</option>
              <option value="system">${msg('System')}</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Font Size')}</span>
              <span class="setting-description">${msg('Adjust the base font size')}</span>
            </div>
            <select id="font-size-select" .value=${this.fontSize} @change=${this.handleFontSizeChange}>
              <option value="small">${msg('Small')}</option>
              <option value="medium">${msg('Medium')}</option>
              <option value="large">${msg('Large')}</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('UI Density')}</span>
              <span class="setting-description">${msg('Adjust spacing and row heights')}</span>
            </div>
            <select id="density-select" .value=${this.density} @change=${this.handleDensityChange}>
              <option value="compact">${msg('Compact')}</option>
              <option value="comfortable">${msg('Comfortable')}</option>
              <option value="spacious">${msg('Spacious')}</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Graph')}</div>

          ${this.renderShowAvatarsRow()}

          ${this.renderToggleRow(
            msg('Show Commit Size'),
            msg('Scale node size based on changes'),
            this.showCommitSize,
            'showCommitSize'
          )}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Graph Color Scheme')}</span>
              <span class="setting-description">
                ${this.graphColorSchemeAuto && this.systemHighContrast
                  ? msg('Following your system high contrast setting — the graph is drawn on a canvas, so it cannot be recolored by the OS. Choose a scheme to override.')
                  : msg('Color palette for branch lanes')}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              ${this.graphColorSchemeAuto && this.systemHighContrast
                ? html`<span class="auto-scheme-note" data-testid="graph-scheme-auto-note">${msg('Auto (high contrast)')}</span>`
                : ''}
              <select
                id="graph-scheme-select"
                aria-label=${msg('Graph color scheme')}
                .value=${this.graphColorScheme}
                @change=${this.handleGraphColorSchemeChange}
              >
                ${getGraphColorSchemes().map(scheme => html`
                  <option value=${scheme.id}>${scheme.name}</option>
                `)}
              </select>
              <div class="color-scheme-preview">
                ${getGraphColorSchemes().find(s => s.id === this.graphColorScheme)?.colors.slice(0, 6).map(color => html`
                  <div class="color-swatch" style="background: ${color}"></div>
                `)}
              </div>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Profiles & Accounts')}</div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Manage profiles and accounts')}</span>
              <span class="setting-description">
                ${msg('Profiles set your git identity per repository. Accounts are shared logins (GitHub, GitLab, Bitbucket, Azure DevOps, OIDC) you assign to profiles.')}
              </span>
            </div>
            <button
              class="primary"
              @click=${this.handleOpenProfileManager}
            >
              ${msg('Open Profiles & Accounts')}
            </button>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Git Defaults')}</div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Default Branch Name')}</span>
              <span class="setting-description">${msg('Used when initializing new repositories')}</span>
            </div>
            <input
              type="text"
              .value=${this.defaultBranchName}
              @change=${this.handleBranchNameChange}
            />
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Default Clone Folder')}</span>
              <span class="setting-description">${msg('Prefilled as the destination when cloning a repository')}</span>
            </div>
            <div class="path-input-group">
              <input
                type="text"
                placeholder=${msg('No default set')}
                .value=${this.defaultClonePath}
                @change=${this.handleDefaultClonePathChange}
              />
              <button
                class="browse-button"
                @click=${this.handleBrowseDefaultClonePath}
              >
                ${msg('Browse...')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Diff')}</div>

          ${this.renderToggleRow(
            msg('Word Wrap'),
            msg('Wrap long lines in diff view'),
            this.wordWrap,
            'wordWrap'
          )}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name" id="diff-whitespace-label">${msg('Whitespace')}</span>
              <span class="setting-description">
                ${msg('How whitespace-only changes are treated when rendering a diff')}
              </span>
            </div>
            <select
              id="diff-whitespace-select"
              aria-labelledby="diff-whitespace-label"
              .value=${this.diffIgnoreWhitespace}
              @change=${this.handleDiffIgnoreWhitespaceChange}
            >
              ${getDiffWhitespaceModes().map(mode => html`
                <option value=${mode.value} ?selected=${mode.value === this.diffIgnoreWhitespace}>
                  ${mode.label}
                </option>
              `)}
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name" id="diff-context-label">${msg('Context Lines')}</span>
              <span class="setting-description">
                ${msg(
                  str`Unchanged lines shown around each change (${MIN_DIFF_CONTEXT_LINES}-${MAX_DIFF_CONTEXT_LINES}, git's default is 3)`
                )}
              </span>
            </div>
            <input
              id="diff-context-lines-input"
              type="number"
              min=${MIN_DIFF_CONTEXT_LINES}
              max=${MAX_DIFF_CONTEXT_LINES}
              step="1"
              aria-labelledby="diff-context-label"
              .value=${String(this.diffContextLines)}
              @change=${this.handleDiffContextLinesChange}
              style="width: 80px;"
            />
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('External Tools')}</div>

          ${repositoryStore.getState().getActiveRepository()
            ? html`
              <div class="setting-row">
                <div class="setting-label">
                  <span class="setting-name">${msg('Merge Tool')}</span>
                  <span class="setting-description">${msg('External tool for resolving merge conflicts')}</span>
                </div>
                <select
                  id="merge-tool-select"
                  .value=${this.mergeToolName ?? ''}
                  @change=${this.handleMergeToolChange}
                  ?disabled=${this.loadingTools}
                >
                  <option value="">${msg('None')}</option>
                  ${this.availableMergeTools.map(tool => html`
                    <option value=${tool.name}>${tool.displayName}${tool.available ? msg(' (available)') : ''}</option>
                  `)}
                  <option value="__custom__">${msg('Custom...')}</option>
                </select>
              </div>

              ${this.mergeToolName === '__custom__' ? html`
                <div class="setting-row">
                  <div class="setting-label">
                    <span class="setting-name">${msg('Merge Tool Command')}</span>
                    <span class="setting-description">${msg('Custom command to launch merge tool')}</span>
                  </div>
                  <input
                    type="text"
                    .value=${this.mergeToolCmd ?? ''}
                    @change=${this.handleMergeToolCmdChange}
                    placeholder=${msg('e.g., /usr/bin/meld $LOCAL $REMOTE $MERGED')}
                  />
                </div>
              ` : nothing}

              <div class="setting-row">
                <div class="setting-label">
                  <span class="setting-name">${msg('Diff Tool')}</span>
                  <span class="setting-description">${msg('External tool for viewing diffs')}</span>
                </div>
                <select
                  id="diff-tool-select"
                  .value=${this.diffToolName ?? ''}
                  @change=${this.handleDiffToolChange}
                  ?disabled=${this.loadingTools}
                >
                  <option value="">${msg('None')}</option>
                  ${this.availableDiffTools.map(tool => html`
                    <option value=${tool.name}>
                      ${tool.name}${tool.available ? msg(' (available)') : ''}
                    </option>
                  `)}
                  <option value="__custom__">${msg('Custom...')}</option>
                </select>
              </div>

              ${this.diffToolName === '__custom__' ? html`
                <div class="setting-row">
                  <div class="setting-label">
                    <span class="setting-name">${msg('Diff Tool Command')}</span>
                    <span class="setting-description">${msg('Custom command to launch diff tool')}</span>
                  </div>
                  <input
                    type="text"
                    .value=${this.diffToolCmd ?? ''}
                    @change=${this.handleDiffToolCmdChange}
                    placeholder=${msg('e.g., /usr/bin/meld $LOCAL $REMOTE')}
                  />
                </div>
              ` : nothing}
            `
            : html`
              <div class="setting-row">
                <div class="setting-label">
                  <span class="setting-description">${msg('Open a repository to configure external tools')}</span>
                </div>
              </div>
            `
          }
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Network & Sync')}</div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Auto-Fetch Interval')}</span>
              <span class="setting-description">${msg('Minutes between automatic fetches (0 to disable)')}</span>
            </div>
            <input
              type="number"
              min="0"
              .value=${String(this.autoFetchInterval)}
              @change=${this.handleAutoFetchIntervalChange}
              style="width: 80px;"
            />
          </div>

          ${this.renderToggleRow(
            msg('Fetch on Window Focus'),
            msg('Automatically fetch when the app window regains focus'),
            this.fetchOnFocus,
            'fetchOnFocus'
          )}
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Security')}</div>

          ${this.renderToggleRow(
            msg('Offline Mode'),
            msg(
              'Block every operation that leaves this machine — fetch, pull, push, clone, tag push, remote prune, LFS, submodules, auto-fetch, provider APIs (pull requests, issues, releases, CI), and cloud AI providers (OpenAI, Anthropic, Google Gemini, GitHub Models). Local AI — Ollama, LM Studio and the embedded model — keeps working.'
            ),
            this.offlineMode,
            'offlineMode'
          )}

          ${this.renderToggleRow(
            msg('Confirm Network Operations'),
            msg('Ask before each git operation that contacts a remote. Background provider lookups are blocked or allowed silently — they are never prompted.'),
            this.confirmNetworkOps,
            'confirmNetworkOps'
          )}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Remote Allowlist')}</span>
              <span class="setting-description">${msg('Comma-separated domains. When set, remotes, provider APIs and cloud AI providers outside the list are blocked. Leave empty to allow all.')}</span>
            </div>
            <input
              type="text"
              .value=${this.remoteAllowlist.join(', ')}
              @change=${this.handleRemoteAllowlistChange}
              placeholder="github.com, gitlab.com"
              style="width: 220px;"
            />
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Behavior')}</div>

          ${this.renderToggleRow(
            msg('Reopen Last Repositories'),
            msg(
              'Reopen the repository tabs from your last session when Leviathan starts. Turn this off to start on the welcome screen — the tabs are remembered, so turning it back on restores them.'
            ),
            this.openLastRepository,
            'openLastRepository'
          )}

          ${this.renderToggleRow(
            msg('Confirm Before Discard'),
            msg('Ask for confirmation when discarding changes. Deleting untracked files always asks.'),
            this.confirmBeforeDiscard,
            'confirmBeforeDiscard'
          )}

          ${this.renderToggleRow(
            msg('Auto-Stash on Checkout'),
            msg('Automatically stash and re-apply changes when switching branches'),
            this.autoStashOnCheckout,
            'autoStashOnCheckout'
          )}

          ${this.renderToggleRow(
            msg('Always Sign Off Commits'),
            msg('Start each new commit message with Sign off enabled, adding a Signed-off-by trailer'),
            this.alwaysSignOff,
            'alwaysSignOff'
          )}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Stale Branch Threshold')}</span>
              <span class="setting-description">${msg('Days without commits before a branch is marked stale (0 to disable)')}</span>
            </div>
            <input
              type="number"
              min="0"
              .value=${String(this.staleBranchDays)}
              @change=${this.handleStaleBranchDaysChange}
              style="width: 80px;"
            />
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Network Operation Timeout')}</span>
              <span class="setting-description">${msg('Seconds before fetch/pull/push operations time out (0 to disable)')}</span>
            </div>
            <input
              type="number"
              min="0"
              .value=${String(this.networkOperationTimeout)}
              @change=${this.handleNetworkOperationTimeoutChange}
              style="width: 80px;"
            />
          </div>

          ${this.renderToggleRow(
            msg('Minimize to Tray'),
            msg('Minimize to system tray instead of closing'),
            this.minimizeToTray,
            'minimizeToTray'
          )}

          ${this.renderToggleRow(
            msg('Native Notifications'),
            msg('Show system notifications for background events'),
            this.showNativeNotifications,
            'showNativeNotifications'
          )}
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('AI Features')}</div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('AI Provider')}</span>
              <span class="setting-description">
                ${msg('Select an AI provider for commit message generation')}
              </span>
            </div>
            <select
              .value=${this.activeProvider || ''}
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                if (value) this.handleProviderSelect(value as AiProviderType);
              }}
            >
              <option value="">${msg('Select provider...')}</option>
              ${this.aiProviders.map(
                (p) => html`
                  <option value=${p.providerType} ?selected=${this.activeProvider === p.providerType}>
                    ${p.name} ${providerStatusLabel(p)}
                  </option>
                `
              )}
            </select>
          </div>

          ${this.aiError ? html`
            <div class="setting-row">
              <span class="error-text">${this.aiError}</span>
            </div>
          ` : nothing}

          ${this.aiProviders.filter(p => p.requiresApiKey).map(provider => {
            const testStatus = this.providerTestStatus[provider.providerType];
            const isTesting = this.testingProvider === provider.providerType;
            return html`
              <div class="setting-row">
                <div class="setting-label">
                  <span class="setting-name">${msg(str`${provider.name} API Key`)}</span>
                  <div class="provider-status-row">
                    ${provider.hasApiKey ? html`
                      <span class="status-indicator configured">
                        <span class="status-dot"></span>
                        ${msg('Configured')}
                      </span>
                    ` : html`
                      <span class="status-indicator not-configured">
                        <span class="status-dot"></span>
                        ${msg('Not configured')}
                      </span>
                    `}
                    ${testStatus === 'success' ? html`
                      <span class="status-indicator configured">
                        ${msg('✓ Working')}
                      </span>
                    ` : testStatus === 'failed' ? html`
                      <span class="status-indicator" style="color: var(--error-color); background: rgba(239, 68, 68, 0.1);">
                        ${msg('✗ Failed')}
                      </span>
                    ` : nothing}
                  </div>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                  <input
                    type="password"
                    placeholder=${provider.hasApiKey ? '••••••••' : msg('Enter API key...')}
                    .value=${this.apiKeyInputs[provider.providerType] || ''}
                    @input=${(e: Event) =>
                      this.handleApiKeyChange(
                        provider.providerType,
                        (e.target as HTMLInputElement).value
                      )}
                    style="width: 180px;"
                  />
                  <button
                    @click=${() => this.handleSaveApiKey(provider.providerType)}
                    ?disabled=${!this.apiKeyInputs[provider.providerType]}
                  >
                    ${msg('Save')}
                  </button>
                  <button
                    @click=${() => this.handleTestProvider(provider.providerType)}
                    ?disabled=${isTesting || !provider.hasApiKey}
                  >
                    ${isTesting ? msg('Testing...') : msg('Test')}
                  </button>
                </div>
              </div>
            `;
          })}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Local Providers')}</span>
              <span class="setting-description">
                ${msg('Ollama and LM Studio are auto-detected when running locally')}
              </span>
            </div>
            <button
              @click=${() => this.loadAiProviders()}
            >
              ${msg('Refresh')}
            </button>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('Local AI Engine')}</div>

          ${this.systemCapabilities ? html`
            <div class="setting-row">
              <div class="setting-label">
                <span class="setting-name">${msg('System')}</span>
                <span class="setting-description">
                  ${msg(str`RAM: ${localAiService.formatBytes(this.systemCapabilities.totalRamBytes)}`)}
                  ${this.systemCapabilities.gpuInfo
                    ? msg(str` | GPU: ${this.systemCapabilities.gpuInfo.name}`)
                    : msg(' | No dedicated GPU detected')}
                  | ${this.systemCapabilities.gpuAccelerationAvailable ? msg('GPU Accelerated') : msg('CPU Only')}
                </span>
              </div>
              <span class="status-indicator ${this.systemCapabilities.recommendedTier !== 'none' ? 'configured' : 'not-configured'}">
                <span class="status-dot"></span>
                ${localAiService.getTierDisplayName(this.systemCapabilities.recommendedTier)}
              </span>
            </div>
          ` : html`
            <div class="setting-row">
              <span class="setting-description">${msg('Detecting system capabilities...')}</span>
            </div>
          `}

          ${this.localModelStatus === 'ready' ? html`
            <div class="setting-row">
              <div class="setting-label">
                <span class="setting-name">${msg('Engine Status')}</span>
                ${this.loadedModelName ? html`
                  <span class="setting-description">${this.loadedModelName}</span>
                ` : nothing}
              </div>
              <span class="status-indicator configured">
                <span class="status-dot"></span>
                ${msg('Model Loaded')}
              </span>
            </div>
          ` : this.localModelStatus === 'loading' ? html`
            <div class="setting-row">
              <div class="setting-label">
                <span class="setting-name">${msg('Engine Status')}</span>
              </div>
              <span class="status-indicator testing">${msg('Loading model...')}</span>
            </div>
          ` : nothing}

          ${this.recommendedModel && !this.isModelDownloaded(this.recommendedModel.id) ? html`
            <div class="setting-row">
              <div class="setting-label">
                <span class="setting-name">${msg(str`Recommended: ${this.recommendedModel.displayName}`)}</span>
                <span class="setting-description">
                  ${msg(str`${localAiService.formatBytes(this.recommendedModel.sizeBytes)} download`)}
                </span>
              </div>
              <button
                class="primary"
                @click=${() => this.handleDownloadModel(this.recommendedModel!.id)}
                ?disabled=${this.isModelDownloading(this.recommendedModel.id)}
              >
                ${this.isModelDownloading(this.recommendedModel.id) ? msg('Downloading...') : msg('Download')}
              </button>
            </div>
          ` : nothing}

          ${this.availableModels.map(model => {
            const downloaded = this.isModelDownloaded(model.id);
            const downloading = this.isModelDownloading(model.id);
            const progress = this.downloadProgress[model.id];
            return html`
              <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div class="setting-label">
                    <span class="setting-name">${model.displayName}</span>
                    <span class="setting-description">
                      ${localAiService.formatBytes(model.sizeBytes)} |
                      ${localAiService.getTierDisplayName(model.tier)} |
                      ${model.architecture}
                    </span>
                  </div>
                  <div style="display: flex; gap: 4px;">
                    ${downloaded ? html`
                      ${this.localModelStatus === 'ready' && this.loadedModelName === model.displayName ? html`
                        <span class="status-indicator configured">${msg('Loaded')}</span>
                        <button @click=${() => this.handleUnloadModel()}>${msg('Unload')}</button>
                      ` : this.loadingModelId === model.id ? html`
                        <span class="status-indicator">${msg('Loading...')}</span>
                      ` : html`
                        <span class="status-indicator">${msg('Downloaded')}</span>
                        <button
                          @click=${() => this.handleLoadModel(model.id)}
                          ?disabled=${this.localModelStatus === 'loading'}
                        >${msg('Load')}</button>
                      `}
                      <button class="danger" @click=${() => this.handleDeleteModel(model.id)}>${msg('Delete')}</button>
                    ` : downloading ? html`
                      <button @click=${() => this.handleCancelDownload(model.id)}>${msg('Cancel')}</button>
                    ` : html`
                      <button @click=${() => this.handleDownloadModel(model.id)}>${msg('Download')}</button>
                    `}
                  </div>
                </div>
                ${downloading && progress ? html`
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: ${progress.progressPercent}%"></div>
                  </div>
                  <span class="progress-text">
                    ${localAiService.formatBytes(progress.downloadedBytes)} / ${localAiService.formatBytes(progress.totalBytes)}
                    (${progress.progressPercent.toFixed(1)}%)
                  </span>
                ` : nothing}
              </div>
            `;
          })}
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('MCP Server')}</div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Context Proxy')}</span>
              <span class="setting-description">
                ${msg('Allow external tools (Cursor, VS Code) to query Git context via MCP. Restarts automatically on launch while enabled.')}
              </span>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span class="status-indicator ${this.mcpStatus.running ? 'configured' : 'not-configured'}">
                <span class="status-dot"></span>
                ${this.mcpStatus.running ? msg('Running') : this.mcpEnabled ? msg('Stopped') : msg('Disabled')}
              </span>
              ${!this.mcpStatus.running && this.mcpEnabled ? html`
                <button
                  class="mcp-disable"
                  @click=${this.handleMcpDisable}
                  ?disabled=${this.mcpToggling}
                >
                  ${msg('Disable')}
                </button>
              ` : nothing}
              <button
                class="mcp-toggle"
                @click=${this.handleMcpToggle}
                ?disabled=${this.mcpToggling}
              >
                ${this.mcpToggling
                  ? '...'
                  : this.mcpStatus.running
                    ? msg('Stop')
                    : this.mcpEnabled
                      ? msg('Retry')
                      : msg('Start')}
              </button>
            </div>
          </div>

          ${this.mcpError ??
          (!this.mcpStatus.running && this.mcpEnabled ? this.mcpStatus.lastError : null)
            ? html`
                <div class="setting-row">
                  <span class="error-text">
                    ${this.mcpError ?? this.mcpStatus.lastError}
                  </span>
                </div>
              `
            : nothing}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Port')}</span>
              <span class="setting-description">
                ${msg('Localhost port for the MCP server')}
              </span>
            </div>
            <input
              type="number"
              min="1024"
              max="65535"
              .value=${String(this.mcpPort)}
              @change=${this.handleMcpPortChange}
              ?disabled=${this.mcpStatus.running}
              style="width: 80px;"
            />
          </div>

          ${this.mcpStatus.running && this.mcpStatus.url ? html`
            <div class="setting-row">
              <div class="setting-label">
                <span class="setting-name">${msg('Connection URL')}</span>
                <span class="setting-description" style="font-family: monospace;">
                  ${this.mcpStatus.url}
                </span>
              </div>
            </div>
          ` : nothing}

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('Access Token')}</span>
              <span class="setting-description">
                ${msg('Every MCP request must send this token. Keep it secret: anyone who has it can read the history and contents of your open repositories.')}
              </span>
            </div>
            <div class="mcp-token-controls">
              <code class="mcp-token-value">
                ${this.mcpToken
                  ? this.mcpTokenRevealed
                    ? this.mcpToken
                    : this.maskedMcpToken()
                  : msg('Not generated yet')}
              </code>
              <button
                class="mcp-token-reveal"
                @click=${this.handleMcpTokenReveal}
                ?disabled=${!this.mcpToken}
              >
                ${this.mcpTokenRevealed ? msg('Hide') : msg('Reveal')}
              </button>
              <button
                class="mcp-token-copy"
                @click=${this.handleMcpTokenCopy}
                ?disabled=${!this.mcpToken}
              >
                ${msg('Copy')}
              </button>
              <button
                class="mcp-token-regenerate"
                @click=${this.handleMcpRegenerateToken}
                ?disabled=${this.mcpRegenerating}
              >
                ${this.mcpRegenerating ? '...' : msg('Regenerate')}
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span class="setting-name">${msg('MCP Client Configuration')}</span>
              <span class="setting-description">
                ${msg('Paste this into your MCP client. A client set up before Leviathan required a token must add the Authorization header, or its requests are refused with 401.')}
              </span>
            </div>
            <button
              class="mcp-snippet-copy"
              @click=${this.handleMcpSnippetCopy}
              ?disabled=${!this.mcpToken}
            >
              ${msg('Copy')}
            </button>
          </div>
          <pre class="mcp-client-config"><code>${this.mcpClientConfigSnippet(
            this.mcpTokenRevealed
          )}</code></pre>
        </div>

        <div class="settings-section">
          <div class="section-title">${msg('About')}</div>

          <div class="setting-row">
            <div class="version-info">
              <span class="version-text">
                ${msg('Version:')} <span class="version-number">${this.appVersion || msg('Loading...')}</span>
              </span>
              ${this.updateStatus === 'checking' ? html`
                <span class="update-status">${msg('Checking for updates...')}</span>
              ` : this.updateStatus === 'available' ? html`
                <span class="update-status available">${msg(str`Update available: v${this.latestVersion}`)}</span>
              ` : this.updateStatus === 'up-to-date' ? html`
                <span class="update-status">${msg("You're up to date!")}</span>
              ` : this.updateStatus === 'failed' ? html`
                <span class="error-text update-error">${this.updateError}</span>
              ` : ''}
            </div>
            <button
              class="check-update-btn"
              @click=${this.handleCheckForUpdate}
              ?disabled=${this.updateStatus === 'checking'}
            >
              ${this.updateStatus === 'checking' ? msg('Checking...') : msg('Check for Updates')}
            </button>
          </div>
        </div>
      </div>

      <div class="footer">
        <button class="danger" @click=${this.handleReset} ?disabled=${this.resetting}>${msg('Reset to Defaults')}</button>
        <button class="primary" @click=${this.handleClose}>${msg('Done')}</button>
      </div>
    `;
  }
}
