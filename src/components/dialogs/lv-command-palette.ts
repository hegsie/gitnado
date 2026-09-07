/**
 * Command Palette Component
 * Fuzzy finder for all actions (Cmd/Ctrl+P)
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { fuzzyScore, highlightMatch } from '../../utils/fuzzy-search.ts';
import type { Branch, Commit } from '../../types/git.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

export interface PaletteCommand {
  id: string;
  label: string;
  category: 'action' | 'branch' | 'recent' | 'navigation' | 'file' | 'commit';
  icon?: string;
  shortcut?: string;
  action: () => void;
}

@customElement('lv-command-palette')
export class LvCommandPalette extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-modal, 200);
      }

      :host([open]) {
        display: flex;
        justify-content: center;
        padding-top: 15vh;
      }

      .overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .palette {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 600px;
        max-height: 60vh;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }

      .search-container {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
      }

      .search-icon {
        width: 20px;
        height: 20px;
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .search-input {
        flex: 1;
        background: transparent;
        border: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-md);
        outline: none;
      }

      .search-input::placeholder {
        color: var(--color-text-muted);
      }

      .results {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-xs);
      }

      .category {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .command {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .command:hover,
      .command.selected {
        background: var(--color-bg-hover);
      }

      .command.selected {
        background: var(--color-primary);
        color: var(--color-text-inverse);
      }

      .command.selected .command-shortcut {
        background: rgba(255, 255, 255, 0.2);
        color: var(--color-text-inverse);
      }

      .command-icon {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        opacity: 0.7;
      }

      .command-label {
        flex: 1;
        font-size: var(--font-size-sm);
      }

      .command-label mark {
        background: var(--color-warning);
        color: var(--color-text-primary);
        border-radius: 2px;
        padding: 0 1px;
      }

      .command.selected .command-label mark {
        background: rgba(255, 255, 255, 0.3);
        color: inherit;
      }

      .command-shortcut {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        font-family: var(--font-mono);
      }

      .empty {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .footer {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .footer-hint {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .footer-hint kbd {
        padding: 2px 4px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        font-family: var(--font-mono);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  /** Focus owner at open time, restored on close. */
  private previouslyFocused: HTMLElement | null = null;
  @property({ type: Array }) commands: PaletteCommand[] = [];
  @property({ type: Array }) branches: Branch[] = [];
  @property({ type: Array }) files: string[] = [];
  @property({ type: Array }) commits: Commit[] = [];
  /** Tag tips for graph navigation ("Reveal tag X in graph") */
  @property({ type: Array }) tags: Array<{ name: string; oid: string }> = [];

  @state() private searchQuery = '';
  @state() private selectedIndex = 0;
  @state() private filteredCommands: PaletteCommand[] = [];

  @query('.search-input') private searchInput!: HTMLInputElement;

  private recentCommands: string[] = [];

  /**
   * False until a real pointer movement lands on the result list after the
   * palette opens.
   *
   * Chromium dispatches boundary events (mouseover/mouseenter, with no
   * mousemove) at elements that APPEAR under a STATIONARY cursor — verified
   * against Chromium: inserting an element under a parked cursor fires
   * mouseover+mouseenter on the next frame. Opening the palette with the
   * pointer already over where the list lands therefore retargeted the
   * selection, and with no query typed the default list is "Recent", which can
   * hold `Clean working directory` or `Prune Unreachable Objects` — so the very
   * next Enter ran a destructive command the user never pointed at.
   *
   * Hover-to-select stays fully live; it just waits for a movement that
   * actually came from the user.
   */
  private pointerMovedSinceOpen = false;

  /**
   * Escape at the document level, gated on being the topmost overlay.
   *
   * The palette's other key handling hangs off @keydown on the search input,
   * so it only fires once that input has focus — which happens in a rAF after
   * open. app-shell used to paper over the gap with an unconditional
   * `showCommandPalette = false` arm ahead of every other check, but that arm
   * closed the palette even when it was NOT the overlay the user was aiming
   * at. Owning Escape here, stack-gated, is what every other overlay does.
   */
  private handleDocumentKeyDown = (e: KeyboardEvent): void => {
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleDocumentKeyDown);
    this.loadRecentCommands();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleDocumentKeyDown);
    // Withdraw on teardown as every sibling does. Unreachable while the
    // palette is rendered unconditionally, but a leaked entry sits on top
    // of the stack forever and takes Escape away from every dialog below.
    removeOverlay(this);
  }

  updated(changedProps: Map<string, unknown>): void {
    // The palette opens OVER other dialogs, so it must take ownership of
    // Escape while it is up — otherwise dismissing it also dismissed the
    // dialog underneath, discarding whatever the user had built there.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProps.has('open') && this.open) {
      // Remembered so focus can go back where it was. Leaving it in the
      // search input after closing left document focus inside a hidden field:
      // every keydown's composedPath still contained an INPUT, so
      // keyboard.service's in-input bail swallowed EVERY single-key shortcut
      // app-wide until the user happened to click something.
      this.previouslyFocused = document.activeElement as HTMLElement | null;
      this.pointerMovedSinceOpen = false;
      this.searchQuery = '';
      this.selectedIndex = 0;
      this.updateFilteredCommands();
      requestAnimationFrame(() => {
        this.searchInput?.focus();
      });
    }
    if (changedProps.has('open') && !this.open) {
      this.searchInput?.blur();
      const restore = this.previouslyFocused;
      this.previouslyFocused = null;
      if (restore && restore.isConnected) {
        restore.focus();
      }
    }
    if (
      changedProps.has('commands') ||
      changedProps.has('branches') ||
      changedProps.has('files') ||
      changedProps.has('commits') ||
      changedProps.has('tags')
    ) {
      this.updateFilteredCommands();
    }
  }

  private loadRecentCommands(): void {
    try {
      const stored = localStorage.getItem('gitnado-recent-commands');
      this.recentCommands = stored ? JSON.parse(stored) : [];
    } catch {
      this.recentCommands = [];
    }
  }

  private saveRecentCommand(id: string): void {
    this.recentCommands = [id, ...this.recentCommands.filter(c => c !== id)].slice(0, 5);
    localStorage.setItem('gitnado-recent-commands', JSON.stringify(this.recentCommands));
  }

  private getAllCommands(): PaletteCommand[] {
    // The branch you are already on is excluded: "Switch to <current>" is a
    // no-op that still stashes the whole working tree and re-applies it. The
    // sidebar hides it for the same reason.
    const branchCommands: PaletteCommand[] = this.branches
      .filter(branch => !branch.isHead)
      .map(branch => ({
      id: `branch:${branch.name}`,
      label: `Switch to ${branch.name}`,
      category: 'branch' as const,
      icon: 'branch',
      action: () => {
        this.dispatchEvent(new CustomEvent('checkout-branch', {
          detail: { branch: branch.name, repositoryPath: this.repositoryPath },
          bubbles: true,
          composed: true,
        }));
      },
      }));

    // Graph navigation: reveal a branch/tag tip in the commit graph
    const revealBranchCommands: PaletteCommand[] = this.branches
      .filter(branch => branch.targetOid)
      .map(branch => ({
        id: `reveal-branch:${branch.name}`,
        label: `Reveal ${branch.name} in graph`,
        category: 'navigation' as const,
        icon: 'branch',
        action: () => {
          this.dispatchEvent(new CustomEvent('navigate-to-commit', {
            detail: { oid: branch.targetOid, repositoryPath: this.repositoryPath },
            bubbles: true,
            composed: true,
          }));
        },
      }));

    const revealTagCommands: PaletteCommand[] = this.tags.map(tag => ({
      id: `reveal-tag:${tag.name}`,
      label: `Reveal tag ${tag.name} in graph`,
      category: 'navigation' as const,
      icon: 'commit',
      action: () => {
        this.dispatchEvent(new CustomEvent('navigate-to-commit', {
          detail: { oid: tag.oid, repositoryPath: this.repositoryPath },
          bubbles: true,
          composed: true,
        }));
      },
    }));

    const fileCommands: PaletteCommand[] = this.files.map(filePath => ({
      id: `file:${filePath}`,
      label: filePath,
      category: 'file' as const,
      icon: 'file',
      action: () => {
        this.dispatchEvent(new CustomEvent('open-file', {
          detail: { path: filePath, repositoryPath: this.repositoryPath },
          bubbles: true,
          composed: true,
        }));
      },
    }));

    const commitCommands: PaletteCommand[] = this.commits.map(commit => ({
      id: `commit:${commit.oid}`,
      label: `${commit.shortId} ${commit.summary}`,
      category: 'commit' as const,
      icon: 'commit',
      action: () => {
        this.dispatchEvent(new CustomEvent('navigate-to-commit', {
          detail: { oid: commit.oid, repositoryPath: this.repositoryPath },
          bubbles: true,
          composed: true,
        }));
      },
    }));

    return [
      ...this.commands,
      ...branchCommands,
      ...revealBranchCommands,
      ...revealTagCommands,
      ...fileCommands,
      ...commitCommands,
    ];
  }

  private updateFilteredCommands(): void {
    const allCommands = this.getAllCommands();
    const query = this.searchQuery.toLowerCase().trim();
    const includeFileCommit = query.length >= 2;

    if (!query) {
      // Show recent commands first, then action/branch/navigation commands
      // only. Reveal-in-graph entries stay searchable but would double every
      // branch in the default view, so they are excluded here too.
      const baseCommands = allCommands.filter(
        c => c.category !== 'file' && c.category !== 'commit' && !c.id.startsWith('reveal-')
      );
      const recent = this.recentCommands
        .map(id => baseCommands.find(c => c.id === id))
        .filter((c): c is PaletteCommand => c !== undefined)
        .map(c => ({ ...c, category: 'recent' as const }));

      const others = baseCommands.filter(c => !this.recentCommands.includes(c.id));
      this.filteredCommands = [...recent, ...others];
    } else {
      // Filter commands, excluding file/commit when query is too short
      const searchable = includeFileCommit
        ? allCommands
        : allCommands.filter(c => c.category !== 'file' && c.category !== 'commit');

      this.filteredCommands = searchable
        .map(cmd => ({
          cmd,
          score: fuzzyScore(cmd.label, query),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map(({ cmd }) => cmd);
    }

    // Display order IS array order.
    //
    // renderCommands() groups rows by category, but keyboard selection, click,
    // and hover all index into this array. Whenever categories interleave — the
    // default view puts a 'navigation' entry among the actions, and a scored
    // query interleaves every category — the two orders diverged, so from the
    // first category boundary onward each row ran a DIFFERENT command than the
    // one it displayed. The list includes "Clean working directory" and "Run
    // Garbage Collection", so that could destroy work from a benign-looking row.
    this.filteredCommands = this.groupByCategory(this.filteredCommands);

    this.selectedIndex = 0;
  }

  /**
   * Stable-partition commands by category, preserving the first-appearance
   * order of both the categories and the commands within each — the exact
   * grouping renderCommands() applies.
   */
  private groupByCategory(commands: PaletteCommand[]): PaletteCommand[] {
    const grouped = new Map<string, PaletteCommand[]>();
    for (const cmd of commands) {
      const existing = grouped.get(cmd.category);
      if (existing) {
        existing.push(cmd);
      } else {
        grouped.set(cmd.category, [cmd]);
      }
    }
    return [...grouped.values()].flat();
  }


  private handleInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.searchQuery = target.value;
    this.updateFilteredCommands();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
        this.scrollSelectedIntoView();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.scrollSelectedIntoView();
        break;
      case 'Enter':
        e.preventDefault();
        this.executeSelected();
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  private scrollSelectedIntoView(): void {
    const selected = this.shadowRoot?.querySelector('.command.selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private executeSelected(): void {
    const command = this.filteredCommands[this.selectedIndex];
    if (command) {
      this.saveRecentCommand(command.id);
      command.action();
      this.close();
    }
  }

  /**
   * Hover selection. Ignored until the pointer has actually moved over the
   * list since the palette opened — see `pointerMovedSinceOpen`.
   */
  private handleCommandHover(index: number): void {
    if (!this.pointerMovedSinceOpen) return;
    this.selectedIndex = index;
  }

  private handleCommandMove(index: number): void {
    // A mousemove is only ever produced by a real pointer movement, so it both
    // arms hover selection and applies it — the cursor may have been parked on
    // this row since before the palette opened, in which case no further
    // mouseenter is coming.
    this.pointerMovedSinceOpen = true;
    this.selectedIndex = index;
  }

  private handleCommandClick(index: number): void {
    this.selectedIndex = index;
    this.executeSelected();
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private getCommandIcon(icon?: string): unknown {
    switch (icon) {
      case 'branch':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="6" y1="3" x2="6" y2="15"></line>
          <circle cx="18" cy="6" r="3"></circle>
          <circle cx="6" cy="18" r="3"></circle>
          <path d="M18 9a9 9 0 0 1-9 9"></path>
        </svg>`;
      case 'file':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>`;
      case 'commit':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="4"></circle>
          <line x1="1.05" y1="12" x2="7" y2="12"></line>
          <line x1="17.01" y1="12" x2="22.96" y2="12"></line>
        </svg>`;
      case 'fetch':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="8 17 12 21 16 17"></polyline>
          <line x1="12" y1="12" x2="12" y2="21"></line>
          <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"></path>
        </svg>`;
      case 'push':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 7 12 3 8 7"></polyline>
          <line x1="12" y1="3" x2="12" y2="12"></line>
          <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"></path>
        </svg>`;
      case 'pull':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="8 17 12 21 16 17"></polyline>
          <line x1="12" y1="12" x2="12" y2="21"></line>
          <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"></path>
        </svg>`;
      case 'merge':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="18" cy="18" r="3"></circle>
          <circle cx="6" cy="6" r="3"></circle>
          <path d="M6 21V9a9 9 0 0 0 9 9"></path>
        </svg>`;
      case 'stash':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
        </svg>`;
      case 'tag':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
          <line x1="7" y1="7" x2="7.01" y2="7"></line>
        </svg>`;
      case 'settings':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>`;
      case 'refresh':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>`;
      case 'search':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>`;
      case 'github':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
        </svg>`;
      case 'gitlab':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
        </svg>`;
      case 'bitbucket':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M.778 1.211a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.893L.778 1.211zM14.52 15.53H9.522L8.17 8.466h7.561l-1.211 7.064z"/>
        </svg>`;
      case 'azure':
        return html`<svg class="command-icon" viewBox="0 0 18 18" fill="currentColor">
          <path d="M17,4v9.74l-4,3.28-6.2-2.26V17L3.29,12.41l10.23.8V4.44Zm-3.41.49L7.85,1V3.29L2.58,4.84,1,6.87v4.61l2.26,1V6.57Z"/>
        </svg>`;
      case 'key':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
        </svg>`;
      case 'user':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>`;
      case 'globe':
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="2" y1="12" x2="22" y2="12"></line>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
        </svg>`;
      default:
        return html`<svg class="command-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>`;
    }
  }

  private getCategoryLabel(category: string): string {
    switch (category) {
      case 'recent': return 'Recent';
      case 'action': return 'Actions';
      case 'branch': return 'Branches';
      case 'navigation': return 'Navigation';
      case 'file': return 'Files';
      case 'commit': return 'Commits';
      default: return category;
    }
  }

  private renderCommands() {
    if (this.filteredCommands.length === 0) {
      return html`<div class="empty">No matching commands</div>`;
    }

    const grouped = new Map<string, PaletteCommand[]>();
    for (const cmd of this.filteredCommands) {
      const category = cmd.category;
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)!.push(cmd);
    }

    let globalIndex = 0;
    const sections: unknown[] = [];

    for (const [category, commands] of grouped) {
      sections.push(html`<div class="category">${this.getCategoryLabel(category)}</div>`);

      for (const cmd of commands) {
        const index = globalIndex++;
        const highlighted = highlightMatch(cmd.label, this.searchQuery);
        // SAFETY: innerHTML is safe here — highlightMatch() calls escapeHtml() on all text
        // segments before wrapping matched characters in <mark> tags. See fuzzy-search.ts.

        sections.push(html`
          <div
            class="command ${index === this.selectedIndex ? 'selected' : ''}"
            role="option"
            aria-selected=${index === this.selectedIndex}
            @click=${() => this.handleCommandClick(index)}
            @mouseenter=${() => this.handleCommandHover(index)}
            @mousemove=${() => this.handleCommandMove(index)}
          >
            ${this.getCommandIcon(cmd.icon)}
            <span class="command-label" .innerHTML=${highlighted}></span>
            ${cmd.shortcut ? html`<span class="command-shortcut">${cmd.shortcut}</span>` : nothing}
          </div>
        `);
      }
    }

    return sections;
  }

  render() {
    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="palette" role="dialog" aria-label="Command Palette">
        <div class="search-container">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            class="search-input"
            type="text"
            placeholder="Search commands, files, commits..."
            .value=${this.searchQuery}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-autocomplete="list"
            aria-label="Search commands"
          />
        </div>
        <div class="results" id="palette-results" role="listbox">
          ${this.renderCommands()}
        </div>
        <div class="footer">
          <span class="footer-hint"><kbd>↑↓</kbd> navigate</span>
          <span class="footer-hint"><kbd>↵</kbd> select</span>
          <span class="footer-hint"><kbd>esc</kbd> close</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-command-palette': LvCommandPalette;
  }
}
