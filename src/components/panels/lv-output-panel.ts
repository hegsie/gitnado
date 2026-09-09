/**
 * Output Panel Component
 * Displays git command output log with timestamp, command, and collapsible output
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import {
  type OutputLogEntry,
  getLogEntries,
  clearLogEntries,
  subscribeOutputLog,
} from '../../services/output-log.service.ts';

// The log store lives in output-log.service.ts (populated by the IPC layer);
// re-export the store API here for existing consumers of this module.
export { logGitCommand, getLogEntries, clearLogEntries } from '../../services/output-log.service.ts';
export type { OutputLogEntry } from '../../services/output-log.service.ts';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Compact duration: `84ms`, `1.2s`, `1m 05s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Marker on a line Gitnado DERIVED rather than executed.
 *
 * Most operations run through libgit2, so no `git` process exists to quote.
 * The panel shows the equivalent command line so the user can see what git was
 * asked to do — but it must never read as though the CLI ran, hence the `≈`
 * and the legend at the foot of the panel.
 */
const SYNTHESIZED_MARK = '≈';

@customElement('lv-output-panel')
export class LvOutputPanel extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      }

      .header-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .clear-btn {
        font-size: var(--font-size-xs);
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .clear-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn {
        font-size: var(--font-size-xs);
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .entries {
        flex: 1;
        overflow-y: auto;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
      }

      .entry {
        border-bottom: 1px solid var(--color-border);
      }

      .entry-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        cursor: pointer;
      }

      .entry-header:hover {
        background: var(--color-bg-hover);
      }

      .expand-icon {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
        color: var(--color-text-muted);
        transition: transform var(--transition-fast);
      }

      .expand-icon.expanded {
        transform: rotate(90deg);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-dot.success {
        background: var(--color-success);
      }

      .status-dot.failure {
        background: var(--color-error);
      }

      .entry-timestamp {
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .entry-command {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--color-text-primary);
      }

      .entry-command.success {
        color: var(--color-text-primary);
      }

      .entry-command.failure {
        color: var(--color-error);
      }

      .entry-duration {
        flex-shrink: 0;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
      }

      /* The ≈ marker on a line derived from a libgit2 operation rather than one
         that really ran. Subdued so an executed command reads as the stronger
         statement it is. */
      .synth-mark {
        flex-shrink: 0;
        color: var(--color-text-muted);
        cursor: help;
      }

      .entry-command.synthesized {
        color: var(--color-text-secondary);
      }

      /* The IPC command behind a synthesised line, so the entry is still
         traceable to the operation the app actually invoked. */
      .entry-ipc {
        flex-shrink: 0;
        color: var(--color-text-muted);
        opacity: 0.8;
      }

      .entry-output {
        padding: var(--spacing-xs) var(--spacing-md) var(--spacing-sm);
        padding-left: calc(var(--spacing-md) + 12px + var(--spacing-sm) + 8px + var(--spacing-sm));
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--color-text-secondary);
        background: var(--color-bg-primary);
        border-top: 1px solid var(--color-border);
        max-height: 200px;
        overflow-y: auto;
      }

      /* A failing command's output is the reason the user opened the panel —
         give it the error colour and a rule so it is findable at a glance. */
      .entry-output.failure {
        color: var(--color-error);
        border-left: 2px solid var(--color-error);
      }

      /* Shown when an entry carries nothing but its exit status, so an
         expanded row is never an empty box the user cannot explain. */
      .entry-output.empty-output {
        color: var(--color-text-muted);
        font-style: italic;
      }

      .legend {
        flex-shrink: 0;
        padding: var(--spacing-xs) var(--spacing-md);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
      }

      .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .entry-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
    `,
  ];

  /** When set (by the app shell), renders a close button that emits `close` */
  @property({ type: Boolean }) closable = false;

  /**
   * When set, only entries for this repository (plus repo-independent
   * entries) are shown — required for multi-repo sessions. Unset shows all.
   */
  @property({ type: String }) repositoryPath = '';

  @state() private entries: ReadonlyArray<OutputLogEntry> = [];
  @state() private expandedEntries = new Set<number>();

  private get visibleEntries(): OutputLogEntry[] {
    if (!this.repositoryPath) return [...this.entries];
    return this.entries.filter(
      (e) => !e.repoPath || e.repoPath === this.repositoryPath,
    );
  }

  willUpdate(changed: Map<string, unknown>): void {
    // Collapse all rows when switching repositories — a different repo shows a
    // different set of entries, so carrying expansion state (keyed by entry id)
    // across the switch would be meaningless.
    if (changed.has('repositoryPath')) {
      this.expandedEntries = new Set();
    }
  }

  private unsubscribeLog?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.entries = getLogEntries();
    this.unsubscribeLog = subscribeOutputLog(this.handleLogUpdate);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeLog?.();
    this.unsubscribeLog = undefined;
  }

  private handleLogUpdate = (): void => {
    this.entries = [...getLogEntries()];
    this.requestUpdate();
  };

  private handleClear(): void {
    // Scope the clear to this panel's repository so clearing repo A's output
    // doesn't wipe repo B's history. When unset (showing all), clears globally.
    clearLogEntries(this.repositoryPath || undefined);
    this.expandedEntries = new Set();
  }

  private toggleEntry(id: number): void {
    const next = new Set(this.expandedEntries);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedEntries = next;
  }

  private renderEntry(entry: OutputLogEntry) {
    // Keyed by stable entry id — array positions shift when entries prepend
    const expanded = this.expandedEntries.has(entry.id);
    const statusClass = entry.success ? 'success' : 'failure';
    // The git line when there is one, otherwise the IPC name — a command with
    // no synthesis is still worth showing, it just says less.
    const line = entry.gitCommand ?? entry.command;
    const synthesized = entry.synthesized === true;
    const duration =
      entry.durationMs === undefined ? '' : formatDuration(entry.durationMs);
    const tooltip = synthesized
      ? `${line}\n\nEquivalent command — Gitnado performed this with libgit2 (IPC: ${entry.command})`
      : line;

    return html`
      <div class="entry">
        <div
          class="entry-header"
          @click=${() => this.toggleEntry(entry.id)}
          title="${tooltip}"
        >
          <svg class="expand-icon ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="status-dot ${statusClass}"></span>
          <span class="entry-timestamp">${formatTimestamp(entry.timestamp)}</span>
          ${synthesized
            ? html`<span
                class="synth-mark"
                aria-label="Equivalent command — performed with libgit2"
                >${SYNTHESIZED_MARK}</span
              >`
            : nothing}
          <span class="entry-command ${statusClass} ${synthesized ? 'synthesized' : ''}"
            >${line}</span
          >
          ${synthesized && entry.gitCommand
            ? html`<span class="entry-ipc">${entry.command}</span>`
            : nothing}
          ${duration ? html`<span class="entry-duration">${duration}</span>` : nothing}
        </div>
        ${expanded
          ? entry.output
            ? html`<div class="entry-output ${statusClass}">${entry.output}</div>`
            : // An entry with no captured output still owes the user an
              // explanation of why the row is empty.
              html`<div class="entry-output empty-output">
                ${entry.success
                  ? 'Completed with no output.'
                  : 'Failed with no output.'}
              </div>`
          : nothing}
      </div>
    `;
  }

  render() {
    const visible = this.visibleEntries;
    const hasSynthesized = visible.some((e) => e.synthesized === true);
    return html`
      <div class="header">
        <span class="header-title">
          Output
          ${visible.length > 0
            ? html`<span class="entry-count">(${visible.length})</span>`
            : nothing}
        </span>
        <div class="header-actions">
          ${visible.length > 0
            ? html`
                <button class="clear-btn" @click=${this.handleClear}>
                  Clear
                </button>
              `
            : nothing}
          ${this.closable
            ? html`
                <button
                  class="close-btn"
                  title="Close output panel"
                  aria-label="Close output panel"
                  @click=${() =>
                    this.dispatchEvent(
                      new CustomEvent('close', { bubbles: true, composed: true })
                    )}
                >
                  ✕
                </button>
              `
            : nothing}
        </div>
      </div>
      <div class="entries">
        ${visible.length === 0
          ? html`<div class="empty">No output yet</div>`
          : visible.map((entry) => this.renderEntry(entry))}
      </div>
      ${hasSynthesized
        ? html`<div class="legend">
            ${SYNTHESIZED_MARK} Gitnado runs these operations with libgit2 —
            the line shown is the equivalent <code>git</code> command, not one
            that was executed.
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-output-panel': LvOutputPanel;
  }
}
