/**
 * Security-policy lock contract.
 *
 * The backend network gate (`src-tauri/src/services/security.rs`) reads a
 * process-global `SecurityState`. Rust runs the unit tests of one crate in
 * parallel threads, so a test that puts that global into offline mode, or
 * behind an allowlist, changes what EVERY concurrently running test sees.
 * `security::test_support` serialises such writers behind a lock and hands out
 * a matching reader guard (`test_support::no_policy()`, also taken by every
 * `TestRepo`) that pins the permissive default for the duration of a test.
 *
 * A test that exercises a guarded command without holding either guard passes
 * on an idle machine and fails under load, when it happens to overlap a
 * writer — it then sees `NetworkBlocked` from a gate it never expected to
 * trip. That is what took the merged tree red, twice, on the same day.
 *
 * This module derives the exposed set from the source instead of trusting
 * each test author to remember:
 *   - the functions that reach the gate, transitively, across the crate; and
 *   - every `#[test]` / `#[tokio::test]` whose body (or a helper it calls)
 *     calls one of them.
 * A test in that set has to hold the lock — through `TestRepo`, through a
 * `test_support::*` guard, or through a helper that does — or it is named.
 *
 * Known false negatives, stated rather than hidden:
 *   - a guard bound to `_` (`let _ = no_policy();`) is dropped immediately
 *     and does not protect anything, but reads as held here;
 *   - a guard created AFTER the guarded call in the same body;
 *   - tests produced by a macro, and gated code reached through a trait
 *     method, closure, or function pointer rather than a direct named call;
 *   - a callee whose name is defined in more than one file is only followed
 *     when the call names its module, so an unqualified call to a
 *     same-named function elsewhere in the crate is not followed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CRATE_SRC = join(REPO_ROOT, 'src-tauri/src');

/**
 * The gate itself: every reader of the global policy in `security.rs`. A body
 * that names one of these (module-qualified, so a local `check` does not
 * count) reaches the gate directly.
 */
