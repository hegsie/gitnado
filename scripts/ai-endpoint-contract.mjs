/**
 * AI provider default-endpoint contract extraction.
 *
 * The AI network gate on the frontend judges the endpoint a provider will
 * really be contacted at, and falls back to a table of per-provider defaults
 * when the provider listing cannot be read. That table
 * (`PROVIDER_DEFAULT_ENDPOINTS` in `src/services/ai.service.ts`) is a declared
 * mirror of `AiProviderType::default_endpoint` in
 * `src-tauri/src/services/ai/mod.rs`, and nothing else in the repository
 * notices when the two drift: every test mocks the listing, so the fallback
 * only ever runs in a real build, at the moment the listing fails.
 *
 * A drift is not cosmetic. The frontend gate refuses or permits on the host it
 * reads from this table while the backend judges its own value, so a stale
 * entry makes the two gates disagree about one request — and a MISSING entry
 * leaves the frontend with no endpoint at all, which fails closed and blocks a
 * provider the backend would have served.
 *
 * The parsing is deliberately syntactic (no TypeScript or Rust compiler), so it
 * refuses to guess: an arm whose value is not a plain string literal is
 * reported rather than skipped. Both extractors are EXHAUSTIVE over their
 * body — every line they cannot read lands in `unparsed`, not on the floor.
 * A parser that matched only the shapes it expected quietly ignored the rest,
 * which is the one failure this check exists to prevent: a wildcard arm
 * (`_ => "https://…"`) or a spread in the object literal could redirect a
 * provider with the contract still green.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FRONTEND_FILE = join(REPO_ROOT, 'src', 'services', 'ai.service.ts');
export const BACKEND_FILE = join(REPO_ROOT, 'src-tauri', 'src', 'services', 'ai', 'mod.rs');

/**
 * `AiProviderType` is `#[serde(rename_all = "snake_case")]`, so `OpenAi`
 * crosses the IPC boundary as `open_ai`. This is that rename, not a general
 * case converter: serde lowercases each word and joins with `_`.
 */
export function serdeSnakeCase(variant) {
  return variant
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * A line carrying no declaration: blank, a comment, or bare block punctuation.
 *
 * Everything else in a body this module scans is a line it must either read or
 * report. Kept deliberately narrow — a line is skipped only when there is
 * demonstrably nothing in it.
 */
function isIgnorableLine(trimmed) {
  if (!trimmed) return true;
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return true;
  return /^[{}(),;]+$/.test(trimmed);
}

/**
 * An arm pattern, grouped or not: `AiProviderType::A` or
 * `AiProviderType::A | AiProviderType::B`. The enum already writes arms this
 * way elsewhere (`requires_api_key`), so `default_endpoint` may at any point,
 * and reading `A | B => "x"` as both variants mapping to `"x"` is Rust's own
 * meaning rather than a guess.
 */
const ARM_PATTERN = '((?:AiProviderType::\\w+\\s*\\|\\s*)*AiProviderType::\\w+)';
const BACKEND_LITERAL_ARM = new RegExp(`^${ARM_PATTERN}\\s*=>\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*,?$`);
const BACKEND_ANY_ARM = new RegExp(`^${ARM_PATTERN}\\s*=>`);

/** The variant names in a matched arm pattern, in source order. */
function armVariants(pattern) {
  return pattern.split('|').map((part) => /AiProviderType::(\w+)/.exec(part.trim())[1]);
}

/**
 * The `match self { Variant => "endpoint", … }` body of `default_endpoint`.
 *
 * Returns `{ endpoints, unparsed }` — `unparsed` names any arm whose value is
 * not a plain string literal, so a computed default is reported rather than
 * silently dropped, and holds the raw text of any other line in the body the
 * two arm shapes do not cover (a wildcard or `_ | …` arm, a match guard, the
 * body of a block arm).
 */
export function extractBackendDefaults(source) {
  const start = source.indexOf('fn default_endpoint');
  if (start === -1) {
    throw new Error('default_endpoint not found in the backend source');
  }
  const open = source.indexOf('{', source.indexOf('match self', start));
  if (open === -1) {
    throw new Error('default_endpoint has no match body');
  }
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(open + 1, end);

  const endpoints = {};
  const unparsed = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (isIgnorableLine(trimmed)) continue;
    const literal = BACKEND_LITERAL_ARM.exec(trimmed);
    if (literal) {
      for (const variant of armVariants(literal[1])) {
        endpoints[serdeSnakeCase(variant)] = literal[2];
      }
      continue;
    }
    const arm = BACKEND_ANY_ARM.exec(trimmed);
    if (arm) {
      unparsed.push(...armVariants(arm[1]));
      continue;
    }
    // Neither shape. Reported verbatim rather than skipped: a `_ =>` arm gives
    // every remaining variant an endpoint this module would otherwise never
    // see, and the whole point of the check is that it says what it cannot read.
    unparsed.push(trimmed);
  }
  return { endpoints, unparsed };
}

/**
 * The `PROVIDER_DEFAULT_ENDPOINTS` object literal.
 *
 * Returns `{ endpoints, unparsed }` with the same contract as the backend
 * extractor, exhaustiveness included: a spread (`...OTHER`), a quoted or
 * computed key, or any other line the entry shapes do not cover is reported
 * verbatim rather than dropped.
 */
export function extractFrontendDefaults(source) {
  const start = source.indexOf('PROVIDER_DEFAULT_ENDPOINTS');
  if (start === -1) {
    throw new Error('PROVIDER_DEFAULT_ENDPOINTS not found in the frontend source');
  }
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error('PROVIDER_DEFAULT_ENDPOINTS has no object literal');
  }
  const close = source.indexOf('};', open);
  const body = source.slice(open + 1, close);

  const endpoints = {};
  const unparsed = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (isIgnorableLine(trimmed)) continue;
    const literal = /^(\w+)\s*:\s*'((?:[^'\\]|\\.)*)'\s*,?$/.exec(trimmed);
    if (literal) {
      endpoints[literal[1]] = literal[2];
      continue;
    }
    const entry = /^(\w+)\s*:/.exec(trimmed);
    if (entry) {
      unparsed.push(entry[1]);
      continue;
    }
    // Neither shape — see the backend extractor. A spread would fill this table
    // from somewhere this module never reads.
    unparsed.push(trimmed);
  }
  return { endpoints, unparsed };
}

/** Read both halves from the real source files. */
export function readContract() {
  return {
    backend: extractBackendDefaults(readFileSync(BACKEND_FILE, 'utf8')),
    frontend: extractFrontendDefaults(readFileSync(FRONTEND_FILE, 'utf8')),
  };
}

/**
 * Every way the two halves can disagree: a provider the frontend does not
 * know, one it invents, and one whose endpoint differs.
 */
export function compareDefaults(backend, frontend) {
  const missing = Object.keys(backend).filter((name) => !(name in frontend));
  const extra = Object.keys(frontend).filter((name) => !(name in backend));
  const different = Object.keys(backend)
    .filter((name) => name in frontend && backend[name] !== frontend[name])
    .map((name) => ({ provider: name, backend: backend[name], frontend: frontend[name] }));
  return { missing, extra, different };
}
