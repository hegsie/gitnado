/**
 * Security-policy lock contract test.
 *
 * The failure this exists to catch: a Rust unit test that exercises a command
 * behind the backend network gate without holding the test-support lock. Such
 * a test passes on an idle machine and fails under load, the moment a test
 * that switched offline mode (or an allowlist) on happens to overlap it — the
 * merged tree went red that way twice in a day, in tests that had nothing to
 * do with the gate.
 *
 * `TestRepo` takes the reader guard by default, so most tests are covered
 * without knowing it. This test derives the rest: every function that reaches
 * the gate, transitively across the crate, and every test that calls one
 * without a `TestRepo` or a `test_support` guard in its body or its helpers.
 * The approximation's known blind spots are listed in `security-lock.mjs`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AMBIGUOUS_METHOD_NAMES,
  GATE_NAMES,
  GATE_PATTERN,
  LOCK_PATTERN,
  REPO_ROOT,
  SECURITY_FILE,
  deriveGateNames,
  extractFunctions,
  findUnlockedTests,
  formatUnlocked,
  gatePatternFor,
  gatedFunctions,
  holdsLock,
  importedGateNames,
  stripNonCode,
} from './security-lock.mjs';

/**
 * The gates this suite knows about by name. Asserted against the set derived
 * from `security.rs` below, so the list cannot silently fall behind the file.
 */
const KNOWN_GATES = [
  'check',
  'check_remote',
  'endpoint_allowed',
  'global',
  'guard_endpoint',
  'guard_push_remote',
  'guard_remote',
  'guard_remote_url',
  'guard_url',
];

// ---------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------

