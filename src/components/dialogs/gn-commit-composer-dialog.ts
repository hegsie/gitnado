/**
 * Commit Composer / Recompose (roadmap 4.4, #618).
 *
 * Regroup a branch's recent commits (or the uncommitted changes) into a clean
 * series: the left side shows what exists today, the right side the commits
 * that will replace it. AI can propose the grouping and messages; without AI
 * the plan starts from the original commits and is edited by hand. Applying
 * keeps a one-click undo.
 */
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import { tryAcquireRefOpOrWarn, releaseRefOp } from '../../utils/ref-lock.ts';
import type { RecomposeSource } from '../../services/git/merge-rebase.ts';
import {
  initialPlan,
  moveFile,
  newGroup,
  planFromSuggestion,
  planProblem,
  unassignedFiles,
  type DraftGroup,
} from '../../utils/recompose-plan.ts';
import { GnRepoScopedDialogBase } from './gn-repo-scoped-dialog-base.ts';
import './gn-modal.ts';

type SourceMode = 'range' | 'worktree';

/** A sensible default base: the upstream, else main/master, else the parent commit. */
export function defaultRecomposeBase(repoPath: string): string {
  const repo = repositoryStore.getState().openRepositories.find((r) => r.repository.path === repoPath);
  const current = repo?.currentBranch;
  if (current?.upstream) return current.upstream;
  const names = new Set((repo?.branches ?? []).filter((b) => !b.isRemote).map((b) => b.name));
  for (const trunk of ['main', 'master']) {
    if (names.has(trunk) && current?.name !== trunk) return trunk;
  }
  return 'HEAD~1';
}

