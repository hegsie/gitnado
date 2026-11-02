/**
 * Embedded terminal sessions (roadmap 4.6, issue #628).
 *
 * Each session pairs an xterm.js `Terminal` with a backend PTY started by
 * `pty_spawn`. Sessions live HERE rather than in the panel component so that
 * hiding the panel or switching repository tabs never kills a running shell or
 * loses its scrollback: the panel only attaches a session's host element while
 * it is visible.
 *
 * A repository tab owns its sessions — closing the tab terminates them, so no
 * shell outlives the repository it was opened for.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invokeCommand } from './tauri-api.ts';
import { repositoryStore } from '../stores/repository.store.ts';

export type TerminalStatus = 'starting' | 'running' | 'exited' | 'failed';

/** Backend description of a running session (`PtySessionInfo`). */
export interface PtySessionInfo {
  id: number;
  cwd: string;
  program: string;
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: number;
}

export interface PtyOutputPayload {
  id: number;
  data: string;
}

export interface PtyExitPayload {
  id: number;
  exitCode: number | null;
}

export interface TerminalSession {
  /** Stable frontend key (the backend id is unknown until spawn resolves). */
  key: string;
  /** Backend PTY id, once started. */
  ptyId: number | null;
  /** Repository tab that owns the session. */
  repoPath: string;
  /** Directory the shell runs in (the repo root or one of its worktrees). */
  cwd: string;
  label: string;
  status: TerminalStatus;
  exitCode: number | null;
  error: string | null;
  program: string | null;
  term: Terminal;
  fit: FitAddon;
  /** Element xterm renders into; moved between containers by the panel. */
  host: HTMLDivElement;
  opened: boolean;
}

export interface CreateTerminalOptions {
  repoPath: string;
  cwd?: string;
  label?: string;
  /** Program and arguments to run instead of the user's shell. */
  command?: string[];
}

type Listener = () => void;

const sessions: TerminalSession[] = [];
const listeners = new Set<Listener>();
/** Output/exit that arrived before `pty_spawn` resolved with the id. */
const pendingOutput = new Map<number, string[]>();
const pendingExit = new Map<number, number | null>();
let keyCounter = 0;
let eventUnlisteners: UnlistenFn[] = [];
let eventsStarting: Promise<void> | null = null;
let unsubscribeRepos: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to session list / status changes. Returns an unsubscribe. */
export function subscribeTerminals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sessions owned by a repository tab, in creation order. */
export function getTerminalSessions(repoPath?: string): TerminalSession[] {
  return repoPath ? sessions.filter((s) => s.repoPath === repoPath) : [...sessions];
}

export function getTerminalSession(key: string): TerminalSession | undefined {
  return sessions.find((s) => s.key === key);
}

function findByPtyId(id: number): TerminalSession | undefined {
  return sessions.find((s) => s.ptyId === id);
}

/** Feed backend output into its terminal (exported for tests). */
export function handlePtyOutput(payload: PtyOutputPayload): void {
  const session = findByPtyId(payload.id);
  if (session) {
    session.term.write(payload.data);
    return;
  }
  const queue = pendingOutput.get(payload.id) ?? [];
  queue.push(payload.data);
  pendingOutput.set(payload.id, queue);
}

/** Mark a session as exited (exported for tests). */
export function handlePtyExit(payload: PtyExitPayload): void {
  const session = findByPtyId(payload.id);
  if (!session) {
    pendingExit.set(payload.id, payload.exitCode);
    return;
  }
  markExited(session, payload.exitCode);
}

function markExited(session: TerminalSession, exitCode: number | null): void {
  if (session.status === 'exited') return;
  session.status = 'exited';
  session.exitCode = exitCode;
  const detail = exitCode === null ? 'terminated' : `exited with code ${exitCode}`;
  session.term.write(`\r\n\x1b[2m[Process ${detail}]\x1b[0m\r\n`);
  notify();
}

/** Start listening for backend PTY events. Idempotent. */
export async function startTerminalEvents(): Promise<void> {
  ensureRepoWatch();
  if (eventUnlisteners.length > 0) return;
  if (eventsStarting) return eventsStarting;
  eventsStarting = Promise.all([
    listen<PtyOutputPayload>('pty-output', (e) => handlePtyOutput(e.payload)),
    listen<PtyExitPayload>('pty-exit', (e) => handlePtyExit(e.payload)),
  ])
    .then((fns) => {
      eventUnlisteners = fns;
    })
    .catch(() => {
      // No Tauri event bridge (plain browser). Sessions still start; output
      // simply never arrives, which the panel shows as an empty terminal.
    })
    .finally(() => {
      eventsStarting = null;
    });
  return eventsStarting;
}

