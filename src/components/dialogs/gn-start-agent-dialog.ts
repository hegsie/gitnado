/**
 * Start Agent on a Task (roadmap 4.1, issue #605)
 *
 * One form: pick an agent CLI, describe the task (optionally with an issue
 * reference), and Gitnado creates a fresh branch in its own worktree and
 * starts the agent there in the embedded terminal with the task as its first
 * prompt. The agent works in isolation; your checkout is untouched.
 */

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { dialogs } from '../../stores/dialog.store.ts';
import {
  createTerminalSession,
  writeToTerminal,
} from '../../services/terminal.service.ts';
import {
  AGENT_CLIS,
  TASK_PROMPT_ENV,
  agentCommandLine,
  branchNameProblem,
  buildTaskPrompt,
  defaultWorktreePath,
  shellKind,
  suggestBranchName,
} from '../../services/agent-task.service.ts';
import { GnRepoScopedDialogBase } from './gn-repo-scoped-dialog-base.ts';
import './gn-modal.ts';

@customElement('gn-start-agent-dialog')
export class GnStartAgentDialog extends GnRepoScopedDialogBase {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: min(560px, 85vw);
      }

      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      input,
      select,
      textarea {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
      }

      textarea {
        min-height: 96px;
        resize: vertical;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-md);
      }

      .field-error {
        font-size: var(--font-size-xs);
        color: var(--color-error);
      }

      .error {
        padding: var(--spacing-sm);
        border-radius: var(--radius-sm);
        background: var(--color-error-bg, rgba(255, 0, 0, 0.08));
        color: var(--color-error);
        font-size: var(--font-size-sm);
        white-space: pre-wrap;
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
      }
    `,
  ];

  @state() private agentId = AGENT_CLIS[0].id;
  @state() private task = '';
  @state() private issueRef = '';
  @state() private branch = '';
  @state() private branchEdited = false;
  @state() private baseRef = '';
  @state() private worktreePath = '';
  @state() private pathEdited = false;
  @state() private busy = false;
  @state() private error: string | null = null;

  private pinnedRepoPath = '';

  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  public get operationInFlight(): boolean {
    return this.busy;
  }

  /** Branch to start from when the dialog opens (the current branch). */
  defaultBaseRef = '';

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      this.agentId = AGENT_CLIS[0].id;
      this.task = '';
      this.issueRef = '';
      this.branch = '';
      this.branchEdited = false;
      this.baseRef = this.defaultBaseRef || 'HEAD';
      this.worktreePath = '';
      this.pathEdited = false;
      this.error = null;
      this.busy = false;
    }
  }

  close(): void {
    if (this.busy) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  /** Keep the derived branch and path in step until the user edits them. */
  private syncDerived(): void {
    if (!this.branchEdited) {
      this.branch = this.task.trim() || this.issueRef.trim() ? suggestBranchName(this.task, this.issueRef) : '';
    }
    if (!this.pathEdited) {
      this.worktreePath = this.branch ? defaultWorktreePath(this.pinnedRepoPath, this.branch) : '';
    }
  }

  private get branchProblem(): string | null {
    return this.branch ? branchNameProblem(this.branch) : null;
  }

  private get canStart(): boolean {
    return (
      !this.busy &&
      this.task.trim().length > 0 &&
      this.branch.trim().length > 0 &&
      this.branchProblem === null &&
      this.worktreePath.trim().length > 0
    );
  }

  private async handleStart(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!this.canStart) return;
    const agent = AGENT_CLIS.find((a) => a.id === this.agentId) ?? AGENT_CLIS[0];
    const repoPath = this.pinnedRepoPath;
    const branch = this.branch.trim();
    const worktreePath = this.worktreePath.trim();
    const prompt = buildTaskPrompt(this.task, this.issueRef);

    this.busy = true;
    this.error = null;
    try {
      const added = await gitService.addWorktree(repoPath, worktreePath, {
        newBranch: branch,
        commit: this.baseRef.trim() || undefined,
      });
      if (!added.success) {
        this.error = `Could not create the worktree: ${added.error?.message ?? 'Unknown error'}`;
        return;
      }
      // The branch list and worktree list changed.
      this.dispatchRepoEvent('worktrees-changed', repoPath);

      // Create the session BEFORE showing the pane: a pane that opens with no
      // session for this repository starts a plain shell of its own, which
      // would sit next to the agent's tab and steal focus from it.
      const session = await createTerminalSession({
        repoPath,
        cwd: worktreePath,
        label: `${agent.label} · ${branch}`,
        env: { [TASK_PROMPT_ENV]: prompt },
      });
      dialogs.open('terminalPanel');
      if (session.status === 'failed') {
        showToast(
          `Worktree "${branch}" was created, but the terminal could not start: ${session.error}`,
          'error',
        );
        this.busy = false;
        this.close();
        return;
      }
      const typed = await writeToTerminal(session, `${agentCommandLine(agent, shellKind(session.program))}\r`);
      if (!typed) {
        showToast(
          `Worktree "${branch}" is ready, but ${agent.label} could not be started in the terminal`,
          'error',
        );
      } else {
        showToast(`${agent.label} started on "${branch}" in a new worktree`, 'success');
      }
      this.busy = false;
      this.close();
    } finally {
      this.busy = false;
    }
  }

  render() {
    const agent = AGENT_CLIS.find((a) => a.id === this.agentId) ?? AGENT_CLIS[0];
    return html`
      <gn-modal .open=${this.open} modalTitle="Start Agent on a Task" @close=${() => this.close()}>
        <form @submit=${(e: Event) => void this.handleStart(e)}>
          <label>
            Agent
            <select
              class="agent-select"
              .value=${this.agentId}
              @change=${(e: Event) => {
                this.agentId = (e.target as HTMLSelectElement).value;
              }}
            >
              ${AGENT_CLIS.map(
                (a) => html`<option value=${a.id} ?selected=${a.id === this.agentId}>${a.label}</option>`,
              )}
            </select>
            <span class="hint">Runs <code>${agent.bin}</code> from your shell. Not installed? <code>${agent.install}</code></span>
          </label>

          <label>
            Task
            <textarea
              class="task-input"
              placeholder="What should the agent do?"
              .value=${this.task}
              @input=${(e: Event) => {
                this.task = (e.target as HTMLTextAreaElement).value;
                this.syncDerived();
              }}
            ></textarea>
          </label>

          <label>
            Issue (optional)
            <input
              type="text"
              class="issue-input"
              placeholder="e.g. PROJ-123 or https://github.com/org/repo/issues/42"
              .value=${this.issueRef}
              @input=${(e: Event) => {
                this.issueRef = (e.target as HTMLInputElement).value;
                this.syncDerived();
              }}
            />
            <span class="hint">Included at the top of the agent's prompt.</span>
          </label>

          <div class="row">
            <label>
              New branch
              <input
                type="text"
                class="branch-input"
                .value=${this.branch}
                @input=${(e: Event) => {
                  this.branch = (e.target as HTMLInputElement).value;
                  this.branchEdited = true;
                  this.syncDerived();
                }}
              />
              ${this.branchProblem
                ? html`<span class="field-error">${this.branchProblem}</span>`
                : nothing}
            </label>
            <label>
              Start from
              <input
                type="text"
                class="base-input"
                .value=${this.baseRef}
                @input=${(e: Event) => {
                  this.baseRef = (e.target as HTMLInputElement).value;
                }}
              />
            </label>
          </div>

          <label>
            Worktree folder
            <input
              type="text"
              class="path-input"
              .value=${this.worktreePath}
              @input=${(e: Event) => {
                this.worktreePath = (e.target as HTMLInputElement).value;
                this.pathEdited = true;
              }}
            />
            <span class="hint">The agent works here, so your current checkout is never touched.</span>
          </label>

          ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

          <div class="footer">
            <button type="button" class="btn btn-secondary" ?disabled=${this.busy} @click=${() => this.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary start-btn" ?disabled=${!this.canStart}>
              ${this.busy ? 'Starting…' : 'Start Agent'}
            </button>
          </div>
        </form>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-start-agent-dialog': GnStartAgentDialog;
  }
}
