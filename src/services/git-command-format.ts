/**
 * Git command formatting for the Output panel.
 *
 * Leviathan runs most operations through libgit2 (git2), so there is no `git`
 * process to quote. The panel would otherwise show the IPC command name
 * (`create_commit`, `stage_files`), which tells a user nothing about what git
 * was asked to do. `synthesizeGitCommand` renders the EQUIVALENT command line
 * for the main operations instead.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Honesty.** A synthesised line is not a command that ran. Callers mark
 *    these entries (`synthesized: true`) and the panel renders them with a `≈`
 *    and a legend, so the panel never implies a CLI invocation happened.
 * 2. **No secrets.** The IPC layer deliberately logs no arguments at all,
 *    because arguments can carry credentials. Synthesis reads an EXPLICIT,
 *    per-command allowlist of fields — never the whole args object — so a
 *    field like `token` is not merely filtered, it is never read. Everything
 *    that does get rendered is then passed through `redactSecrets` as a safety
 *    net, because a user's own remote URL can carry `user:token@host`.
 */

/**
 * Patterns for anything that looks like a credential.
 *
 * Mirrors `redact_secrets` in `src-tauri/src/utils/command.rs` — the backend
 * scrubs what it captures from real `git` processes, this scrubs what the
 * frontend synthesises. Kept as two implementations on purpose: they run in
 * different runtimes and each must hold on its own.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credentials embedded in a URL: https://user:token@host, ssh://user@host.
  // The userinfo goes; the host stays so the line still says which remote.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@'],
  // Provider tokens, by their documented prefixes.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  // JSON Web Tokens (three base64url segments).
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***'],
  // `Bearer <token>` — matched BEFORE the named-secret rule below, which would
  // otherwise consume the word `Bearer` as `Authorization`'s value and leave
  // the token itself standing.
  [/\bbearer\s+[A-Za-z0-9._\-+/=]{6,}/gi, 'Bearer ***'],
  // Anything explicitly NAMED as a secret, whatever its shape.
  [
    /\b(password|passwd|token|access[_-]?token|api[_-]?key|secret|authorization)([=:]\s*|\s+)\S+/gi,
    '$1=***',
  ],
];

/**
 * Replace anything that looks like a credential with `***`.
 *
 * Applied to every synthesised command line and to every error message before
 * it reaches the Output panel.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Quote an argument so a multi-word value reads as one token. */