export const GATE_PATTERN =
  /\bsecurity::(?:guard_url|guard_remote|guard_endpoint|endpoint_allowed|check|global)\s*\(/;

/**
 * What holding the lock looks like in a test body. `TestRepo` takes the reader
 * guard in its constructor; the `test_support` guards are the reader
 * (`no_policy`) and the writers (`offline`, `allowlist`, `with`).
 */
export const LOCK_PATTERN = /\b(?:test_support::\w+|no_policy|TestRepo::\w+)\s*\(/;

/** Every `.rs` file under `src-tauri/src`, repo-relative, sorted. */
export function listRustFiles(dir = CRATE_SRC) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.rs')) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/**
 * Blank out comments, string and char literals so brace matching and name
 * scanning only ever see code. Replaced characters keep their length (and
 * newlines), so offsets and line numbers stay valid.
 */
export function stripNonCode(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      // Rust block comments nest.
      let depth = 0;
      let j = i;
      do {
        if (source.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (source.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      } while (depth > 0 && j < n);
      out += blank(source.slice(i, j));
      i = j;
    } else if (c === 'r' && /^r#*"/.test(source.slice(i, i + 8))) {
      const hashes = source.slice(i + 1).match(/^#*/)[0];
      const open = i + 1 + hashes.length;
      const close = source.indexOf(`"${hashes}`, open + 1);
      const stop = close === -1 ? n : close + 1 + hashes.length;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (c === 'b' && next === '"') {
      i += 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += blank(source.slice(i, j + 1));
      i = j + 1;
    } else if (c === "'" && (source[i + 2] === "'" || (next === '\\' && /^'\\(?:.|u\{[0-9a-fA-F]+\})'/.test(source.slice(i, i + 14))))) {
      const m = source.slice(i).match(/^'(?:[^'\\]|\\(?:.|u\{[0-9a-fA-F]+\}))'/);
      const len = m ? m[0].length : 3;
      out += blank(source.slice(i, i + len));
      i += len;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Every `fn` in a file, with its (comment- and string-stripped) body and the
 * attributes written immediately above it.
 */
export function extractFunctions(source, file) {
  const code = stripNonCode(source);
  const implRanges = blockRanges(code, /\bimpl\b/g);
  const fns = [];
  const header = /(?:^|[^\w])(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/g;
  let match;
  while ((match = header.exec(code)) !== null) {
    const name = match[1];
    const start = match.index + match[0].indexOf('fn ');
    // Where `pub`/`async`/... begin: the attributes sit directly above that.
    const headerStart = match.index + (/^\w/.test(match[0]) ? 0 : 1);
    // The body opens at the first `{` after the signature. `where` clauses
    // and return types never contain a bare `{`.
    let open = code.indexOf('{', header.lastIndex);
    const semicolon = code.indexOf(';', header.lastIndex);
    if (open === -1 || (semicolon !== -1 && semicolon < open)) continue; // a trait method declaration
    let depth = 0;
    let j = open;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = code.slice(open, j + 1);
    // Attributes: contiguous `#[...]` lines directly above the header.
    const before = code.slice(0, headerStart);
    const attrs = [];
    const attrPattern = /#\[[^\]]*\]\s*$/;
    let tail = before;
    for (;;) {
      const a = tail.match(attrPattern);
      if (!a) break;
      attrs.unshift(a[0].trim());
      tail = tail.slice(0, a.index);
    }
    const line = code.slice(0, start).split('\n').length;
    const isMethod = implRanges.some(([from, to]) => start > from && start < to);
    fns.push({
      name,
      file,
      line,
      body,
      attrs,
      isMethod,
      isTest: attrs.some((a) => /^#\[(?:tokio::)?test\b/.test(a)),
    });
    header.lastIndex = open;
  }
  return fns;
}

/** `[open, close]` offsets of the brace block that follows each match of `keyword`. */
function blockRanges(code, keyword) {
  const ranges = [];
  let m;
  while ((m = keyword.exec(code)) !== null) {
    const open = code.indexOf('{', m.index);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([open, j]);
    keyword.lastIndex = open;
  }
  return ranges;
}

/**
 * The functions of the crate that reach the gate, transitively: those whose
 * body names the gate, then those that call one of them, until nothing new.
 *
 * A callee is followed by its bare name when only one function in the crate
 * has that name; otherwise only a module-qualified call (`tags::push_tag(`)
 * or a call from the file that defines it is followed.
 */
export function gatedFunctions(fnsByFile) {
  const all = [...fnsByFile.values()].flat();
  const byName = new Map();
  for (const fn of all) {
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  const key = (fn) => `${fn.file}::${fn.name}`;
  const gated = new Map();
  for (const fn of all) if (GATE_PATTERN.test(fn.body)) gated.set(key(fn), { fn, via: 'the gate itself' });

  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of all) {
      if (gated.has(key(fn))) continue;
      const callee = callsAnyGated(fn, byName, gated);
      if (callee) {
        gated.set(key(fn), { fn, via: callee });
        changed = true;
      }
    }
  }
  return gated;
}

/**
 * Method names that std and the common crates also define. A `.status()` in
 * a body is far more likely to be `Command::status` than a method of this
 * crate, so a gated method with one of these names is only followed through
 * a `Type::name(` call, never through `.name(`.
 */
export const AMBIGUOUS_METHOD_NAMES = new Set([
  'output', 'status', 'spawn', 'push', 'get', 'set', 'new', 'default', 'run', 'send', 'wait',
  'start', 'stop', 'close', 'open', 'read', 'write', 'load', 'save', 'init', 'call', 'next',
  'clone', 'insert', 'remove', 'update', 'check', 'fetch', 'pull', 'clear', 'reset', 'refresh',
]);

/** The name of a gated function `fn` calls, with how, or null. */
function callsAnyGated(fn, byName, gated) {
  const callPattern = /(\.)?(?:([A-Za-z_]\w*)::)?([A-Za-z_]\w*)\s*(?:::<[^>]*>\s*)?\(/g;
  let m;
  while ((m = callPattern.exec(fn.body)) !== null) {
    const [, dot, qualifier, name] = m;
    const candidates = byName.get(name);
    if (!candidates) continue;
    const module = (f) => f.file.replace(/\.rs$/, '').split('/').pop();
    for (const candidate of candidates) {
      if (!gated.has(`${candidate.file}::${candidate.name}`)) continue;
      const unique = candidates.length === 1;
      const sameFile = candidate.file === fn.file;
      const qualified = qualifier !== undefined && qualifier === module(candidate);
      const methodCall = dot === '.';
      let followed;
      if (candidate.isMethod) {
        // `service.name(` for a name only this crate's impls define, or any
        // `.name(` in the file that defines it — unless std defines it too,
        // in which case only a `Type::name(` call is followed.
        followed = methodCall
          ? !AMBIGUOUS_METHOD_NAMES.has(name) && (unique || sameFile)
          : unique || sameFile || qualified;
      } else {
        // A free function is never called with `.name(`.
        followed = !methodCall && (unique || sameFile || qualified);
      }
      if (followed) return `${candidate.name} (${candidate.file}:${candidate.line})`;
    }
  }
  return null;
}

/**
 * Whether a test holds the policy lock: its own body, or the body of a helper
 * it calls (in its own file — test helpers live beside their tests),
 * mentions one of the lock-taking calls.
 */
export function holdsLock(fn, fnsInFile, seen = new Set(), lockPattern = LOCK_PATTERN) {
  if (lockPattern.test(fn.body)) return true;
  seen.add(fn.name);
  const callPattern = /(?:^|[^\w:])([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = callPattern.exec(fn.body)) !== null) {
    const callee = fnsInFile.find((f) => f.name === m[1]);
    if (callee && !seen.has(callee.name) && holdsLock(callee, fnsInFile, seen, lockPattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Every test that reaches the gate without holding the lock, across the crate.
 * Each entry names the test, where it is, and the call that reaches the gate.
 */
export function findUnlockedTests(files = listRustFiles(), lockPattern = LOCK_PATTERN) {
  const fnsByFile = new Map();
  for (const file of files) {
    fnsByFile.set(file, extractFunctions(readFileSync(join(REPO_ROOT, file), 'utf8'), file));
  }
  const gated = gatedFunctions(fnsByFile);
  const byName = new Map();
  for (const fn of [...fnsByFile.values()].flat()) {
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  const unlocked = [];
  const exposed = [];
  for (const [file, fns] of fnsByFile) {
    for (const fn of fns) {
      if (!fn.isTest) continue;
      const via = gated.has(`${file}::${fn.name}`) ? gated.get(`${file}::${fn.name}`).via : null;
      if (!via) continue;
      const entry = { file, line: fn.line, name: fn.name, via };
      exposed.push(entry);
      if (!holdsLock(fn, fns, new Set(), lockPattern)) unlocked.push(entry);
    }
  }
  return { exposed, unlocked, gated };
}

export function formatUnlocked(unlocked) {
  return unlocked.map((t) => `  ${t.file}:${t.line} ${t.name}  (reaches the gate via ${t.via})`).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exposed, unlocked } = findUnlockedTests();
  const perFile = new Map();
  for (const t of exposed) {
    const row = perFile.get(t.file) ?? { exposed: 0, unlocked: 0 };
    row.exposed += 1;
    perFile.set(t.file, row);
  }
  for (const t of unlocked) perFile.get(t.file).unlocked += 1;
  for (const [file, row] of [...perFile].sort()) {
    console.log(`${file}: ${row.exposed} tests reach the gate, ${row.unlocked} without the lock`);
  }
  if (unlocked.length > 0) {
    console.log(`\nUnlocked:\n${formatUnlocked(unlocked)}`);
    process.exitCode = 1;
  }
}
