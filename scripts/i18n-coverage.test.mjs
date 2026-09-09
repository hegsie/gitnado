/**
 * Localisation coverage contract test.
 *
 * The failure this exists to catch: a `@lit/localize` message id is a hash of
 * the SOURCE TEXT, so re-wording a string that was already translated detaches
 * its translation. Two branches did exactly that — one translated the Security
 * descriptions, the other re-worded them — and both merged with no conflict, no
 * test failure, and five strings rendering English under `fr`.
 *
 * The previous guard was a hand-maintained list of ~20 source strings, so any
 * string it did not name could drift green. This one derives both sides:
 * every `msg()` call site in `src/**` against every entry in the generated
 * French bundle, and asserts set equality in both directions — a source string
 * with no translation AND a translation with no source string both fail.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateMsgId } from '@lit/localize/internal/id-generation.js';

import {
  EXPECTED_INPUT_FILES,
  collectLocalisedFiles,
  collectSourceMessages,
  collectTemplateIds,
  collectXliffIds,
  collectXliffSources,
  configuredInputFiles,
  difference,
  documentedLocalisedFiles,
  extractMessages,
  listSourceFiles,
} from './i18n-coverage.mjs';

// ---------------------------------------------------------------------------
// The extractor itself
// ---------------------------------------------------------------------------

test('extracts every msg() shape and skips everything else', () => {
  const source = `
    import { msg, str } from '@lit/localize';
    const a = msg('Open');
    const b = msg(\`Clone\`);
    const c = msg(str\`\${label} copied to clipboard\`);
    const d = notMsg('Not a message');
    const e = other.msg('Also not a message');
  `;
  const { messages, unanalysable } = extractMessages(source, 'src/x.ts');

  assert.deepEqual(
    messages.map((m) => m.source),
    ['Open', 'Clone', '${…} copied to clipboard']
  );
  assert.deepEqual(unanalysable, []);
  // Line numbers land on the call site, so a failure points somewhere.
  assert.deepEqual(
    messages.map((m) => m.line),
    [3, 4, 5]
  );
});

test('reports a msg() argument that cannot be extracted', () => {
  const { messages, unanalysable } = extractMessages(
    `const label = 'x'; const a = msg(label);`,
    'src/x.ts'
  );
  assert.deepEqual(messages, []);
  assert.equal(unanalysable.length, 1);
  assert.equal(unanalysable[0].text, 'label');
});

test('computes the same ids lit-localize does', () => {
  // Golden pairs taken from the checked-in bundle: if these stop matching, the
  // id derivation below has drifted from the one the runtime uses and every
  // other assertion in this file is meaningless.
  assert.equal(generateMsgId('Open', false), 's1f7698c061c208c9');
  assert.equal(generateMsgId('Clone', false), 's5e2654fb8587f442');
  assert.equal(generateMsgId(['', ' copied to clipboard'], false), 's0c4a4d4b0cf3c4de');
  // The html/string prefix and the record separator both matter.
  assert.notEqual(generateMsgId('Open', true), generateMsgId('Open', false));
  assert.notEqual(generateMsgId(['a', 'b'], false), generateMsgId('ab', false));
});

test('scans exactly the files lit-localize is configured to extract from', () => {
  assert.deepEqual(
    configuredInputFiles(),
    EXPECTED_INPUT_FILES,
    'lit-localize.json changed which files it extracts from — teach listSourceFiles() the new rule'
  );

  const files = listSourceFiles();
  assert.ok(files.length > 0, 'found source files');
  assert.ok(
    files.some((f) => f.endsWith('components/dialogs/lv-settings-dialog.ts')),
    'includes the settings dialog'
  );
  for (const file of files) {
    assert.ok(!file.endsWith('.test.ts'), `${file} is a test`);
    assert.ok(!file.includes('/i18n/generated/'), `${file} is generated`);
  }
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

const { byId: sourceMessages, unanalysable } = collectSourceMessages();
const sourceIds = new Set(sourceMessages.keys());
const xliffSources = collectXliffSources();
const describe = (id) => {
  const message = sourceMessages.get(id);
  if (message) return `  ${id}  ${JSON.stringify(message.source)}\n    ${message.file}:${message.line}`;
  const stale = xliffSources.get(id);
  return stale === undefined
    ? `  ${id}  (no msg() call site, and no source recorded in the XLIFF)`
    : `  ${id}  translated against ${JSON.stringify(stale)}\n    no msg() call site produces that text any more`;
};

test('every msg() call site is statically extractable', () => {
  assert.deepEqual(
    unanalysable.map((u) => `${u.file}:${u.line} msg(${u.text})`),
    [],
    'msg() must be called with a literal, or lit-localize cannot extract it and it can never be translated'
  );
});

test('every msg() source string has a French translation', () => {
  const missing = difference(sourceIds, collectTemplateIds());
  assert.deepEqual(
    missing,
    [],
    `${missing.length} string(s) render English under "fr" because nothing in ` +
      `src/i18n/generated/locales/fr.ts answers their id. Add a trans-unit to ` +
      `src/i18n/xliff/fr.xlf and the matching entry to the bundle:\n` +
      missing.map(describe).join('\n')
  );
});

test('every French translation still has a msg() source string', () => {
  const orphaned = difference(collectTemplateIds(), sourceIds);
  assert.deepEqual(
    orphaned,
    [],
    `${orphaned.length} translation(s) in src/i18n/generated/locales/fr.ts are ` +
      `dead — no msg() call site hashes to their id, so the source text was ` +
      `re-worded or removed. Re-point or delete them (and their trans-unit in ` +
      `src/i18n/xliff/fr.xlf):\n` +
      orphaned.map(describe).join('\n')
  );
});

test('docs/localisation.md names exactly the files that are localised', () => {
  // The doc is what a maintainer reads before re-wording a label, and it went
  // stale inside a single stack: it named three surfaces while later commits
  // put msg() into three more files, so re-wording a string in one of those
  // looked safe and would have silently detached its translation.
  assert.deepEqual(
    documentedLocalisedFiles(),
    collectLocalisedFiles(),
    'the "What is localised today" list in docs/localisation.md no longer matches the ' +
      'files that contain msg() calls — add (or remove) a bullet whose first backticked ' +
      'value is the repo-relative path'
  );
});

test('the XLIFF and the generated bundle carry the same ids', () => {
  const templates = collectTemplateIds();
  const xliff = collectXliffIds();
  assert.deepEqual(
    difference(xliff, templates),
    [],
    'translated in src/i18n/xliff/fr.xlf but missing from the generated bundle — re-run lit-localize build'
  );
  assert.deepEqual(
    difference(templates, xliff),
    [],
    'in the generated bundle but not in src/i18n/xliff/fr.xlf — the bundle was hand-edited'
  );
});