test('stripNonCode blanks comments and literals but keeps offsets', () => {
  const source = [
    'fn a() { // guard_url("x") in a comment',
    '  let s = "security::guard_url(";',
    '  let c = \'{\';',
    '  /* nested /* block */ still comment */ real()',
    '}',
  ].join('\n');
  const stripped = stripNonCode(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(stripped, /guard_url/);
  assert.doesNotMatch(stripped, /'\{'/);
  assert.match(stripped, /real\(\)/);
});

test('extractFunctions finds tests, helpers, methods and their attributes', () => {
  const source = `
    pub async fn command(path: String) -> Result<()> {
        crate::services::security::guard_remote(&path, None)?;
        Ok(())
    }
    impl Service {
        pub fn probe(&self) -> bool { true }
    }
    trait T { fn declared(&self); }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn helper() -> TestRepo { TestRepo::new() }
        #[tokio::test]
        async fn a_test() { command("x".into()).await.unwrap(); }
        #[test]
        fn a_plain_test() { helper(); }
    }
  `;
  const fns = extractFunctions(source, 'x.rs');
  const named = Object.fromEntries(fns.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(named).sort(), ['a_plain_test', 'a_test', 'command', 'helper', 'probe']);
  assert.equal(named.probe.isMethod, true);
  assert.equal(named.command.isMethod, false);
  assert.equal(named.a_test.isTest, true, 'an async #[tokio::test] is a test');
  assert.equal(named.a_plain_test.isTest, true);
  assert.equal(named.helper.isTest, false);
  assert.equal(named.a_test.line, 15);
  assert.match(named.command.body, GATE_PATTERN);
});

test('deriveGateNames reads the gate set out of security.rs, new gates included', () => {
  const source = `
    pub fn global() -> &'static SecurityState { &GLOBAL }
    pub fn check(s: &S, t: Option<&str>) -> Result<()> { check_target(s, t, is_local) }
    fn check_target(s: &S, t: Option<&str>, f: fn(&str) -> bool) -> Result<()> { Ok(()) }
    pub fn guard_url(url: &str) -> Result<()> { check(&global().snapshot(), Some(url)) }
    pub fn guard_ghost_url(url: &str) -> Result<()> { check(&global().snapshot(), Some(url)) }
    fn private_reader() -> bool { global().snapshot().offline_mode }
    pub fn url_host(url: &str) -> Option<String> { parse_url_target(url) }
    impl SecurityState { pub fn snapshot(&self) -> SecuritySettings { self.inner.clone() } }
    #[cfg(test)]
    pub(crate) mod test_support {
        pub(crate) fn no_policy() -> Guard { global().set(Default::default()); Guard }
    }
  `;
  const derived = deriveGateNames(source, 'security.rs');
  assert.deepEqual(
    [...derived].sort(),
    ['check', 'global', 'guard_ghost_url', 'guard_url'],
    'a new pub fn that reaches check/global is a gate without being listed anywhere'
  );
  assert.ok(!derived.has('private_reader'), 'a private reader is not reachable from the crate');
  assert.ok(!derived.has('no_policy'), 'test_support pins a policy; it is the lock, not the gate');
  assert.ok(!derived.has('url_host'), 'a function that never reaches the policy is not a gate');
  assert.ok(!derived.has('snapshot'), 'a method of SecurityState is not an exported gate');
});

test('importedGateNames resolves the names a use statement brings in', () => {
  const braced = importedGateNames(
    'use crate::services::security::{guard_remote_url, test_support::no_policy, url_host};'
  );
  assert.deepEqual([...braced.direct], ['guard_remote_url']);
  const single = importedGateNames('use crate::services::security::guard_url;');
  assert.deepEqual([...single.direct], ['guard_url']);
  const renamed = importedGateNames('use crate::services::security::guard_url as gu;');
  assert.deepEqual([...renamed.direct], ['gu']);
  const moduleAlias = importedGateNames('use crate::services::security as sec;');
  assert.deepEqual([...moduleAlias.modules].sort(), ['sec', 'security']);
  const glob = importedGateNames('use crate::services::security::*;');
  assert.deepEqual([...glob.direct], [], 'a glob import is a declared blind spot');
  const commented = importedGateNames('// use crate::services::security::guard_url;');
  assert.deepEqual([...commented.direct], [], 'a commented-out import imports nothing');
});

test('gatePatternFor sees an imported gate called unqualified, and only that call', () => {
  const source = 'use crate::services::security::guard_remote_url;';
  const pattern = gatePatternFor(source);
  assert.match('{ guard_remote_url("https://h/r.git").unwrap(); }', pattern);
  assert.match('{ security::guard_url("u")?; }', pattern);
  assert.doesNotMatch('{ other::guard_remote_url("u")?; }', pattern, 'another module of that name');
  assert.doesNotMatch('{ self.guard_remote_url("u")?; }', pattern, 'a method of that name');
  assert.doesNotMatch('{ guard_url("u")?; }', gatePatternFor(''), 'not imported, not in scope');
});

test('gatedFunctions follows an unqualified call to a gate the file imports', () => {
  const file = 'src-tauri/src/commands/tags.rs';
  const source = `
    use crate::services::security::guard_remote_url;
    #[test]
    fn unqualified_imported_gate() { guard_remote_url("https://github.com/o/r.git").unwrap(); }
  `;
  const fns = extractFunctions(source, file);
  const withSource = gatedFunctions(new Map([[file, fns]]), new Map([[file, source]]));
  assert.ok(withSource.has(`${file}::unqualified_imported_gate`));
  const withoutSource = gatedFunctions(new Map([[file, fns]]));
  assert.ok(
    !withoutSource.has(`${file}::unqualified_imported_gate`),
    'the module-qualified pattern alone cannot see it'
  );
});

test('gatedFunctions follows calls transitively, by name rules', () => {
  const a = extractFunctions(
    `
    fn gate() { crate::services::security::guard_url("u").unwrap(); }
    fn via_gate() { gate(); }
    fn unrelated() { other(); }
    impl S { pub fn probe(&self) { via_gate(); } pub fn output(&self) { gate(); } }
    fn calls_method(s: &S) { s.probe(); }
    fn calls_ambiguous(s: &S) { s.output(); }
    `,
    'src-tauri/src/a.rs'
  );
  const b = extractFunctions(
    `
    fn same_name() { }
    fn from_b() { a::via_gate(); }
    fn bare_from_b() { via_gate(); }
    `,
    'src-tauri/src/b.rs'
  );
  const gated = gatedFunctions(new Map([[a[0].file, a], [b[0].file, b]]));
  const names = [...gated.values()].map((g) => `${g.fn.file.split('/').pop()}::${g.fn.name}`).sort();
  assert.deepEqual(names, [
    'a.rs::calls_method',
    'a.rs::gate',
    'a.rs::output',
    'a.rs::probe',
    'a.rs::via_gate',
    'b.rs::bare_from_b',
    'b.rs::from_b',
  ]);
  assert.ok(AMBIGUOUS_METHOD_NAMES.has('output'));
  assert.ok(
    !names.includes('a.rs::calls_ambiguous'),
    'a `.output()` call is taken for std, even beside the impl that defines one'
  );
});

test('holdsLock sees TestRepo, test_support guards, and helpers that take them', () => {
  const fns = extractFunctions(
    `
    fn repo_helper() -> TestRepo { TestRepo::with_initial_commit() }
    fn plain_helper() -> u32 { 1 }
    fn via_helper() { let _r = repo_helper(); }
    fn via_plain() { plain_helper(); }
    fn direct() { let _g = test_support::offline(); }
    fn reader() { let _p = no_policy(); }
    fn none() { }
    `,
    'x.rs'
  );
  const named = Object.fromEntries(fns.map((f) => [f.name, f]));
  assert.equal(holdsLock(named.via_helper, fns), true);
  assert.equal(holdsLock(named.via_plain, fns), false);
  assert.equal(holdsLock(named.direct, fns), true);
  assert.equal(holdsLock(named.reader, fns), true);
  assert.equal(holdsLock(named.none, fns), false);
  assert.match('let repo = TestRepo::new();', LOCK_PATTERN);
});

// ---------------------------------------------------------------------------
// The crate
// ---------------------------------------------------------------------------

test('the gate set matches security.rs exactly, and TestRepo takes the guard', () => {
  const security = readFileSync(join(REPO_ROOT, SECURITY_FILE), 'utf8');
  for (const gate of KNOWN_GATES) {
    assert.match(security, new RegExp(`pub fn ${gate}\\(`), `security.rs no longer defines ${gate}`);
  }
  // Not just "each named gate still exists" — the set is derived from the
  // file, so a policy reader added there and named nowhere fails this too.
  assert.deepEqual(
    [...GATE_NAMES].sort(),
    KNOWN_GATES,
    'security.rs exports a policy reader this suite does not name (or no longer exports one)'
  );
  assert.match(security, /pub\(crate\) fn no_policy\(\)/, 'the shared reader guard exists');
  const testUtils = readFileSync(join(REPO_ROOT, 'src-tauri/src/test_utils.rs'), 'utf8');
  assert.match(testUtils, /test_support::no_policy\(\)/, 'TestRepo takes the reader guard');
});

test('the scan is not vacuous: the commands known to reach the gate are found', () => {
  const { gated, exposed } = findUnlockedTests();
  const has = (file, name) => gated.has(`src-tauri/src/${file}::${name}`);
  assert.ok(has('commands/tags.rs', 'delete_remote_tag'));
  assert.ok(has('commands/tags.rs', 'push_tag'));
  assert.ok(has('commands/remote.rs', 'fetch'));
  assert.ok(has('commands/repository.rs', 'clone_repository'));
  assert.ok(has('services/ai/mod.rs', 'provider_network_allowed'), 'a gated method is followed');
  assert.ok(has('services/ai/mod.rs', 'generate_commit_message'), 'through two more methods');
  assert.ok(has('commands/github.rs', 'check_github_connection'), 'through a provider api_client()');
  assert.ok(
    exposed.some((t) => t.name === 'test_delete_remote_tag_pre_push_hook_aborts'),
    'the test that failed under load is in the exposed set'
  );
  assert.ok(exposed.length >= 60, `expected dozens of exposed tests, found ${exposed.length}`);
});

test('every test that reaches the network gate holds the policy lock', () => {
  const { unlocked } = findUnlockedTests();
  assert.equal(
    unlocked.length,
    0,
    `${unlocked.length} test(s) reach the security gate without holding the lock and will ` +
      `fail under load whenever an offline-mode or allowlist test overlaps them. ` +
      `Build the repository with TestRepo, or take crate::services::security::test_support::no_policy():\n` +
      formatUnlocked(unlocked)
  );
});
