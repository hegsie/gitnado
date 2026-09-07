/**
 * Localisation coverage contract.
 *
 * The `@lit/localize` message id is a hash of the SOURCE TEXT, so a branch that
 * re-words a string that was already translated silently detaches its
 * translation: the merge is clean, the id changes, and the French UI falls back
 * to English for that one string. Nothing else in the repository notices.
 *
 * This module derives the truth from both halves instead of a hand-kept list:
 *   - every `msg()` call site in `src/**` (the ids the app will look up), and
 *   - every entry in the generated French bundle (the ids it can answer).
 * A test asserts the two sets are equal, so both drift (a source string with no
 * translation) and orphans (a translation with no source string) fail.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { generateMsgId } from '@lit/localize/internal/id-generation.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(REPO_ROOT, 'src');
export const FR_TEMPLATES = join(REPO_ROOT, 'src/i18n/generated/locales/fr.ts');
export const FR_XLIFF = join(REPO_ROOT, 'src/i18n/xliff/fr.xlf');
export const LOCALISATION_DOC = join(REPO_ROOT, 'docs/localisation.md');

/**
 * `inputFiles` as lit-localize.json states it. Kept literal so a change to the
 * config that this module does not follow shows up as a failing assertion
 * rather than as a silently narrower scan.
 */
export const EXPECTED_INPUT_FILES = ['src/**/*.ts', '!src/**/*.test.ts', '!src/i18n/generated/**'];

/** What lit-localize.json actually says today. */
export function configuredInputFiles(file = join(REPO_ROOT, 'lit-localize.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).inputFiles;
}

/** The same set of files EXPECTED_INPUT_FILES selects, given a path under src/. */
function isExtractableSource(relPath) {
  if (!relPath.endsWith('.ts')) return false;
  if (relPath.endsWith('.test.ts')) return false;
  const [first, second] = relPath.split(sep);
  return !(first === 'i18n' && second === 'generated');
}

/** Every `.ts` file lit-localize would extract from, as repo-relative paths. */
export function listSourceFiles(dir = SRC_DIR) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listSourceFiles(abs));
    } else if (isExtractableSource(relative(SRC_DIR, abs))) {
      out.push(abs);
    }
  }
  return out.sort();
}

/** The cooked template strings of a template literal, in source order. */
function cookedStrings(template) {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [template.text];
  return [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
}

function isCallee(expression, name) {
  return ts.isIdentifier(expression) && expression.text === name;
}

/**
 * Extract every statically analysable `msg()` message from one source file.
 *
 * Returns `{ messages, unanalysable }`. `unanalysable` holds call sites whose
 * argument is not a literal — those cannot be extracted by lit-localize either,
 * so they are a hole in the translation pipeline and the test fails on them.
 */
export function extractMessages(source, filePath) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const messages = [];
  const unanalysable = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isCallee(node.expression, 'msg')) {
      const [template] = node.arguments;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const site = { file: filePath, line: line + 1 };

      if (template && (ts.isStringLiteral(template) || ts.isNoSubstitutionTemplateLiteral(template))) {
        messages.push({ ...site, id: generateMsgId(template.text, false), source: template.text });
      } else if (
        template &&
        ts.isTaggedTemplateExpression(template) &&
        (isCallee(template.tag, 'str') || isCallee(template.tag, 'html'))
      ) {
        const isHtml = isCallee(template.tag, 'html');
        const strings = cookedStrings(template.template);
        messages.push({
          ...site,
          id: generateMsgId(strings, isHtml),
          // Rendered the way the XLIFF shows it, so a failure is searchable.
          source: strings.join('${…}'),
        });
      } else if (template) {
        unanalysable.push({ ...site, text: template.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { messages, unanalysable };
}

/** Every message the app can ask for, keyed by id (first call site wins). */
export function collectSourceMessages(files = listSourceFiles()) {
  const byId = new Map();
  const unanalysable = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const result = extractMessages(readFileSync(file, 'utf8'), rel);
    for (const message of result.messages) {
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
    unanalysable.push(...result.unanalysable);
  }
  return { byId, unanalysable };
}

/**
 * The ids the generated bundle answers. Parsed rather than imported: the bundle
 * is TypeScript, and a regex over the keys is enough because the file is
 * machine-written with one `'id': template` entry per line.
 */
export function collectTemplateIds(file = FR_TEMPLATES) {
  const source = readFileSync(file, 'utf8');
  return new Set([...source.matchAll(/^\s*'([hs][0-9a-f]{16})':/gm)].map((m) => m[1]));
}

/**
 * The English source text the XLIFF records for each id. Lets a report about an
 * orphaned translation quote the stale source text it was written against,
 * which is what tells a maintainer whether to re-point it or delete it.
 */
export function collectXliffSources(file = FR_XLIFF) {
  const xml = readFileSync(file, 'utf8');
  const units = xml.matchAll(
    /<trans-unit[^>]*\bid="([^"]+)"[^>]*>\s*<source>([\s\S]*?)<\/source>/g
  );
  const bySource = new Map();
  for (const [, id, source] of units) {
    bySource.set(
      id,
      source
        // `<x id="0" equiv-text="${expr}"/>` stands in for a template expression.
        .replace(/<x\b[^>]*\/>/g, '${\u2026}')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    );
  }
  return bySource;
}

/** The ids the XLIFF carries, so the two translation files cannot drift apart. */
export function collectXliffIds(file = FR_XLIFF) {
  return new Set(collectXliffSources(file).keys());
}

/** A repo-relative path with forward slashes, whatever the platform uses. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * Every source file with at least one `msg()` call site — i.e. every file that
 * is localised, derived rather than remembered.
 */
export function collectLocalisedFiles(files = listSourceFiles()) {
  const out = [];
  for (const file of files) {
    const rel = toPosix(relative(REPO_ROOT, file));
    if (extractMessages(readFileSync(file, 'utf8'), rel).messages.length > 0) out.push(rel);
  }
  return out.sort();
}

/**
 * The files `docs/localisation.md` says are localised: the backticked path that
 * opens each bullet of its "What is localised today" list.
 *
 * The doc is what a maintainer checks before re-wording a label, and a stale
 * one sends them to detach a translation — the exact failure the rest of this
 * module exists to catch — so the list is derived from here too.
 */
export function documentedLocalisedFiles(file = LOCALISATION_DOC) {
  const section = readFileSync(file, 'utf8')
    .split(/^## /m)
    .find((part) => part.startsWith('What is localised today'));
  if (section === undefined) {
    throw new Error(`${file} has no "## What is localised today" section to check`);
  }
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]).sort();
}

/** `a \ b`, as a sorted array. */
export function difference(a, b) {
  return [...a].filter((value) => !b.has(value)).sort();
}