/** Close the sessions of repository tabs that are no longer open. */
function ensureRepoWatch(): void {
  if (unsubscribeRepos) return;
  unsubscribeRepos = repositoryStore.subscribe((state) => {
    const open = new Set(state.openRepositories.map((r) => r.repository.path));
    for (const session of [...sessions]) {
      if (!open.has(session.repoPath)) {
        void closeTerminalSession(session.key);
      }
    }
  });
}

/** xterm takes concrete values, not CSS variables: resolve app tokens now. */
function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function labelFor(cwd: string, repoPath: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  const count = sessions.filter((s) => s.repoPath === repoPath).length + 1;
  return count > 1 ? `${base} (${count})` : base;
}

/**
 * Create a session and start its PTY. Resolves once the backend has answered;
 * a failure leaves the session in the 'failed' state with the error shown in
 * the terminal so the user sees why, rather than an empty pane.
 */
export async function createTerminalSession(
  options: CreateTerminalOptions,
): Promise<TerminalSession> {
  await startTerminalEvents();

  const cwd = options.cwd ?? options.repoPath;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: cssToken('--font-family-mono', 'monospace'),
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: cssToken('--color-bg-primary', '#1e1e1e'),
      foreground: cssToken('--color-text-primary', '#e4e4e4'),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'terminal-host';

  const session: TerminalSession = {
    key: `term-${++keyCounter}`,
    ptyId: null,
    repoPath: options.repoPath,
    cwd,
    label: options.label ?? labelFor(cwd, options.repoPath),
    status: 'starting',
    exitCode: null,
    error: null,
    program: null,
    term,
    fit,
    host,
    opened: false,
  };
  sessions.push(session);
  notify();

  term.onData((data) => {
    if (session.status !== 'running' || session.ptyId === null) return;
    void invokeCommand<void>('pty_write', { id: session.ptyId, data });
  });

  const result = await invokeCommand<PtySessionInfo>('pty_spawn', {
    options: {
      cwd,
      cols: term.cols,
      rows: term.rows,
      command: options.command,
    },
  });

  // Closed while the spawn was in flight: terminate what just started.
  if (!sessions.includes(session)) {
    if (result.success && result.data) {
      void invokeCommand<void>('pty_kill', { id: result.data.id });
    }
    return session;
  }

  if (!result.success || !result.data) {
    session.status = 'failed';
    session.error = result.error?.message ?? 'Failed to start terminal';
    term.write(`\x1b[31m${session.error}\x1b[0m\r\n`);
    notify();
    return session;
  }

  session.ptyId = result.data.id;
  session.program = result.data.program;
  session.status = 'running';

  const queued = pendingOutput.get(session.ptyId);
  if (queued) {
    pendingOutput.delete(session.ptyId);
    for (const chunk of queued) term.write(chunk);
  }
  if (pendingExit.has(session.ptyId)) {
    const code = pendingExit.get(session.ptyId) ?? null;
    pendingExit.delete(session.ptyId);
    markExited(session, code);
  } else {
    notify();
  }
  // The panel may have attached and fitted the terminal before the id existed.
  syncSize(session);
  return session;
}

/**
 * Render a session inside `container` (moving it there if it was elsewhere)
 * and fit it to the container's size.
 */
export function attachTerminalSession(session: TerminalSession, container: HTMLElement): void {
  if (session.host.parentElement !== container) {
    container.replaceChildren(session.host);
  }
  if (!session.opened) {
    session.term.open(session.host);
    session.opened = true;
  }
  fitTerminalSession(session);
}

/** Fit a visible session to its container and tell the PTY its new size. */
export function fitTerminalSession(session: TerminalSession): void {
  if (!session.opened || !session.host.isConnected) return;
  try {
    session.fit.fit();
  } catch {
    // Zero-sized container (panel collapsed mid-layout); try again next fit.
    return;
  }
  syncSize(session);
}

function syncSize(session: TerminalSession): void {
  if (session.status !== 'running' || session.ptyId === null) return;
  void invokeCommand<void>('pty_resize', {
    id: session.ptyId,
    cols: session.term.cols,
    rows: session.term.rows,
  });
}

/** Terminate (if running) and discard a session. */
export async function closeTerminalSession(key: string): Promise<void> {
  const index = sessions.findIndex((s) => s.key === key);
  if (index === -1) return;
  const [session] = sessions.splice(index, 1);
  notify();
  if (session.ptyId !== null && session.status === 'running') {
    await invokeCommand<void>('pty_kill', { id: session.ptyId });
  }
  session.term.dispose();
  session.host.remove();
}

/** Test hook: drop every session and listener without touching the backend. */
export function resetTerminalsForTests(): void {
  for (const session of sessions.splice(0)) {
    session.term.dispose();
    session.host.remove();
  }
  pendingOutput.clear();
  pendingExit.clear();
  listeners.clear();
  // The pty-output/pty-exit listeners stay attached: they are idempotent and
  // route by id, so a fresh test simply never matches a stale session.
  unsubscribeRepos?.();
  unsubscribeRepos = null;
  keyCounter = 0;
}
