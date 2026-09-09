/**
 * Pull Requests sidebar section.
 *
 * Lists the OPEN pull/merge requests for the active repository's detected
 * hosting provider. Deliberately read-only: clicking a row opens the request in
 * the browser, which is exactly what clicking a PR badge on a graph row already
 * does (`lv-graph-canvas.handleClick`), so the two surfaces behave the same.
 *
 * Loading is lazy and cached. The provider APIs are real network calls behind
 * the offline/allowlist gate, so this element fetches ONLY when its section is
 * expanded, keeps the result per repository, and refetches only on an explicit
 * refresh or a `repository-refresh`. Nothing happens at app start while the
 * section is collapsed — which is its default.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { openExternalUrl } from '../../utils/external-link.ts';
import {
  detectPullRequestProvider,
  getProviderToken,
  invalidateProviderDetection,
  listOpenPullRequests,
  type PullRequestProviderTarget,
  type SidebarPullRequest,
} from '../../services/pull-request.service.ts';

/**
 * Every state this section can be in. They are mutually exclusive and each one
 * renders something the user can act on — an empty list is never used to stand
 * in for "not connected", "offline" or "failed".
 */
type ListState =
  | 'idle'
  | 'loading'
  | 'no-provider'
  | 'offline'
  | 'blocked'
  | 'unauthenticated'
  | 'error'
  | 'ready';

/** What a completed load produced, cached per repository path. */
interface CacheEntry {
  state: ListState;
  target: PullRequestProviderTarget | null;
  pullRequests: SidebarPullRequest[];
  errorMessage: string | null;
}

