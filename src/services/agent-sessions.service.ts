/**
 * Agent Sessions (roadmap 4.1, issue #604).
 *
 * Terminal coding agents (Claude Code, Codex CLI, Copilot CLI, Gemini CLI,
 * Aider, …) running inside a repository or one of its worktrees, detected
 * from the local process table.
 */

import type { CommandResult } from '../types/api.types.ts';
import { invokeCommand } from './tauri-api.ts';

/**
 * - `working`: a turn is in progress (reported by the agent hooks bridge)
 * - `waiting`: between turns, waiting for the user (hooks bridge)
 * - `running`: alive; turn state unknown without the hooks bridge
 */
export type AgentState = 'working' | 'waiting' | 'running';

export interface AgentSession {
  pid: number;
  agent: string;
  command: string;
  cwd: string;
  worktreePath: string;
  isMainWorktree: boolean;
  branch: string | null;
  state: AgentState;
  /** Unix seconds. */
  startedAt: number;
  elapsedSecs: number;
  changedFiles: number | null;
}

export async function listAgentSessions(path: string): Promise<CommandResult<AgentSession[]>> {
  return invokeCommand<AgentSession[]>('list_agent_sessions', { path });
}

/** Compact elapsed time: `45s`, `12m`, `2h 05m`, `3d 4h`. */
export function formatElapsed(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}
