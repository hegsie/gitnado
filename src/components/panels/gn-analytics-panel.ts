/**
 * Analytics Panel
 * Shows repository statistics: overview cards, activity timeline,
 * commit patterns, top contributors, and file type breakdown.
 */

import { LitElement, html, css, svg, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { formatFileSize } from '../../utils/format.ts';
import * as gitService from '../../services/git.service.ts';
import type {
  RepoStatistics,
  EnhancedMonthActivity,
  WeekdayActivity,
  EnhancedHourActivity,
  EnhancedContributorStats,
  FileTypeStats,
} from '../../services/git.service.ts';

/** Palette for chart colors — distinct hues that work in both light/dark themes */
const CHART_COLORS = [
  'var(--color-primary)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-danger)',
  '#a78bfa', // purple
  '#f472b6', // pink
  '#38bdf8', // sky
  '#fb923c', // orange
  '#34d399', // emerald
  '#facc15', // yellow
];

@customElement('gn-analytics-panel')
export class GnAnalyticsPanel extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      /* ── Loading / Error / Empty ──────────────────────────── */
      .loading,
      .error,
      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .error {
        color: var(--color-danger);
        flex-direction: column;
        gap: 8px;
      }

      .retry-btn {
        padding: 4px 12px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        border: 1px solid var(--color-border);
      }

      .retry-btn:hover {
        background: var(--color-bg-hover);
      }

      /* ── Section ──────────────────────────────────────────── */
      .section {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        overflow: hidden;
      }

      .section-header {
        padding: 8px 12px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
      }

      .section-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }

      .refresh-btn {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .refresh-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .refresh-btn svg {
        width: 12px;
        height: 12px;
      }

      .refresh-error {
        padding: 6px 10px;
        border: 1px solid var(--color-danger);
        border-radius: var(--radius-sm);
        color: var(--color-danger);
        font-size: var(--font-size-xs);
      }

      .section-body {
        padding: 12px;
      }

      /* ── Overview Cards ───────────────────────────────────── */
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }

      .stat-card {
        padding: 6px 4px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        text-align: center;
        overflow: hidden;
      }

      .stat-value {
        font-size: 14px;
        font-weight: var(--font-weight-bold);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .stat-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: 2px;
      }

      /* ── SVG Charts ───────────────────────────────────────── */
      .chart-container {
        width: 100%;
        overflow-x: auto;
      }

      .chart-container svg {
        display: block;
        width: 100%;
        height: auto;
      }

      .chart-label {
        font-size: 10px;
        fill: var(--color-text-muted);
        font-family: var(--font-family-mono);
      }

      .chart-bar {
        transition: opacity 0.15s;
      }

      .chart-bar:hover {
        opacity: 0.8;
      }

      .chart-pair {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .chart-sub {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .chart-sub-title {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        font-weight: var(--font-weight-medium);
      }

      /* ── Contributors Table ───────────────────────────────── */
      .contributor-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .contributor-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 0;
        font-size: var(--font-size-xs);
        min-width: 0;
      }

      .contributor-row + .contributor-row {
        border-top: 1px solid var(--color-border);
      }

      .contributor-info {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
        min-width: 0;
      }

      .contributor-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
        min-width: 0;
      }

      .contributor-email {
        color: var(--color-text-muted);
        font-size: 10px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .contributor-stats {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-family-mono);
        font-size: 10px;
      }

      .contributor-commits {
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      .contributor-lines {
        display: flex;
        gap: 6px;
        white-space: nowrap;
      }

      .lines-added {
        color: var(--color-success);
      }

      .lines-deleted {
        color: var(--color-danger);
      }

      .contributor-bar-container {
        height: 4px;
        background: var(--color-bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }

      .contributor-bar {
        height: 100%;
        background: var(--color-primary);
        border-radius: 2px;
        min-width: 2px;
      }

      /* ── File Types ───────────────────────────────────────── */
      .file-types-layout {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
      }

      .donut-container {
        display: flex;
        justify-content: center;
      }

      .file-type-list {
        display: flex;
        flex-direction: column;
        gap: 3px;
        font-size: var(--font-size-xs);
        width: 100%;
      }

      .file-type-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .file-type-color {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex-shrink: 0;
      }

      .file-type-ext {
        font-family: var(--font-family-mono);
        color: var(--color-text-primary);
        min-width: 50px;
      }

      .file-type-count {
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string | null = null;

  /**
   * Whether this panel's tab is currently showing. `gn-right-panel` keeps the
   * component mounted inside a `display: none` tab, so a `repository-refresh`
   * that arrives while another tab is up must not pay for a full statistics
   * walk — it is remembered and settled when the tab comes back.
   */
  @property({ type: Boolean }) active = true;

  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private stats: RepoStatistics | null = null;

  private static readonly REFRESH_DEBOUNCE_MS = 300;

  private lastLoadedPath: string | null = null;
  private needsReload = false;
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;

  connectedCallback(): void {
    super.connectedCallback();
    // `repository-refresh` is the broadcast every mutating operation fires
    // (commit, reset, merge, rebase, revert, stash apply). Without it the
    // statistics froze at whatever they were when the repository was opened:
    // this panel is never unmounted, only hidden, so switching tabs never
    // reloaded it either.
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    if (this.repositoryPath) {
      this.loadStats();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
    this.clearPendingReload();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('repositoryPath') && this.repositoryPath && this.repositoryPath !== this.lastLoadedPath) {
      this.loadStats();
      return;
    }
    if (changed.has('active') && this.active && this.needsReload) {
      this.scheduleReload();
    }
  }

  private handleRepositoryRefresh = (): void => {
    if (!this.repositoryPath) return;
    this.needsReload = true;
    if (this.active) {
      this.scheduleReload();
    }
  };

  /**
   * Coalesce a burst of refreshes into a single statistics walk — one user
   * operation can broadcast more than once (this panel's own commit plus
   * app-shell's handleRefresh).
   */
  private scheduleReload(): void {
    this.clearPendingReload();
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null;
      // The tab can be hidden inside the debounce window. Bail out and leave
      // `needsReload` set, so `updated()` re-schedules the walk when Analytics
      // comes back rather than paying for it behind a hidden tab.
      if (!this.active) return;
      void this.loadStats();
    }, GnAnalyticsPanel.REFRESH_DEBOUNCE_MS);
  }

  private clearPendingReload(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
  }

  private handleRefreshClick = (): void => {
    // An explicit click beats any debounce window it may land inside.
    this.clearPendingReload();
    void this.loadStats();
  };

  async loadStats(): Promise<void> {
    if (!this.repositoryPath) return;
    // Another repository's numbers must not sit on screen while the new ones
    // load; a refresh of the SAME repository keeps its charts up.
    if (this.repositoryPath !== this.lastLoadedPath) {
      this.stats = null;
    }
    this.loading = true;
    this.error = null;
    this.needsReload = false;
    this.lastLoadedPath = this.repositoryPath;
    const seq = ++this.loadSeq;

    try {
      const result = await gitService.getRepoStatistics(this.repositoryPath, {
        includeActivity: true,
        includeContributors: true,
        includeFileTypes: true,
      });
      if (seq !== this.loadSeq) return; // superseded by a newer load
      if (result.success && result.data) {
        this.stats = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load statistics';
      }
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.error = (err as Error).message;
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
      }
    }
  }

  render() {
    if (!this.repositoryPath) {
      return html`<div class="empty-state">No repository open</div>`;
    }

    if (!this.stats) {
      if (this.loading) {
        return html`<div class="loading">Loading statistics...</div>`;
      }

      if (this.error) {
        return html`
          <div class="error">
            <span>${this.error}</span>
            <button class="retry-btn" @click=${this.loadStats}>Retry</button>
          </div>
        `;
      }

      return html`<div class="empty-state">No statistics available</div>`;
    }

    return html`
      <div class="content">
        ${this.error
          ? html`<div class="refresh-error" role="alert">Refresh failed: ${this.error}</div>`
          : nothing}
        ${this.renderOverview(this.stats)}
        ${this.stats.activityByMonth ? this.renderTimeline(this.stats.activityByMonth) : nothing}
        ${this.stats.activityByWeekday || this.stats.activityByHour
          ? this.renderPatterns(this.stats.activityByWeekday, this.stats.activityByHour)
          : nothing}
        ${this.stats.topContributors ? this.renderContributors(this.stats.topContributors) : nothing}
        ${this.stats.fileTypes ? this.renderFileTypes(this.stats.fileTypes) : nothing}
      </div>
    `;
  }

  /* ── Overview Cards ─────────────────────────────────────── */

  private renderOverview(s: RepoStatistics) {
    const firstDate = s.firstCommitDate ? new Date(s.firstCommitDate * 1000).toLocaleDateString() : '—';
    const lastDate = s.lastCommitDate ? new Date(s.lastCommitDate * 1000).toLocaleDateString() : '—';
    const size = formatFileSize(s.repoSizeBytes);

    return html`
      <div class="section">
        <div class="section-header section-header-row">
          <span>Overview</span>
          <button
            class="refresh-btn"
            title="Refresh statistics"
            aria-label="Refresh statistics"
            ?disabled=${this.loading}
            aria-busy=${this.loading ? 'true' : 'false'}
            @click=${this.handleRefreshClick}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
          </button>
        </div>
        <div class="section-body">
          <div class="overview-grid">
            ${this.renderCard(this.formatCompactNumber(s.totalCommits), 'Commits')}
            ${this.renderCard(String(s.totalContributors), 'Contributors')}
            ${this.renderCard(String(s.totalBranches), 'Branches')}
            ${this.renderCard(String(s.totalTags), 'Tags')}
            ${this.renderCard(this.formatCompactNumber(s.totalFiles), 'Files')}
            ${this.renderCard(size, 'Repo Size')}
            ${this.renderCard(String(s.repoAgeDays), 'Days Old')}
            ${this.renderCard(firstDate, 'First Commit')}
            ${this.renderCard(lastDate, 'Last Commit')}
          </div>
        </div>
      </div>
    `;
  }

  private renderCard(value: string, label: string) {
    return html`
      <div class="stat-card">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${label}</div>
      </div>
    `;
  }

  /* ── Commit Timeline (bar chart by month) ───────────────── */

  private renderTimeline(months: EnhancedMonthActivity[]) {
    if (months.length === 0) return nothing;

    const maxCommits = Math.max(...months.map((m) => m.commits), 1);
    const barW = 22;
    const gap = 4;
    const chartW = months.length * (barW + gap);
    const chartH = 80;
    const labelH = 16;
    const totalH = chartH + labelH + 6;

    return html`
      <div class="section">
        <div class="section-header">Commit Activity</div>
        <div class="section-body">
          <div class="chart-container">
            <svg viewBox="0 0 ${chartW} ${totalH}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Monthly commit activity chart">
              ${months.map((m, i) => {
                const x = i * (barW + gap);
                const h = (m.commits / maxCommits) * chartH;
                const y = chartH - h;
                const label = `${m.year}-${String(m.month).padStart(2, '0')}`;
                const showLabel = months.length <= 24 || i % Math.ceil(months.length / 24) === 0;
                return svg`
                  <rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${h}"
                    fill="var(--color-primary)" rx="2">
                    <title>${label}: ${m.commits} commits, ${m.authors} authors</title>
                  </rect>
                  ${showLabel
                    ? svg`<text class="chart-label" x="${x + barW / 2}" y="${totalH}" text-anchor="middle">${label.slice(2)}</text>`
                    : nothing}
                `;
              })}
            </svg>
          </div>
        </div>
      </div>
    `;
  }

  /* ── Activity Patterns (weekday + hour) ─────────────────── */

  private renderPatterns(
    weekday: WeekdayActivity[] | null,
    hourly: EnhancedHourActivity[] | null,
  ) {
    return html`
      <div class="section">
        <div class="section-header">Activity Patterns</div>
        <div class="section-body">
          <div class="chart-pair">
            ${weekday
              ? html`
                  <div class="chart-sub">
                    <span class="chart-sub-title">By Day of Week</span>
                    ${this.renderWeekdayChart(weekday)}
                  </div>
                `
              : nothing}
            ${hourly
              ? html`
                  <div class="chart-sub">
                    <span class="chart-sub-title">By Hour (UTC)</span>
                    ${this.renderHourChart(hourly)}
                  </div>
                `
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderWeekdayChart(days: WeekdayActivity[]) {
    const max = Math.max(...days.map((d) => d.commits), 1);
    const barW = 28;
    const gap = 4;
    const chartW = days.length * (barW + gap);
    const chartH = 60;
    const labelH = 16;
    const totalH = chartH + labelH + 6;

    return html`
      <div class="chart-container">
        <svg viewBox="0 0 ${chartW} ${totalH}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Commits by day of week">
          ${days.map((d, i) => {
            const x = i * (barW + gap);
            const h = (d.commits / max) * chartH;
            const y = chartH - h;
            return svg`
              <rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${h}"
                fill="var(--color-success)" rx="2">
                <title>${d.day}: ${d.commits} commits</title>
              </rect>
              <text class="chart-label" x="${x + barW / 2}" y="${totalH}" text-anchor="middle">${d.day.slice(0, 3)}</text>
            `;
          })}
        </svg>
      </div>
    `;
  }

  private renderHourChart(hours: EnhancedHourActivity[]) {
    const max = Math.max(...hours.map((h) => h.commits), 1);
    const barW = 12;
    const gap = 2;
    const chartW = hours.length * (barW + gap);
    const chartH = 60;
    const labelH = 16;
    const totalH = chartH + labelH + 6;

    return html`
      <div class="chart-container">
        <svg viewBox="0 0 ${chartW} ${totalH}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Commits by hour of day">
          ${hours.map((h, i) => {
            const x = i * (barW + gap);
            const barH = (h.commits / max) * chartH;
            const y = chartH - barH;
            const showLabel = i % 3 === 0;
            return svg`
              <rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${barH}"
                fill="var(--color-warning)" rx="1">
                <title>${String(h.hour).padStart(2, '0')}:00 – ${h.commits} commits</title>
              </rect>
              ${showLabel
                ? svg`<text class="chart-label" x="${x + barW / 2}" y="${totalH}" text-anchor="middle">${h.hour}</text>`
                : nothing}
            `;
          })}
        </svg>
      </div>
    `;
  }

  /* ── Top Contributors ───────────────────────────────────── */

  private renderContributors(contributors: EnhancedContributorStats[]) {
    if (contributors.length === 0) return nothing;

    const maxCommits = contributors[0].commits; // already sorted desc

    return html`
      <div class="section">
        <div class="section-header">Top Contributors</div>
        <div class="section-body">
          <div class="contributor-list">
            ${contributors.slice(0, 15).map(
              (c) => html`
                <div class="contributor-row">
                  <div class="contributor-info">
                    <div class="contributor-name">${c.name}</div>
                    <div class="contributor-stats">
                      <span class="contributor-commits">${c.commits} commits</span>
                      <span class="contributor-lines">
                        <span class="lines-added">+${this.formatCompactNumber(c.linesAdded)}</span>
                        <span class="lines-deleted">-${this.formatCompactNumber(c.linesDeleted)}</span>
                      </span>
                    </div>
                  </div>
                  <div class="contributor-email">${c.email}</div>
                  <div class="contributor-bar-container">
                    <div class="contributor-bar" style="width: ${(c.commits / maxCommits) * 100}%"></div>
                  </div>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  /* ── File Types (donut + list) ──────────────────────────── */

  private renderFileTypes(fileTypes: FileTypeStats[]) {
    if (fileTypes.length === 0) return nothing;

    // Group small slices into "Other"
    const topN = 9;
    const top = fileTypes.slice(0, topN);
    const rest = fileTypes.slice(topN);
    const items: { extension: string; fileCount: number; totalLines: number; color: string }[] = top.map(
      (ft, i) => ({ ...ft, color: CHART_COLORS[i % CHART_COLORS.length] }),
    );
    if (rest.length > 0) {
      items.push({
        extension: 'Other',
        fileCount: rest.reduce((s, f) => s + f.fileCount, 0),
        totalLines: rest.reduce((s, f) => s + f.totalLines, 0),
        color: CHART_COLORS[topN % CHART_COLORS.length],
      });
    }

    const total = items.reduce((s, f) => s + f.fileCount, 0);

    return html`
      <div class="section">
        <div class="section-header">File Types</div>
        <div class="section-body">
          <div class="file-types-layout">
            <div class="donut-container">${this.renderDonut(items, total)}</div>
            <div class="file-type-list">
              ${items.map(
                (ft) => html`
                  <div class="file-type-row">
                    <span class="file-type-color" style="background: ${ft.color}"></span>
                    <span class="file-type-ext">${ft.extension}</span>
                    <span class="file-type-count">${ft.fileCount} files</span>
                  </div>
                `,
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderDonut(
    items: { extension: string; fileCount: number; color: string }[],
    total: number,
  ) {
    const r = 40;
    const cx = 50;
    const cy = 50;
    const innerR = 25;
    const size = 100;

    let startAngle = -Math.PI / 2;
    const paths = items.map((item) => {
      const fraction = total > 0 ? item.fileCount / total : 0;
      const angle = fraction * Math.PI * 2;
      const endAngle = startAngle + angle;
      const largeArc = angle > Math.PI ? 1 : 0;

      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const ix1 = cx + innerR * Math.cos(endAngle);
      const iy1 = cy + innerR * Math.sin(endAngle);
      const ix2 = cx + innerR * Math.cos(startAngle);
      const iy2 = cy + innerR * Math.sin(startAngle);

      const d = [
        `M ${x1} ${y1}`,
        `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${ix1} ${iy1}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
        'Z',
      ].join(' ');

      startAngle = endAngle;

      return svg`
        <path d="${d}" fill="${item.color}">
          <title>${item.extension}: ${item.fileCount} files</title>
        </path>
      `;
    });

    return html`
      <svg viewBox="0 0 ${size} ${size}" width="100" height="100" role="img" aria-label="File type distribution">
        ${paths}
      </svg>
    `;
  }

  /* ── Helpers ────────────────────────────────────────────── */

  private formatCompactNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-analytics-panel': GnAnalyticsPanel;
  }
}
