import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { repositoryStore } from '../../stores/index.ts';
import './lv-branch-list.ts';
import './lv-stash-list.ts';
import './lv-tag-list.ts';
import './lv-pull-request-list.ts';
import './lv-gitflow-panel.ts';
import type { LvPullRequestList } from './lv-pull-request-list.ts';

/**
 * Left panel container component
 * Contains branch list, stashes, and tags
 */
@customElement('lv-left-panel')
export class LvLeftPanel extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .section {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        user-select: none;
        cursor: pointer;
      }

      .section-header:hover {
        background: var(--color-bg-hover);
      }

      .section-header .chevron {
        width: 14px;
        height: 14px;
        transition: transform var(--transition-fast);
        flex-shrink: 0;
      }

      .section-header .chevron.expanded {
        transform: rotate(90deg);
      }

      .section-header .title {
        flex: 1;
      }

      .section-header .count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-weight: var(--font-weight-normal);
      }

      .section-action {
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        cursor: pointer;
        flex-shrink: 0;
        opacity: 0;
        transition: all var(--transition-fast);
      }

      .section-header:hover .section-action {
        opacity: 1;
      }

      .section-action:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .section.collapsed .section-content {
        display: none;
      }

      .section.collapsed {
        flex: 0 0 auto;
        max-height: none;
      }

      .section-content {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .branches-section {
        flex: 1;
        min-height: 100px;
      }

      .refs-section {
        flex: 0 0 auto;
        max-height: 30%;
        border-top: 1px solid var(--color-border);
      }

      .placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }
    `,
  ];

  @state() private repositoryPath: string | null = null;
  @state() private stashCount: number = 0;
  @state() private tagCount: number = 0;
  @state() private pullRequestCount: number = 0;
  @state() private expandedSections = new Set<string>(['branches']);

  private unsubscribe?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    // Get initial state
    const initialState = repositoryStore.getState();
    this.repositoryPath = initialState.getActiveRepository()?.repository.path ?? null;

    // Subscribe to changes
    this.unsubscribe = repositoryStore.subscribe((state) => {
      const activeRepo = state.getActiveRepository();
      this.repositoryPath = activeRepo?.repository.path ?? null;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  render() {
    if (!this.repositoryPath) {
      return html`<div class="placeholder">No repository open</div>`;
    }

    const branchesExpanded = this.expandedSections.has('branches');
    const stashesExpanded = this.expandedSections.has('stashes');
    const tagsExpanded = this.expandedSections.has('tags');
    const pullRequestsExpanded = this.expandedSections.has('pull-requests');
    const gitflowExpanded = this.expandedSections.has('gitflow');

    return html`
      <!-- Branches Section -->
      <section class="section branches-section ${branchesExpanded ? '' : 'collapsed'}">
        <header class="section-header" @click=${() => this.toggleSection('branches')}>
          ${this.renderChevron(branchesExpanded)}
          <span class="title">Branches</span>
        </header>
        <div class="section-content">
          <lv-branch-list
            .repositoryPath=${this.repositoryPath}
            @branch-checkout=${this.handleBranchCheckout}
            @branches-changed=${this.handleBranchesChanged}
          ></lv-branch-list>
        </div>
      </section>

      <!-- Stashes Section - header always visible, like Tags.
           Hiding the whole SECTION at count 0 hid it in exactly the state
           where a user goes looking for it: a dirty tree with nothing stashed
           yet. That also made lv-stash-list's "Stash Changes" button and its
           "No stashes" empty state unreachable, so stashing was keyboard-only
           for anyone who had never stashed before. Only the body is hidden;
           ONE template position, as above, because swapping literals on the
           count rebuilt <lv-stash-list> and anything stateful inside it. -->
      <section class="section refs-section ${stashesExpanded ? '' : 'collapsed'}">
        <header class="section-header" @click=${() => this.toggleSection('stashes')}>
          ${this.renderChevron(stashesExpanded)}
          <span class="title">Stashes</span>
          ${this.stashCount > 0 ? html`<span class="count">${this.stashCount}</span>` : ''}
        </header>
        <div class="section-content">
          <lv-stash-list
            .repositoryPath=${this.repositoryPath}
            @stash-applied=${this.handleStashApplied}
            @stash-created=${this.handleStashCreated}
            @stash-dropped=${this.handleStashDropped}
            @stash-count-changed=${this.handleStashCountChanged}
          ></lv-stash-list>
        </div>
      </section>

      <!-- Tags Section - always show header for discoverability -->
      <section class="section refs-section ${tagsExpanded ? '' : 'collapsed'}">
        <header class="section-header" @click=${() => this.toggleSection('tags')}>
          ${this.renderChevron(tagsExpanded)}
          <span class="title">Tags</span>
          ${this.tagCount > 0 ? html`<span class="count">${this.tagCount}</span>` : ''}
          <button
            class="section-action"
            title="Create tag"
            @click=${this.handleCreateTag}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </header>
        <!-- ONE template position, hidden with CSS when empty. Two separate
             html template literals made lit tear down and rebuild lv-tag-list
             every time the count crossed 0 — taking its embedded create-tag
             dialog with it, mid-edit, with no warning. lv-tag-list and
             lv-branch-list each already carry this exact fix internally; the
             same hazard one level up was never addressed. An external
             "git tag -d" picked up by the watcher is enough to trigger it. -->
        <div
          class="section-content"
          style=${this.tagCount > 0 ? '' : 'display: none;'}
        >
          <lv-tag-list
            .repositoryPath=${this.repositoryPath}
            @tags-changed=${this.handleTagsChanged}
            @tag-checkout=${this.handleTagCheckout}
            @tag-count-changed=${this.handleTagCountChanged}
          ></lv-tag-list>
        </div>
      </section>

      <!-- Pull Requests Section - collapsed by default ON PURPOSE. Its content
           is the only sidebar section backed by a REMOTE API (GitHub / GitLab /
           Bitbucket / Azure DevOps), so it loads only once the user expands it:
           the child's .expanded property is its lazy-load trigger, and nothing
           is fetched at app start. It keeps its own per-repository cache, so
           collapsing and re-expanding costs no further API calls. -->
      <section class="section refs-section ${pullRequestsExpanded ? '' : 'collapsed'}">
        <header class="section-header" @click=${() => this.toggleSection('pull-requests')}>
          ${this.renderChevron(pullRequestsExpanded)}
          <span class="title">Pull Requests</span>
          ${this.pullRequestCount > 0 ? html`<span class="count">${this.pullRequestCount}</span>` : ''}
          ${pullRequestsExpanded ? html`
            <button
              class="section-action"
              title="Refresh pull requests"
              aria-label="Refresh pull requests"
              @click=${this.handleRefreshPullRequests}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
          ` : ''}
        </header>
        <div class="section-content">
          <lv-pull-request-list
            .repositoryPath=${this.repositoryPath}
            .expanded=${pullRequestsExpanded}
            @pull-request-count-changed=${this.handlePullRequestCountChanged}
          ></lv-pull-request-list>
        </div>
      </section>

      <!-- Git Flow Section -->
      <section class="section refs-section ${gitflowExpanded ? '' : 'collapsed'}">
        <header class="section-header" @click=${() => this.toggleSection('gitflow')}>
          ${this.renderChevron(gitflowExpanded)}
          <span class="title">Git Flow</span>
        </header>
        <div class="section-content">
          <lv-gitflow-panel
            .repositoryPath=${this.repositoryPath}
          ></lv-gitflow-panel>
        </div>
      </section>
    `;
  }

  /** Forward the originating repo path (captured pre-await by the sidebar
   * handler) so the host pins the refresh to the repo the operation ran on,
   * not whichever tab is active if the user switched mid-operation. */
  private forwardRefresh(e?: Event): void {
    const repoPath = (e as CustomEvent<{ repositoryPath?: string }> | undefined)?.detail
      ?.repositoryPath;
    this.dispatchEvent(new CustomEvent('repository-changed', { bubbles: true, composed: true }));
    window.dispatchEvent(new CustomEvent('repository-refresh', { detail: { repoPath } }));
  }

  private handleStashApplied(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleStashCreated(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleStashDropped(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleTagCheckout(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleBranchCheckout(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleBranchesChanged(e?: Event): void {
    this.forwardRefresh(e);
  }

  private handleTagsChanged(e?: Event): void {
    this.forwardRefresh(e);
  }

  private toggleSection(section: string): void {
    const newExpanded = new Set(this.expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    this.expandedSections = newExpanded;
  }

  private handleStashCountChanged(e: CustomEvent<{ count: number }>): void {
    this.stashCount = e.detail.count;
  }

  private handleTagCountChanged(e: CustomEvent<{ count: number }>): void {
    this.tagCount = e.detail.count;
  }

  private handlePullRequestCountChanged(e: CustomEvent<{ count: number }>): void {
    this.pullRequestCount = e.detail.count;
  }

  /**
   * Explicit refresh of the pull request list. Called directly on the child
   * rather than dispatched as an event, because this element would be the only
   * possible listener - an event would just be a longer way to reach the same
   * instance.
   */
  private handleRefreshPullRequests(e: Event): void {
    // The button sits inside the header that toggles the section.
    e.stopPropagation();
    const list = this.renderRoot.querySelector('lv-pull-request-list') as LvPullRequestList | null;
    void list?.refresh();
  }

  private handleCreateTag(e: Event): void {
    e.stopPropagation();
    // Dispatch event for app-shell to handle (since the dialog in lv-tag-list may be hidden)
    this.dispatchEvent(new CustomEvent('create-tag', {
      bubbles: true,
      composed: true,
    }));
  }

  private renderChevron(expanded: boolean) {
    return html`
      <svg class="chevron ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-left-panel': LvLeftPanel;
  }
}