function quoteArg(value: string): string {
  if (value === '') return '""';
  if (/[\s"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** A string field, or undefined when absent/blank/of the wrong type. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A `paths: string[]` field, keeping only the entries that really are strings. */
function paths(args: Record<string, unknown>): string[] {
  const value = args['paths'];
  return Array.isArray(value)
    ? value.filter((p): p is string => typeof p === 'string')
    : [];
}

/** `stash@{n}` for an index, falling back to the plain form when absent. */
function stashRef(args: Record<string, unknown>): string {
  const index = num(args, 'index');
  return index === undefined ? 'stash@{0}' : `stash@{${index}}`;
}

/**
 * Builders for the main operations, keyed by IPC command name.
 *
 * Deliberately not exhaustive: the app exposes hundreds of commands, and a
 * half-guessed line is worse than the honest IPC name. Anything absent here
 * falls through to the command name, exactly as before.
 *
 * Each builder returns the argv AFTER `git`, or `undefined` when the arguments
 * it needs are missing (a line built from absent values would be a lie).
 */
const BUILDERS: Record<
  string,
  (args: Record<string, unknown>) => string[] | undefined
> = {
  // --- commit ---
  create_commit: (a) => {
    const argv = ['commit'];
    if (bool(a, 'amend')) argv.push('--amend');
    if (bool(a, 'signCommit')) argv.push('-S');
    if (bool(a, 'allowEmpty')) argv.push('--allow-empty');
    const message = str(a, 'message');
    if (message) argv.push('-m', message);
    return argv;
  },
  amend_commit: (a) => {
    const argv = ['commit', '--amend'];
    if (bool(a, 'resetAuthor')) argv.push('--reset-author');
    if (bool(a, 'signAmend')) argv.push('-S');
    const message = str(a, 'message');
    if (message) argv.push('-m', message);
    else argv.push('--no-edit');
    return argv;
  },
  commit_merge: (a) => {
    const argv = ['commit'];
    const message = str(a, 'message');
    if (message) argv.push('-m', message);
    else argv.push('--no-edit');
    return argv;
  },

  // --- staging ---
  stage_files: (a) => {
    const files = paths(a);
    return files.length > 0 ? ['add', '--', ...files] : ['add', '-A'];
  },
  unstage_files: (a) => {
    const files = paths(a);
    return files.length > 0
      ? ['restore', '--staged', '--', ...files]
      : ['restore', '--staged', '.'];
  },
  discard_changes: (a) => {
    const files = paths(a);
    return files.length > 0 ? ['restore', '--', ...files] : undefined;
  },

  // --- branches / checkout ---
  checkout: (a) => {
    const ref = str(a, 'refName');
    if (!ref) return undefined;
    return bool(a, 'force') ? ['checkout', '--force', ref] : ['checkout', ref];
  },
  checkout_with_autostash: (a) => {
    const ref = str(a, 'refName');
    if (!ref) return undefined;
    // The autostash variant is a checkout wrapped in a stash push/pop; showing
    // the checkout alone would misrepresent what the operation does to the
    // working tree, so spell out all three steps. (`&&` has nothing that needs
    // quoting, so it survives `quoteArg` as the operator it is.)
    return bool(a, 'autoStash')
      ? ['stash', 'push', '&&', 'git', 'checkout', ref, '&&', 'git', 'stash', 'pop']
      : ['checkout', ref];
  },
  create_branch: (a) => {
    const name = str(a, 'name');
    if (!name) return undefined;
    const startPoint = str(a, 'startPoint');
    const argv = bool(a, 'checkout') ? ['checkout', '-b', name] : ['branch', name];
    if (startPoint) argv.push(startPoint);
    return argv;
  },
  delete_branch: (a) => {
    const name = str(a, 'name');
    if (!name) return undefined;
    return ['branch', bool(a, 'force') ? '-D' : '-d', name];
  },
  rename_branch: (a) => {
    const oldName = str(a, 'oldName');
    const newName = str(a, 'newName');
    if (!oldName || !newName) return undefined;
    return ['branch', '-m', oldName, newName];
  },

  // --- merge ---
  merge: (a) => {
    const source = str(a, 'sourceRef');
    if (!source) return undefined;
    const argv = ['merge'];
    if (bool(a, 'noFf')) argv.push('--no-ff');
    if (bool(a, 'squash')) argv.push('--squash');
    const message = str(a, 'message');
    if (message) argv.push('-m', message);
    argv.push(source);
    return argv;
  },
  abort_merge: () => ['merge', '--abort'],

  // --- rebase ---
  rebase: (a) => {
    const onto = str(a, 'onto');
    return onto ? ['rebase', onto] : undefined;
  },
  continue_rebase: () => ['rebase', '--continue'],
  abort_rebase: () => ['rebase', '--abort'],
  skip_rebase_commit: () => ['rebase', '--skip'],

  // --- remote transfer ---
  fetch: (a) => {
    const argv = ['fetch'];
    if (bool(a, 'prune')) argv.push('--prune');
    const remote = str(a, 'remote');
    if (remote) argv.push(remote);
    return argv;
  },
  fetch_all_remotes: (a) => (bool(a, 'prune') ? ['fetch', '--all', '--prune'] : ['fetch', '--all']),
  pull: (a) => {
    const argv = ['pull'];
    if (bool(a, 'rebase')) argv.push('--rebase');
    const remote = str(a, 'remote');
    const branch = str(a, 'branch');
    if (remote) argv.push(remote);
    if (remote && branch) argv.push(branch);
    return argv;
  },
  push: (a) => {
    const argv = ['push'];
    if (bool(a, 'forceWithLease')) argv.push('--force-with-lease');
    else if (bool(a, 'force')) argv.push('--force');
    if (bool(a, 'pushTags')) argv.push('--tags');
    if (bool(a, 'setUpstream')) argv.push('--set-upstream');
    const remote = str(a, 'remote');
    const branch = str(a, 'branch');
    if (remote) argv.push(remote);
    if (remote && branch) argv.push(branch);
    return argv;
  },

  // --- stash ---
  create_stash: (a) => {
    const argv = ['stash', 'push'];
    if (bool(a, 'includeUntracked')) argv.push('--include-untracked');
    const message = str(a, 'message');
    if (message) argv.push('-m', message);
    return argv;
  },
  apply_stash: (a) => [
    'stash',
    bool(a, 'dropAfter') ? 'pop' : 'apply',
    stashRef(a),
  ],
  pop_stash: (a) => ['stash', 'pop', stashRef(a)],
  drop_stash: (a) => ['stash', 'drop', stashRef(a)],

  // --- reset ---
  reset: (a) => {
    const target = str(a, 'targetRef');
    const mode = str(a, 'mode');
    if (!target || !mode) return undefined;
    return ['reset', `--${mode}`, target];
  },

  // --- cherry-pick / revert ---
  cherry_pick: (a) => {
    const oid = str(a, 'commitOid');
    if (!oid) return undefined;
    const argv = ['cherry-pick'];
    if (bool(a, 'noCommit')) argv.push('--no-commit');
    const mainline = num(a, 'mainline');
    if (mainline !== undefined) argv.push('-m', String(mainline));
    argv.push(oid);
    return argv;
  },
  continue_cherry_pick: () => ['cherry-pick', '--continue'],
  abort_cherry_pick: () => ['cherry-pick', '--abort'],
  skip_cherry_pick: () => ['cherry-pick', '--skip'],
  revert: (a) => {
    const oid = str(a, 'commitOid');
    if (!oid) return undefined;
    const argv = ['revert'];
    const mainline = num(a, 'mainline');
    if (mainline !== undefined) argv.push('-m', String(mainline));
    argv.push(oid);
    return argv;
  },
  continue_revert: () => ['revert', '--continue'],
  abort_revert: () => ['revert', '--abort'],
  skip_revert: () => ['revert', '--skip'],

  // --- tags ---
  create_tag: (a) => {
    const name = str(a, 'name');
    if (!name) return undefined;
    const argv = ['tag'];
    const message = str(a, 'message');
    if (message) argv.push('-a', '-m', message);
    argv.push(name);
    const target = str(a, 'target');
    if (target) argv.push(target);
    return argv;
  },
  delete_tag: (a) => {
    const name = str(a, 'name');
    return name ? ['tag', '-d', name] : undefined;
  },
  // With no explicit remote the BACKEND resolves one (the branch's push
  // config, then its upstream, then the sole remote, and only then `origin` —
  // see `resolve_push_remote` in remote.rs). Naming `origin` here would put a
  // remote in the panel that the push never used, on exactly the repositories
  // where that matters (`git clone -o upstream`, a renamed remote). Omitting it
  // is both honest and valid git: `git push refs/tags/v1` pushes to the
  // default remote, which is what the backend resolves.
  push_tag: (a) => {
    const name = str(a, 'name');
    if (!name) return undefined;
    const argv = ['push'];
    if (bool(a, 'force')) argv.push('--force');
    const remote = str(a, 'remote');
    if (remote) argv.push(remote);
    argv.push(`refs/tags/${name}`);
    return argv;
  },
  delete_remote_tag: (a) => {
    const name = str(a, 'name');
    if (!name) return undefined;
    const argv = ['push'];
    const remote = str(a, 'remote');
    if (remote) argv.push(remote);
    argv.push('--delete', `refs/tags/${name}`);
    return argv;
  },
};

/**
 * The `git` command line equivalent to an IPC command, or `undefined` when the
 * operation has no synthesis (the caller then shows the IPC command name).
 *
 * The returned line describes what git2 was asked to do — it is NOT a command
 * that ran. Callers must mark it as synthesised.
 */
export function synthesizeGitCommand(
  command: string,
  args?: unknown,
): string | undefined {
  const build = BUILDERS[command];
  if (!build) return undefined;

  const record =
    typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>)
      : {};

  const argv = build(record);
  if (!argv) return undefined;

  return redactSecrets(['git', ...argv.map(quoteArg)].join(' '));
}

/** The operations `synthesizeGitCommand` covers — exported for tests. */
export const SYNTHESIZED_COMMANDS: ReadonlyArray<string> = Object.keys(BUILDERS);

/**
 * The git subcommands the BACKEND may really run for an operation whose
 * builder above renders a DIFFERENT one.
 *
 * The Output panel drops an operation's synthesised row when a real `git` run
 * reported by the backend belongs to it, and it decides that by comparing git
 * subcommands: two known values that differ are a mismatch. That comparison is
 * right for `create_commit` (`git commit`), `push` (`git push`) and every other
 * builder whose Rust side shells out to the subcommand the builder names — but
 * `merge` does not: it runs through libgit2 and then, when `commit.gpgsign` is
 * set, commits the merge with `git commit -S -m <msg>` (`commit_merge_signed`
 * in `src-tauri/src/commands/merge.rs`), because libgit2 cannot sign. Left
 * undeclared, that real `git commit` was refused as "a different subcommand"
 * and the panel showed BOTH `≈ git merge feature` and the real line — two red
 * rows for one click when no GPG key was configured.
 *
 * Every builder's own subcommand is always accepted; this map lists the
 * ADDITIONAL ones. Audited against every `create_command("git")` site in
 * `src-tauri/src/commands/` reachable from a builder command: `create_commit`,
 * `amend_commit`, `commit_merge` → `commit`; `create_tag` → `tag`; `push` →
 * `push`; `continue_rebase`, `abort_rebase`, `skip_rebase_commit` → `rebase`.
 * `pull`, `cherry_pick`, `revert`, `rebase`, `fetch`, the stash, branch, reset
 * and staging builders never shell out through a reporting command at all.
 */
const BACKEND_SUBCOMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  merge: ['commit'],
};

/**
 * Every git subcommand a real run of `command` may carry: the one its
 * synthesised `line` names plus any the backend is known to run instead.
 * `undefined` when the line names none — the operation's shape is unknown
 * then, and the caller stays permissive exactly as it did before.
 */
export function claimableSubcommands(
  command: string,
  line: string | undefined,
): string[] | undefined {
  const own = gitSubcommand(line);
  if (own === undefined) return undefined;
  return [own, ...(BACKEND_SUBCOMMANDS[command] ?? [])];
}

/**
 * git's own options that take a SEPARATE value argument, so the subcommand
 * scan skips two slots rather than mistaking the value for the subcommand.
 *
 * Mirrors `GLOBAL_OPTS_WITH_VALUE` in `src-tauri/src/utils/command.rs`: the
 * backend renders lines like `git -C /repo push --force-with-lease origin main`
 * (push shells out with `-C` rather than a working directory), so a naive
 * "first token after git" would read `-C` as the subcommand.
 */
const GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/**
 * Split a rendered command line back into the arguments it was rendered from.
 *
 * The line is NOT free-form text: `format_command_line` in
 * `src-tauri/src/utils/command.rs` joins arguments with single spaces after
 * passing each through `quote_arg`, and `quoteArg` above renders the
 * synthesised lines the same way. Both wrap an argument that contains
 * whitespace, a quote or a backslash in `"…"`, escaping `\` as `\\` and `"`
 * as `\"`. Splitting on whitespace would therefore tear a quoted repository
 * path — `git -C "/Users/me/My Repos/lev" push …` — into three pieces, and the
 * two-slot `-C` skip would land in the middle of the path instead of on the
 * subcommand. Undoing the quoting keeps one argument one token.
 *
 * Best-effort, like its caller: an unterminated quote simply ends the last
 * token, and a backslash outside quotes (which neither renderer emits) is
 * taken literally.
 */
function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '\\' && i + 1 < line.length) {
        current += line[++i];
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);

  return tokens;
}

/**
 * The git subcommand a rendered command line runs (`commit`, `push`, …), or
 * `undefined` when the line is absent or names none.
 *
 * Used to tell the panel's two feeds apart: a real `git commit` reported by the
 * backend must not be mistaken for the in-flight `git fetch` an auto-fetch
 * started in the same repository. Parsing an already-rendered line is a
 * best-effort read — a line it cannot classify simply yields `undefined`, which
 * only ever makes the caller MORE conservative.
 */
export function gitSubcommand(line: string | undefined): string | undefined {
  if (!line) return undefined;
  // Quote-aware: a repository path with a space is ONE argument, so `-C` skips
  // the whole path rather than the first whitespace-separated piece of it.
  const tokens = tokenizeCommandLine(line).filter((t) => t.length > 0);
  let i = 0;
  // Drop the program itself (`git`, or a fully qualified path to it).
  if (i < tokens.length && /(^|[/\\])git(\.exe)?$/i.test(tokens[i])) i++;
  while (i < tokens.length) {
    const token = tokens[i];
    if (GLOBAL_OPTS_WITH_VALUE.has(token)) {
      i += 2;
    } else if (token.startsWith('-')) {
      i += 1;
    } else {
      return token;
    }
  }
  return undefined;
}
