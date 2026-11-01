/**
 * IPC contract extraction.
 *
 * The whole test suite mocks Tauri: every Playwright spec runs against
 * `e2e/fixtures/tauri-mock.ts` and the unit tests stub `invoke`. That means a
 * frontend call to a command the Rust side never registered looks perfectly
 * healthy in CI and fails only in a real build, at the moment a user clicks the
 * button. This module extracts both halves of the contract from source so
 * `scripts/ipc-contract.test.mjs` can compare them:
 *
 *   - every command name the frontend passes to `invoke`/`invokeCommand`
 *   - every command the backend registers in `tauri::generate_handler![...]`
 *
 * The parsing is deliberately syntactic (no TypeScript or Rust compiler), so it
 * refuses to guess: a call whose command name is not a plain string literal is
 * reported as `dynamic` rather than skipped, and the test fails on any dynamic
 * site that is not explicitly allowlisted below.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FRONTEND_DIR = join(REPO_ROOT, 'src');
export const BACKEND_LIB_RS = join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs');

/**
 * Identifiers whose first argument is a Tauri command name.
 *
 * `invokeCommands` takes an array rather than a name; it is listed so that a
 * future batch call cannot introduce commands this test cannot see — it will be
 * reported as a dynamic site instead of being silently ignored.
 */
export const INVOKE_IDENTIFIERS = [
  'invokeCommands',
  'invokeCommand',
  'invokeProviderCommand',
  'invoke',
];

/**
 * Call sites that legitimately forward a command name supplied by their caller.
 * Both are thin wrappers whose own callers pass string literals, so the names
 * are still covered by this test. Every entry must match at least one real call
 * site — the test fails on a stale entry so the allowlist cannot rot.
 */
export const DYNAMIC_ALLOWLIST = [
  {
    file: 'src/services/tauri-api.ts',
    expression: 'command',
    reason: 'invokeCommands() forwards names its callers pass as literals',
  },
  {
    file: 'src/services/git/shared.ts',
    expression: 'command',
    reason:
      'invokeProviderCommand() forwards names its callers pass as literals',
  },
];

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Replace the contents of comments with spaces, preserving every character
 * position and line break so reported line numbers stay accurate.
 */
export function blankComments(source) {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  let prevSignificant = '';

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      let end = source.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i).end;
      prevSignificant = ch;
      continue;
    }

    // Regex literal: only where a value cannot already have been produced.
    if (ch === '/' && '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant)) {
      let k = i + 1;
      let closed = false;
      while (k < n) {
        const c = source[k];
        if (c === '\\') {
          k += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') {
          while (k < n && source[k] !== ']' && source[k] !== '\n') {
            k += source[k] === '\\' ? 2 : 1;
          }
        }
        if (source[k] === '/') {
          closed = true;
          k += 1;
          break;
        }
        k += 1;
      }
      if (closed) {
        i = k;
        prevSignificant = '/';
        continue;
      }
    }

    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }

  return out.join('');
}

/** Read a string literal starting at `start`; returns its value and end index. */
function skipStringLiteral(source, start) {
  const quote = source[start];
  let i = start + 1;
  let value = '';
  let hasSubstitution = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      value += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      hasSubstitution = true;
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { value, end: i + 1, hasSubstitution };
    value += ch;
    i += 1;
  }

  return { value, end: source.length, hasSubstitution };
}

function skipWhitespace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

/**
 * Skip a balanced `<...>` type-argument list. Returns the index after the
 * closing `>`, or -1 when this is not a type-argument list (e.g. a comparison).
 */
function skipTypeArguments(source, index) {
  if (source[index] !== '<') return -1;
  let depth = 0;
  let i = index;
  const limit = Math.min(source.length, index + 1000);

  while (i < limit) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i).end;
      continue;
    }
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }

  return -1;
}

/** Read the first argument expression of a call whose `(` is at `openParen`. */
function readFirstArgument(source, openParen) {
  const i = skipWhitespace(source, openParen + 1);
  if (source[i] === ')') return { kind: 'none' };

  const ch = source[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const literal = skipStringLiteral(source, i);
    const after = skipWhitespace(source, literal.end);
    if (
      !literal.hasSubstitution &&
      (source[after] === ',' || source[after] === ')')
    ) {
      return { kind: 'literal', value: literal.value };
    }
  }

  const start = i;
  let j = i;
  const stack = [];
  while (j < source.length) {
    const c = source[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipStringLiteral(source, j).end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.length === 0) break;
      stack.pop();
    } else if (c === ',' && stack.length === 0) break;
    j += 1;
  }

  return {
    kind: 'dynamic',
    expression: source.slice(start, j).trim().replace(/\s+/g, ' '),
  };
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function precededByDeclaration(source, index) {
  const before = source.slice(Math.max(0, index - 40), index);
  return /\b(function|class|interface|type)\s+$/.test(before);
}

/**
 * Extract every Tauri command name invoked by a single TypeScript source file.
 *
 * @param {string} source raw file contents
 * @param {string} file repo-relative path, used in reported locations
 * @returns {{ literals: Array<{command: string, file: string, line: number}>,
 *             dynamic: Array<{expression: string, file: string, line: number}> }}
 */