@customElement('lv-pull-request-list')
export class LvPullRequestList extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: block;
      }

      .pr-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard focus
         ring inside the row so the scroll container cannot clip it.

         The row is an <a href> so assistive tech announces a link that opens
         the pull request, and the anchor is stripped back to look exactly like
         the plain row it replaced. */
      .pr-item {
        --lv-focus-ring-offset: -2px;
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 3px 12px;
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: inherit;
        text-decoration: none;
        box-sizing: border-box;
        width: 100%;
      }

      .pr-item:hover {
        background: var(--color-bg-hover);
      }

      .pr-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        margin-top: 2px;
        color: var(--color-success);
      }

      .pr-icon.draft {
        color: var(--color-text-muted);
      }

      .pr-body {
        min-width: 0;
        flex: 1;
      }

      .pr-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pr-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pr-number {
        font-family: var(--font-family-mono);
      }

      .pr-badge {
        flex-shrink: 0;
        padding: 0 4px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .pr-badge.conflicts {
        border-color: var(--color-error);
        color: var(--color-error);
      }

      .notice {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) 12px;
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .notice.error-notice {
        color: var(--color-error);
      }

      .notice-message {
        overflow-wrap: anywhere;
      }

      .empty {
        padding: 4px 12px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-style: italic;
      }

      .loading {
        padding: 4px 12px;
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      /* Compact variant of the shared .btn for the sidebar's tighter rhythm. */
      .btn-sm {
        padding: 2px var(--spacing-sm);
        font-size: var(--font-size-xs);
        cursor: pointer;
        border: 1px solid var(--color-border);
      }

      .repo-label {
        padding: 2px 12px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  /**
   * True while the host section is expanded. This is the lazy-load trigger:
   * the element fetches nothing until it flips true, so a collapsed section
   * costs no provider API calls at app start.
   */
  @property({ type: Boolean }) expanded: boolean = false;

  @state() private listState: ListState = 'idle';
  @state() private target: PullRequestProviderTarget | null = null;
  @state() private pullRequests: SidebarPullRequest[] = [];
  @state() private errorMessage: string | null = null;

  /**
   * Completed loads, keyed by repository path. Switching tabs back and forth
   * must not re-hit the provider API: the sidebar is not a live view of the
   * remote, and each call is rate-limited and gated.
   */
  private cache = new Map<string, CacheEntry>();

  /**
   * Per-path load generation. lv-left-panel keeps ONE instance of this element
   * across repository tabs and only rebinds `.repositoryPath`, and Lit does not
   * await an async `updated()` — so a fast A→B→A switch starts overlapping
   * loads with nothing sequencing them. Same shape as lv-tag-list.tagsLoadSeq.
   */
  private loadSeq = new Map<string, number>();

  /** What the profile store last said about this section's answer. */
  private accountSignature = '';
  /**
   * Accounts seen verified at least once in this app run — sticky on purpose,
   * see readAccountSignature.
   */
  private verifiedAccountIds = new Set<string>();
  private unsubscribeAccounts?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);

    // Connecting an account from the "Connect to ..." button opens a dialog
    // that this element never hears back from. Without this subscription the
    // section kept saying "Not connected" after a successful sign-in, which is
    // a dead end: the one action it offers appears to do nothing. The profile
    // store is the signal the sign-in actually landed (and that a disconnect
    // happened, which must put the Connect button back).
    this.accountSignature = this.readAccountSignature();
    this.unsubscribeAccounts = unifiedProfileStore.subscribe(() => {
      const signature = this.readAccountSignature();
      if (signature === this.accountSignature) return;
      this.accountSignature = signature;
      if (!this.repositoryPath) return;
      this.cache.delete(this.repositoryPath);
      if (this.expanded) void this.load();
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
    this.unsubscribeAccounts?.();
    this.unsubscribeAccounts = undefined;
  }

  /**
   * Everything the profile store can cheaply show that changes when this
   * section's answer could change:
   *
   * - which accounts exist (one was added or removed);
   * - which profile is active (it decides which account a provider resolves
   *   to, so switching profiles can connect or disconnect this section with
   *   an identical account id list);
   * - which accounts have been verified — the id list alone cannot see a
   *   credential arriving on an account that already existed, which is
   *   exactly what reconnecting an account whose stored token went missing
   *   does.
   *
   * The verified set is STICKY (it only ever grows) because periodic token
   * validation flips every account connected -> checking -> connected every
   * few minutes; reacting to that would turn a deliberately non-live,
   * rate-limited section into a poller. Only the first verification of an
   * account is new information here. A credential going bad the other way is
   * covered by the states that are not cached (`error`, `unauthenticated`)
   * and by the section's own refresh.
   */
  private readAccountSignature(): string {
    const state = unifiedProfileStore.getState();
    for (const [id, entry] of Object.entries(state.accountConnectionStatus)) {
      if (entry?.status === 'connected') this.verifiedAccountIds.add(id);
    }
    return [
      state.activeProfile?.id ?? '',
      state.accounts.map((a) => a.id).join(','),
      [...this.verifiedAccountIds].sort().join(','),
    ].join('|');
  }

  /**
   * An app-level refresh invalidates the cached list AND the cached provider
   * detection (a remote may have just been added or re-pointed). The refetch
   * only happens while expanded — a collapsed section reloads when it is next
   * opened, which is the whole point of loading lazily.
   */
  private handleRepositoryRefresh = (e: Event): void => {
    const repoPath =
      (e as CustomEvent<{ repoPath?: string }>).detail?.repoPath ?? this.repositoryPath;
    if (!repoPath) return;
    this.cache.delete(repoPath);
    invalidateProviderDetection(repoPath);
    if (repoPath !== this.repositoryPath) return;
    if (this.expanded) {
      void this.load();
    } else {
      // Drop the stale rows now so re-expanding cannot show the previous
      // result for a heartbeat before the fresh load lands.
      this.applyState({
        state: 'idle',
        target: null,
        pullRequests: [],
        errorMessage: null,
      });
    }
  };

  updated(changedProperties: Map<string, unknown>): void {
    const repoChanged = changedProperties.has('repositoryPath');
    if (!repoChanged && !changedProperties.has('expanded')) return;
    // Deferred by a microtask on purpose: setting reactive state synchronously
    // inside updated() makes Lit schedule a second update from within the
    // first, which it warns about. One microtask is imperceptible here.
    queueMicrotask(() => {
      if (repoChanged) {
        // Show the NEW repository's cached result (or nothing): the previous
        // repo's rows are live "open in browser" targets pointing at a
        // different project.
        const cached = this.repositoryPath ? this.cache.get(this.repositoryPath) : undefined;
        this.applyState(
          cached ?? { state: 'idle', target: null, pullRequests: [], errorMessage: null },
        );
      }
      if (this.expanded) void this.load();
    });
  }

  /** Reload from the provider, ignoring any cached result. */
  public async refresh(): Promise<void> {
    if (this.repositoryPath) {
      this.cache.delete(this.repositoryPath);
      invalidateProviderDetection(this.repositoryPath);
    }
    await this.load();
  }

  private applyState(entry: CacheEntry): void {
    this.listState = entry.state;
    this.target = entry.target;
    this.pullRequests = entry.pullRequests;
    this.errorMessage = entry.errorMessage;
    this.dispatchEvent(
      new CustomEvent('pull-request-count-changed', {
        // Only a loaded list has a meaningful count; every other state must
        // clear the header badge rather than leave the last repo's number on it.
        detail: { count: entry.state === 'ready' ? entry.pullRequests.length : 0 },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async load(): Promise<void> {
    if (!this.repositoryPath || !this.expanded) return;

    // Captured before the awaits so a mid-flight tab switch still resolves this
    // result against the repository it was loaded FROM.
    const loadedPath = this.repositoryPath;
    const cached = this.cache.get(loadedPath);
    if (cached) {
      this.applyState(cached);
      return;
    }

    const seq = (this.loadSeq.get(loadedPath) ?? 0) + 1;
    this.loadSeq.set(loadedPath, seq);
    /** Latest load for this path AND this path is still the bound one. */
    const isFresh = (): boolean =>
      this.loadSeq.get(loadedPath) === seq && this.repositoryPath === loadedPath;

    this.listState = 'loading';
    this.errorMessage = null;

    const settle = (entry: CacheEntry): void => {
      if (!isFresh()) return;
      // A failure is not a result, so it is NOT cached: re-opening the section
      // is a natural "try again", and it cannot loop because collapsing and
      // re-expanding is a deliberate gesture. "Not connected" and "offline"
      // are not cached for the same reason and at no cost: reaching either
      // makes no provider API call at all - detection has its own cache, the
      // token is a local lookup, and offline mode is a synchronous settings
      // read - so re-opening the section must be able to see a credential
      // added, or offline mode turned off, since. Caching "offline" made the
      // section keep asserting that offline mode was enabled after the user
      // had disabled it, which is a false statement about their own settings
      // and one nothing here subscribes to correct.
      //
      // "Blocked by the allowlist" IS still cached: recomputing that one costs
      // a provider API call. Its way out is Try again, a repository-refresh,
      // or the section's refresh button.
      if (
        entry.state !== 'error' &&
        entry.state !== 'unauthenticated' &&
        entry.state !== 'offline'
      ) {
        this.cache.set(loadedPath, entry);
      }
      this.applyState(entry);
    };

    try {
      const target = await detectPullRequestProvider(loadedPath);
      if (!isFresh()) return;
      if (!target) {
        settle({ state: 'no-provider', target: null, pullRequests: [], errorMessage: null });
        return;
      }

      // Checked here rather than only reacting to the gate's BLOCKED refusal so
      // the message can name the actual reason. `invokeProviderCommand` refuses
      // silently for background callers like this one, so an unexplained empty
      // list is the alternative.
      if (settingsStore.getState().offlineMode) {
        settle({ state: 'offline', target, pullRequests: [], errorMessage: null });
        return;
      }

      const token = await getProviderToken(target);
      if (!isFresh()) return;
      if (!token) {
        settle({ state: 'unauthenticated', target, pullRequests: [], errorMessage: null });
        return;
      }

      const result = await listOpenPullRequests(target, token);
      if (!isFresh()) return;

      if (result.success) {
        settle({
          state: 'ready',
          target,
          pullRequests: result.data ?? [],
          errorMessage: null,
        });
        return;
      }

      // The security gate refuses silently for provider calls (see
      // invokeProviderCommand), so this branch has to say so itself.
      if (result.error?.code === 'BLOCKED') {
        settle({ state: 'blocked', target, pullRequests: [], errorMessage: null });
        return;
      }

      settle({
        state: 'error',
        target,
        pullRequests: [],
        errorMessage: result.error?.message ?? `Failed to load ${target.itemNounPlural}`,
      });
    } catch (err) {
      if (!isFresh()) return;
      settle({
        state: 'error',
        target: this.target,
        pullRequests: [],
        errorMessage: err instanceof Error ? err.message : 'Failed to load pull requests',
      });
    }
  }

  /**
   * Open in the user's browser rather than following the anchor: the webview
   * has no business navigating away from the app. The href is still real so
   * the row is a link to assistive tech, and so "copy link address" works.
   */
  private handleItemClick(e: MouseEvent, pr: SidebarPullRequest): void {
    e.preventDefault();
    this.handleOpen(pr);
  }

  private handleOpen(pr: SidebarPullRequest): void {
    void openExternalUrl(pr.url);
  }

  /**
   * Enter AND Space, both cancelled. Enter is the anchor's own activation key,
   * so letting the default through would open the pull request twice; Space
   * does nothing on a link at all, and this list has always accepted it.
   */
  private handleItemKeydown(e: KeyboardEvent, pr: SidebarPullRequest): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.handleOpen(pr);
    }
  }

  /** Ask the host to open this provider's dialog so the user can connect. */
  private handleConnect(): void {
    if (!this.target) return;
    this.dispatchEvent(
      new CustomEvent('open-provider-connection', {
        detail: { provider: this.target.provider },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderRetry(label = 'Retry') {
    return html`
      <button class="btn btn-secondary btn-sm" @click=${() => void this.refresh()}>
        ${label}
      </button>
    `;
  }

  private renderBody() {
    const noun = this.target?.itemNounPlural ?? 'pull requests';

    switch (this.listState) {
      case 'idle':
        // Only reachable while collapsed (the section loads on expand), so it
        // renders nothing rather than a state the user can never see.
        return nothing;

      case 'loading':
        return html`<div class="loading">Loading ${noun}...</div>`;

      case 'no-provider':
        return html`
          <div class="notice">
            <span class="notice-message">
              No GitHub, GitLab, Bitbucket or Azure DevOps remote was detected for this
              repository.
            </span>
          </div>
        `;

      case 'offline':
        return html`
          <div class="notice">
            <span class="notice-message">
              ${this.target?.itemNounTitle ?? 'Pull requests'} are unavailable while offline
              mode is enabled. Disable it in Settings &gt; Security.
            </span>
            ${this.renderRetry('Try again')}
          </div>
        `;

      case 'blocked':
        return html`
          <div class="notice">
            <span class="notice-message">
              ${this.target?.providerName ?? 'This provider'} is not in your remote allowlist,
              so its ${noun} cannot be loaded. Update the allowlist in Settings &gt; Security.
            </span>
            ${this.renderRetry('Try again')}
          </div>
        `;

      case 'unauthenticated':
        return html`
          <div class="notice">
            <span class="notice-message">
              Not connected to ${this.target?.providerName ?? 'this provider'}. Connect an
              account to see this repository's ${noun}.
            </span>
            <button class="btn btn-primary btn-sm" @click=${this.handleConnect}>
              Connect to ${this.target?.providerName ?? 'provider'}
            </button>
            <!-- The sign-in happens in a dialog this element never hears back
                 from, so the user always keeps a way to say "I have connected
                 now" — the store subscription covers the cases it can see,
                 this covers the rest. -->
            ${this.renderRetry('Try again')}
          </div>
        `;

      case 'error':
        return html`
          <div class="notice error-notice">
            <span class="notice-message">${this.errorMessage ?? `Failed to load ${noun}`}</span>
            ${this.renderRetry()}
          </div>
        `;

      case 'ready':
        if (this.pullRequests.length === 0) {
          return html`<div class="empty">No open ${noun}</div>`;
        }
        return html`
          ${this.target
            ? html`<div class="repo-label" title=${this.target.repoLabel}>
                ${this.target.repoLabel}
              </div>`
            : nothing}
          <ul class="pr-list" role="list">
            ${repeat(
              this.pullRequests,
              (pr) => pr.key,
              (pr) => html`
                <li class="pr-row" role="listitem">
                  <a
                    class="pr-item"
                    href=${pr.url}
                    rel="noreferrer noopener"
                    aria-label="${pr.title}, #${pr.number}, opens in browser"
                    title="${pr.title} (${pr.sourceBranch} → ${pr.targetBranch}) - opens in your browser"
                    @click=${(e: MouseEvent) => this.handleItemClick(e, pr)}
                    @keydown=${(e: KeyboardEvent) => this.handleItemKeydown(e, pr)}
                  >
                    <svg
                      class="pr-icon ${pr.draft ? 'draft' : ''}"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    >
                      <circle cx="18" cy="18" r="3"></circle>
                      <circle cx="6" cy="6" r="3"></circle>
                      <path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
                      <line x1="6" y1="9" x2="6" y2="21"></line>
                    </svg>
                    <div class="pr-body">
                      <div class="pr-title">${pr.title}</div>
                      <div class="pr-meta">
                        <span class="pr-number">#${pr.number}</span>
                        ${pr.author ? html`<span>${pr.author}</span>` : nothing}
                        <span>${pr.sourceBranch} → ${pr.targetBranch}</span>
                      </div>
                    </div>
                    ${pr.draft ? html`<span class="pr-badge">Draft</span>` : nothing}
                    ${pr.status
                      ? html`<span class="pr-badge conflicts">${pr.status}</span>`
                      : nothing}
                  </a>
                </li>
              `,
            )}
          </ul>
        `;
    }
  }

  render() {
    if (!this.repositoryPath) return nothing;
    return this.renderBody();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-pull-request-list': LvPullRequestList;
  }
}
