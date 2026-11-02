/**
 * "Start agent on a task" (roadmap 4.1, issue #605).
 *
 * Pure helpers for turning a task into a branch, a worktree and the command
 * that starts an agent CLI in the embedded terminal.
 *
 * The task text never goes into a command line. It is handed to the shell in
 * the GITNADO_TASK_PROMPT environment variable and the command only names the
 * variable, so no prompt — quotes, `$(...)`, `;` — can be interpreted by the
 * shell, on any platform.
 */

export const TASK_PROMPT_ENV = 'GITNADO_TASK_PROMPT';

export interface AgentCli {
  id: string;
  label: string;
  /** Executable name. */
  bin: string;
  /** Arguments placed before the prompt to start an interactive session with it. */
  promptArgs: string[];
  install: string;
}

/** Agents that accept an initial prompt and stay interactive. */
export const AGENT_CLIS: readonly AgentCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    promptArgs: [],
    install: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    promptArgs: [],
    install: 'npm install -g @openai/codex',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    promptArgs: ['-i'],
    install: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    bin: 'copilot',
    promptArgs: ['-i'],
    install: 'npm install -g @github/copilot',
  },
];

export type ShellKind = 'posix' | 'cmd' | 'powershell';

/** Which quoting rules the session's shell uses, from its program path. */
export function shellKind(program: string | null | undefined): ShellKind {
  const base = (program ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base.startsWith('powershell') || base.startsWith('pwsh')) return 'powershell';
  return 'posix';
}

/** How the shell expands the prompt variable as a single argument. */
function promptReference(kind: ShellKind): string {
  switch (kind) {
    case 'cmd':
      return `"%${TASK_PROMPT_ENV}%"`;
    case 'powershell':
      return `$env:${TASK_PROMPT_ENV}`;
    default:
      return `"$${TASK_PROMPT_ENV}"`;
  }
}

/** The line typed into the shell to start `agent` on the task. */
export function agentCommandLine(agent: AgentCli, kind: ShellKind): string {
  return [agent.bin, ...agent.promptArgs, promptReference(kind)].join(' ');
}

/** The prompt handed to the agent. */
export function buildTaskPrompt(task: string, issueRef: string): string {
  const t = task.trim();
  const issue = issueRef.trim();
  return issue ? `Issue: ${issue}\n\n${t}` : t;
}

/** A short, ref-safe slug from free text. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'task';
}

/** `agent/<slug>` from the issue reference (preferred) or the task text. */
export function suggestBranchName(task: string, issueRef: string): string {
  const issue = issueRef.trim();
  const issueSlug = issue ? slugify(issue.split(/[\\/#]/).filter(Boolean).pop() ?? issue, 20) : '';
  const taskSlug = slugify(task, 40);
  return `agent/${issueSlug && issueSlug !== 'task' ? `${issueSlug}-` : ''}${taskSlug}`.slice(0, 60).replace(/-+$/g, '');
}

/**
 * A git branch name check matching the common `git check-ref-format --branch`
 * rules. Returns the problem, or null when the name is acceptable.
 */
export function branchNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a branch name';
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return 'Branch names cannot contain spaces or ~ ^ : ? * [ \\';
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.')) {
    return 'Branch names cannot start with - or /, or end with / or .';
  }
  if (n.includes('..') || n.includes('//') || n.includes('@{') || n.endsWith('.lock') || n === '@') {
    return 'That is not a valid branch name';
  }
  if (n.split('/').some((part) => part.startsWith('.'))) {
    return 'Branch name parts cannot start with .';
  }
  return null;
}

/**
 * Default worktree location: a sibling folder of the repository,
 * `<parent>/<repo>.worktrees/<branch-slug>`.
 */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  const sep = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/';
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const parent = idx > 0 ? trimmed.slice(0, idx) : trimmed;
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return `${parent}${sep}${name}.worktrees${sep}${slugify(branch.replace(/^agent\//, ''), 50)}`;
}