export function extractInvocations(source, file) {
  const clean = blankComments(source);
  const literals = [];
  const dynamic = [];

  // Bare `invoke(...)` only counts when it is the Tauri core import; plenty of
  // unrelated code has methods called `invoke`.
  const importsCoreInvoke =
    /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*['"]@tauri-apps\/api\/core['"]/.test(
      clean
    );

  const pattern = new RegExp(`\\b(${INVOKE_IDENTIFIERS.join('|')})`, 'g');
  let match;

  while ((match = pattern.exec(clean)) !== null) {
    const name = match[1];
    const start = match.index;
    const end = start + name.length;

    if (IDENTIFIER_CHAR.test(clean[end] ?? '')) continue;
    const prev = clean[start - 1] ?? '';
    if (IDENTIFIER_CHAR.test(prev) || prev === '.') continue;
    if (name === 'invoke' && !importsCoreInvoke) continue;
    if (precededByDeclaration(clean, start)) continue;

    let i = skipWhitespace(clean, end);
    if (clean[i] === '<') {
      const afterTypeArgs = skipTypeArguments(clean, i);
      if (afterTypeArgs === -1) continue;
      i = skipWhitespace(clean, afterTypeArgs);
    }
    if (clean[i] !== '(') continue;

    const arg = readFirstArgument(clean, i);
    const line = lineOf(clean, start);
    if (arg.kind === 'literal') {
      literals.push({ command: arg.value, file, line });
    } else if (arg.kind === 'dynamic') {
      dynamic.push({ expression: arg.expression, file, line });
    }
  }

  return { literals, dynamic };
}

/** Recursively collect the frontend sources that may contain IPC calls. */
export function collectFrontendFiles(dir = FRONTEND_DIR) {
  const files = [];

  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      files.push(full);
    }
  };

  walk(dir);
  return files;
}

/**
 * Extract the frontend half of the contract across every source file.
 *
 * @returns {{ commands: Map<string, Array<{file: string, line: number}>>,
 *             dynamic: Array<{expression: string, file: string, line: number}> }}
 */
export function extractFrontendContract(files = collectFrontendFiles()) {
  const commands = new Map();
  const dynamic = [];

  for (const full of files) {
    const rel = relative(REPO_ROOT, full).split(sep).join('/');
    const result = extractInvocations(readFileSync(full, 'utf8'), rel);
    for (const hit of result.literals) {
      const sites = commands.get(hit.command) ?? [];
      sites.push({ file: hit.file, line: hit.line });
      commands.set(hit.command, sites);
    }
    dynamic.push(...result.dynamic);
  }

  return { commands, dynamic };
}

function stripRustComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Extract every command registered in `tauri::generate_handler![...]`.
 * Module paths (`commands::branch::create_branch`) are reduced to the bare
 * function name, which is the name the frontend must invoke.
 *
 * @param {string} source contents of src-tauri/src/lib.rs
 * @returns {string[]} registered command names, in declaration order
 */
export function parseHandlerList(source) {
  const names = [];
  const marker = /generate_handler!\s*\[/g;
  let match;

  while ((match = marker.exec(source)) !== null) {
    let i = match.index + match[0].length;
    let depth = 1;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '[') depth += 1;
      else if (source[i] === ']') depth -= 1;
      i += 1;
    }
    if (depth !== 0) {
      throw new Error('Unterminated generate_handler![ ... ] list in lib.rs');
    }

    const body = stripRustComments(source.slice(start, i - 1));
    for (const raw of body.split(',')) {
      const entry = raw.trim();
      if (entry === '') continue;
      const name = entry.split('::').pop();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
          `Unparseable entry in generate_handler!: ${JSON.stringify(entry)}`
        );
      }
      names.push(name);
    }
  }

  if (names.length === 0) {
    throw new Error('No generate_handler![ ... ] list found in lib.rs');
  }

  return names;
}

/**
 * Compare both halves of the contract.
 *
 * @returns {{ missingInBackend: Array<{command: string, sites: Array}>,
 *             backendOnly: string[], duplicateHandlers: string[] }}
 */
export function compareContracts(frontendCommands, backendCommands) {
  const registered = new Set(backendCommands);
  const missingInBackend = [];

  for (const [command, sites] of [...frontendCommands].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!registered.has(command)) missingInBackend.push({ command, sites });
  }

  const called = new Set(frontendCommands.keys());
  const backendOnly = [...registered].filter((c) => !called.has(c)).sort();

  const seen = new Set();
  const duplicateHandlers = [];
  for (const command of backendCommands) {
    if (seen.has(command) && !duplicateHandlers.includes(command)) {
      duplicateHandlers.push(command);
    }
    seen.add(command);
  }

  return { missingInBackend, backendOnly, duplicateHandlers };
}

/** Read both halves of the contract from the repository. */
export function loadContract() {
  const { commands, dynamic } = extractFrontendContract();
  const backend = parseHandlerList(readFileSync(BACKEND_LIB_RS, 'utf8'));
  return { commands, dynamic, backend, ...compareContracts(commands, backend) };
}