@customElement('gn-commit-composer-dialog')
export class GnCommitComposerDialog extends GnRepoScopedDialogBase {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .composer {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        width: min(960px, 90vw);
        max-height: 72vh;
      }
      .source {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
        flex-wrap: wrap;
      }
      input,
      select {
        padding: 2px var(--spacing-xs);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
      }
      .columns {
        display: grid;
        grid-template-columns: minmax(200px, 1fr) 2fr;
        gap: var(--spacing-md);
        overflow: auto;
        min-height: 200px;
      }
      h4 {
        margin: 0 0 var(--spacing-xs);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }
      ol.before {
        margin: 0;
        padding-left: 1.2em;
        font-size: var(--font-size-sm);
      }
      ol.before li {
        margin-bottom: 2px;
      }
      .group {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
      }
      .group-head {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }
      .group-head .num {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      .group-head input {
        flex: 1;
      }
      ul.files {
        list-style: none;
        margin: var(--spacing-xs) 0 0;
        padding: 0;
      }
      ul.files li {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-family: var(--font-mono, monospace);
        font-size: var(--font-size-xs);
        padding: 1px 0;
      }
      ul.files li span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .unassigned {
        border-style: dashed;
      }
      .footer {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .footer .problem {
        margin-right: auto;
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }
      .error {
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }
      .notice {
        font-size: var(--font-size-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .muted {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @state() private mode: SourceMode = 'range';
  @state() private base = '';
  @state() private source: RecomposeSource | null = null;
  @state() private groups: DraftGroup[] = [];
  @state() private loading = false;
  @state() private suggesting = false;
  @state() private applying = false;
  @state() private error: string | null = null;
  @state() private applied: { branch: string; commits: number } | null = null;
  @state() private aiAvailable = false;

  private pinnedRepoPath = '';

  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  public get operationInFlight(): boolean {
    return this.applying;
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      this.mode = 'range';
      this.base = defaultRecomposeBase(this.repositoryPath);
      this.applied = null;
      this.error = null;
      void this.load();
      void aiService.isAiAvailable().then((ok) => { this.aiAvailable = ok; });
    }
  }

  close(): void {
    if (this.applying) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async load(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    this.loading = true;
    this.error = null;
    this.source = null;
    this.groups = [];
    try {
      const result = await gitService.getRecomposeSource(repoPath, this.mode === 'range' ? this.base.trim() || null : null);
      if (repoPath !== this.pinnedRepoPath || !this.open) return;
      if (!result.success || !result.data) {
        this.error = result.error?.message ?? 'Could not read the changes';
        return;
      }
      this.source = result.data;
      this.groups = initialPlan(result.data);
    } finally {
      this.loading = false;
    }
  }

  private async suggest(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.suggesting = true;
    this.error = null;
    try {
      const result = await aiService.suggestRecompose(this.pinnedRepoPath, source.mode === 'range' ? source.baseOid : null);
      if (!result.success || !result.data) {
        this.error = `AI suggestion failed: ${result.error?.message ?? 'Unknown error'}. You can still group the files by hand.`;
        return;
      }
      this.groups = planFromSuggestion(source, result.data.groups);
    } finally {
      this.suggesting = false;
    }
  }

  private async apply(): Promise<void> {
    const source = this.source;
    if (!source || planProblem(source, this.groups)) return;
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;
    this.applying = true;
    this.error = null;
    try {
      const result = await gitService.applyRecompose(
        repoPath,
        source.mode === 'range' ? source.baseOid : null,
        this.groups.map((g) => ({ message: g.message.trim(), files: g.files })),
      );
      if (!result.success || !result.data) {
        this.error = `Recompose failed: ${result.error?.message ?? 'Unknown error'}`;
        showToast(this.error, 'error');
        return;
      }
      this.applied = { branch: result.data.branch, commits: this.groups.length };
      this.dispatchRepoEvent('recompose-applied', repoPath);
      showToast(
        `Recomposed ${result.data.branch} into ${this.groups.length} commit${this.groups.length === 1 ? '' : 's'}`,
        'success',
        8000,
        { label: 'Undo', callback: () => void this.undo() },
      );
    } finally {
      this.applying = false;
      releaseRefOp(repoPath);
    }
  }

  private async undo(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;
    try {
      const result = await gitService.undoRecompose(repoPath);
      if (result.success && result.data) {
        showToast(`Restored ${result.data.branch} to before the recompose`, 'success');
        this.applied = null;
        this.dispatchRepoEvent('recompose-applied', repoPath);
        if (this.open) await this.load();
      } else {
        showToast(`Undo failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      releaseRefOp(repoPath);
    }
  }

  private setMessage(id: number, message: string): void {
    this.groups = this.groups.map((g) => (g.id === id ? { ...g, message } : g));
  }

  private removeGroup(id: number): void {
    this.groups = this.groups.filter((g) => g.id !== id);
  }

  private moveGroup(id: number, delta: number): void {
    const i = this.groups.findIndex((g) => g.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.groups.length) return;
    const next = [...this.groups];
    [next[i], next[j]] = [next[j], next[i]];
    this.groups = next;
  }

  private renderMoveSelect(file: string, currentId: number | null) {
    return html`
      <select
        class="move"
        aria-label="Move ${file} to"
        .value=${currentId === null ? '' : String(currentId)}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          this.groups = moveFile(this.groups, file, v === '' ? null : Number(v));
        }}
      >
        ${this.groups.map((g, i) => html`<option value=${String(g.id)} ?selected=${g.id === currentId}>Commit ${i + 1}</option>`)}
        <option value="" ?selected=${currentId === null}>${this.source?.mode === 'worktree' ? 'Leave uncommitted' : 'Unassigned'}</option>
      </select>
    `;
  }

  private renderBefore() {
    const s = this.source;
    if (!s) return nothing;
    return s.mode === 'range'
      ? html`
          <h4>Now: ${s.commits.length} commit${s.commits.length === 1 ? '' : 's'} on ${s.branch}</h4>
          <ol class="before">${s.commits.map((c) => html`<li title=${c.files.join('\n')}>${c.summary || c.oid.slice(0, 7)}</li>`)}</ol>
        `
      : html`
          <h4>Now: ${s.files.length} uncommitted file${s.files.length === 1 ? '' : 's'}</h4>
          <ul class="files">${s.files.map((f) => html`<li><span>${f.path}</span>${f.status}</li>`)}</ul>
        `;
  }

  private renderAfter() {
    const s = this.source;
    if (!s) return nothing;
    const left = unassignedFiles(s, this.groups);
    return html`
      <h4>After: ${this.groups.length} commit${this.groups.length === 1 ? '' : 's'}</h4>
      ${this.groups.map((g, i) => html`
        <div class="group" data-group=${i}>
          <div class="group-head">
            <span class="num">${i + 1}</span>
            <input
              class="message"
              placeholder="Commit message"
              .value=${g.message}
              @input=${(e: Event) => this.setMessage(g.id, (e.target as HTMLInputElement).value)}
            />
            <button class="btn btn-sm btn-secondary" title="Move up" ?disabled=${i === 0} @click=${() => this.moveGroup(g.id, -1)}>↑</button>
            <button class="btn btn-sm btn-secondary" title="Move down" ?disabled=${i === this.groups.length - 1} @click=${() => this.moveGroup(g.id, 1)}>↓</button>
            <button class="btn btn-sm btn-secondary" data-action="remove-group" title="Remove this commit (its files become unassigned)" @click=${() => this.removeGroup(g.id)}>✕</button>
          </div>
          <ul class="files">
            ${g.files.length === 0 ? html`<li class="muted">No files yet</li>` : nothing}
            ${g.files.map((f) => html`<li data-file=${f}><span>${f}</span>${this.renderMoveSelect(f, g.id)}</li>`)}
          </ul>
        </div>
      `)}
      ${left.length ? html`
        <div class="group unassigned">
          <h4>${s.mode === 'worktree' ? 'Left uncommitted' : 'Unassigned'} (${left.length})</h4>
          <ul class="files">${left.map((f) => html`<li data-file=${f}><span>${f}</span>${this.renderMoveSelect(f, null)}</li>`)}</ul>
        </div>
      ` : nothing}
      <button class="btn btn-sm btn-secondary" data-action="add-group" @click=${() => { this.groups = [...this.groups, newGroup()]; }}>Add commit</button>
    `;
  }

  render() {
    const s = this.source;
    const problem = s ? planProblem(s, this.groups) : null;
    const busy = this.loading || this.suggesting || this.applying;
    return html`
      <gn-modal .open=${this.open} modalTitle="Commit Composer" @close=${() => this.close()}>
        <div class="composer">
          <div class="source">
            <select
              class="mode-select"
              .value=${this.mode}
              ?disabled=${busy}
              @change=${(e: Event) => { this.mode = (e.target as HTMLSelectElement).value as SourceMode; void this.load(); }}
            >
              <option value="range">Commits since</option>
              <option value="worktree">Uncommitted changes</option>
            </select>
            ${this.mode === 'range' ? html`
              <input
                class="base-input"
                aria-label="Base"
                .value=${this.base}
                @input=${(e: Event) => { this.base = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.load(); }}
              />
              <button class="btn btn-sm btn-secondary" data-action="load" ?disabled=${busy} @click=${() => void this.load()}>Load</button>
            ` : nothing}
          </div>

          ${this.applied ? html`
            <div class="notice" role="status">
              Recomposed ${this.applied.branch} into ${this.applied.commits} commit${this.applied.commits === 1 ? '' : 's'}.
              <button class="btn btn-sm btn-secondary" data-action="undo" @click=${() => void this.undo()}>Undo</button>
            </div>
          ` : nothing}
          ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

          ${this.loading ? html`<div class="muted">Loading…</div>` : s && s.files.length === 0 ? html`
            <div class="muted">Nothing to recompose: there are no changes here.</div>
          ` : s ? html`
            <div class="columns">
              <div>${this.renderBefore()}</div>
              <div>${this.renderAfter()}</div>
            </div>
          ` : nothing}

          <div class="footer">
            <span class="problem">${problem ?? (s && s.files.length ? 'Ready to apply' : '')}</span>
            <button
              class="btn btn-secondary"
              data-action="suggest"
              ?disabled=${!s || !s.files.length || busy || !this.aiAvailable}
              title=${this.aiAvailable ? 'Ask AI to group the changes and write the messages' : 'Set up an AI provider in Settings to get suggestions; you can group the files by hand'}
              @click=${() => void this.suggest()}
            >${this.suggesting ? 'Suggesting…' : 'Suggest with AI'}</button>
            <button class="btn btn-secondary" data-action="reset" ?disabled=${!s || busy} @click=${() => { if (s) this.groups = initialPlan(s); }}>Reset</button>
            <button class="btn btn-primary" data-action="apply" ?disabled=${!s || !!problem || busy} @click=${() => void this.apply()}>
              ${this.applying ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-commit-composer-dialog': GnCommitComposerDialog;
  }
}
