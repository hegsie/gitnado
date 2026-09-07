import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from './dependabot-auto-merge.mjs';

const workflow = (file) =>
  readFileSync(fileURLToPath(new URL(`../workflows/${file}`, import.meta.url)), 'utf8');

const AUTO_MERGE_YML = workflow('dependabot-auto-merge.yml');

const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** An earlier push on the same branch. */
const STALE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function dependabotCommit({ name = 'glob', version = '0.3.4', updateType = 'patch' } = {}) {
  return [
    `deps(cargo): bump ${name}`,
    '',
    '---',
    'updated-dependencies:',
    `- dependency-name: ${name}`,
    `  dependency-version: ${version}`,
    '  dependency-type: direct:production',
    `  update-type: version-update:semver-${updateType}`,
    '...',
    '',
    'Signed-off-by: dependabot[bot] <support@github.com>',
  ].join('\n');
}

const green = (name, head_sha = HEAD_SHA) => ({
  name,
  head_sha,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
});

/**
 * Builds a world where everything is in order, so each test can break exactly
 * one thing and assert on the consequence.
 */
function harness(overrides = {}) {
  const calls = { merged: [], comments: [], failures: [], info: [] };

  const state = {
    eventName: 'workflow_run',
    pr: {
      number: 318,
      state: 'open',
      draft: false,
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main' },
      head: { sha: HEAD_SHA },
    },
    openPullRequests: [{ number: 318, user: { login: 'dependabot[bot]' }, draft: false }],
    workflowRuns: [green('CI'), green('Build & Release'), green('CodeQL')],
    checkRuns: [
      { name: 'Lint Frontend', status: 'completed', conclusion: 'success' },
      { name: 'Auto-merge', status: 'in_progress', conclusion: null },
    ],
    combinedStatus: { state: 'pending', statuses: [] },
    commits: [dependabotCommit()],
    existingComments: [],
    mergeError: null,
    ...overrides,
  };

  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getCombinedStatusForRef: async () => ({ data: state.combinedStatus }),
      },
      pulls: {
        list: async () => ({ data: state.openPullRequests }),
        get: async () => ({ data: state.pr }),
        listCommits: () => state.commits.map((message) => ({ commit: { message } })),
        merge: async (params) => {
          if (state.mergeError) throw state.mergeError;
          calls.merged.push(params);
          return { data: { merged: true } };
        },
      },
      actions: { listWorkflowRunsForRepo: () => state.workflowRuns },
      checks: { listForRef: () => state.checkRuns },
      issues: {
        listComments: () => state.existingComments,
        createComment: async (params) => {
          calls.comments.push(params);
        },
      },
    },
    // The real Octokit paginate flattens the endpoint's collection; the stubs
    // above already return arrays.
    paginate: async (endpoint, params) => {
      const result = endpoint(params);
      return result instanceof Promise ? (await result).data : result;
    },
  };

  const core = {
    info: (message) => calls.info.push(message),
    setFailed: (message) => calls.failures.push(message),
    summary: {
      addRaw() {
        return this;
      },
      async write() {},
    },
  };

  const context = {
    get eventName() {
      return state.eventName;
    },
    repo: { owner: 'hegsie', repo: 'Gitnado' },
    payload: {
      workflow_run: { head_branch: 'dependabot/cargo/src-tauri/glob-0.3.4', head_sha: HEAD_SHA },
      repository: { default_branch: 'main' },
    },
  };

  return { github, core, context, state, calls };
}

const only = (results) => {
  assert.equal(results.length, 1);
  return results[0];
};

let h;
beforeEach(() => {
  h = harness();
});

test('merges a compatible update by squash, pinned to the tested commit', async () => {
  const result = only(await run(h));

  assert.equal(result.merged, true);
  assert.deepEqual(h.calls.merged, [
    {
      owner: 'hegsie',
      repo: 'Gitnado',
      pull_number: 318,
      merge_method: 'squash',
      sha: HEAD_SHA,
    },
  ]);
  assert.equal(h.calls.comments.length, 0);
});

test('holds a breaking update, and says why exactly once', async () => {
  h = harness({ commits: [dependabotCommit({ name: 'base64', version: '0.23.1', updateType: 'minor' })] });

  const result = only(await run(h));
  assert.equal(result.merged, false);
  assert.equal(h.calls.merged.length, 0);
  assert.equal(h.calls.comments.length, 1);
  assert.match(h.calls.comments[0].body, /base64 -> 0\.23\.1/);

  // A rebase re-runs CI and lands here again; the note must not repeat.
  h.state.existingComments = [{ body: h.calls.comments[0].body }];
  await run(h);
  assert.equal(h.calls.comments.length, 1);
});

test("refuses a pull request that is not Dependabot's", async () => {
  h.state.pr.user.login = 'hegsie';

  const result = only(await run(h));
  assert.match(result.reason, /opened by hegsie/);
  assert.equal(h.calls.merged.length, 0);
});

test('refuses a draft', async () => {
  h.state.pr.draft = true;

  assert.equal(only(await run(h)).merged, false);
  assert.equal(h.calls.merged.length, 0);
});

test('refuses a pull request aimed somewhere other than the default branch', async () => {
  h.state.pr.base.ref = 'release/v0.6.0';

  assert.match(only(await run(h)).reason, /targets release\/v0\.6\.0/);
  assert.equal(h.calls.merged.length, 0);
});

test('waits for a workflow that is still running', async () => {
  h.state.workflowRuns.push({
    name: 'CodeQL',
    head_sha: HEAD_SHA,
    event: 'pull_request',
    status: 'in_progress',
    conclusion: null,
  });

  assert.match(only(await run(h)).reason, /waiting on CodeQL \(in_progress\)/);
  assert.equal(h.calls.merged.length, 0);
});

test('refuses when a workflow other than the trigger failed', async () => {
  h.state.workflowRuns = [
    green('CI'),
    {
      name: 'Build & Release',
      head_sha: HEAD_SHA,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
    },
  ];

  assert.match(only(await run(h)).reason, /Build & Release \(failure\)/);
  assert.equal(h.calls.merged.length, 0);
});

test('refuses a commit that no workflow has registered a run for yet', async () => {
  // The window just after a push, where "nothing has failed" is vacuously true.
  h.state.workflowRuns = [];

  assert.match(only(await run(h)).reason, /no workflow runs have registered/);
  assert.equal(h.calls.merged.length, 0);
});

test('a green run on another commit does not stand in for this one', async () => {
  // The dangerous direction: readiness satisfied by a commit nobody tested.
  h.state.workflowRuns = [green('CI', STALE_SHA), green('Build & Release', STALE_SHA)];

  assert.match(only(await run(h)).reason, /no workflow runs have registered/);
  assert.equal(h.calls.merged.length, 0);
});

test('runs superseded by a later push do not block forever', async () => {
  // ci.yml cancels superseded runs, so an earlier commit routinely leaves a
  // cancelled run and an in-progress one behind.
  h.state.workflowRuns.push(
    { name: 'CI', head_sha: STALE_SHA, event: 'pull_request', status: 'completed', conclusion: 'cancelled' },
    { name: 'Build & Release', head_sha: STALE_SHA, event: 'pull_request', status: 'in_progress', conclusion: null },
  );

  assert.equal(only(await run(h)).merged, true);
});

test('ignores workflow runs that are not the pull request\'s own checks', async () => {
  h.state.workflowRuns.push({
    name: 'Dependabot Updates',
    head_sha: HEAD_SHA,
    event: 'dynamic',
    status: 'completed',
    conclusion: 'failure',
  });

  assert.equal(only(await run(h)).merged, true);
});

test('ignores its own workflow run and its own check run', async () => {
  // Guards the deadlock where the job waits for a check that is itself.
  h.state.workflowRuns.push({
    name: 'Dependabot auto-merge',
    head_sha: HEAD_SHA,
    event: 'pull_request',
    status: 'in_progress',
    conclusion: null,
  });
  assert.equal(h.state.checkRuns.some((check) => check.name === 'Auto-merge'), true);

  assert.equal(only(await run(h)).merged, true);
});

test('treats neutral and skipped results as passing', async () => {
  h.state.workflowRuns.push({
    name: 'Optional',
    head_sha: HEAD_SHA,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'skipped',
  });
  h.state.checkRuns.push({ name: 'E2E Tests', status: 'completed', conclusion: 'skipped' });

  assert.equal(only(await run(h)).merged, true);
});

test('refuses when a check run from another app is failing', async () => {
  h.state.checkRuns.push({ name: 'external/scan', status: 'completed', conclusion: 'failure' });

  assert.match(only(await run(h)).reason, /external\/scan \(failure\)/);
  assert.equal(h.calls.merged.length, 0);
});

test('a commit with no statuses does not read as pending', async () => {
  assert.equal(h.state.combinedStatus.state, 'pending');
  assert.equal(only(await run(h)).merged, true);
});

test('refuses when a real commit status is failing', async () => {
  h.state.combinedStatus = { state: 'failure', statuses: [{ context: 'legacy/check' }] };

  assert.match(only(await run(h)).reason, /state "failure"/);
  assert.equal(h.calls.merged.length, 0);
});

test('fails the job loudly when the token cannot merge', async () => {
  h.state.mergeError = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });

  assert.equal(only(await run(h)).merged, false);
  assert.equal(h.calls.failures.length, 1);
  assert.match(h.calls.failures[0], /DEPENDABOT_AUTOMERGE_TOKEN/);
});

test('stays quiet when the branch went stale between the check and the merge', async () => {
  h.state.mergeError = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });

  const result = only(await run(h));
  assert.equal(result.merged, false);
  // Dependabot will rebase and CI will run again, so this is not a failure.
  assert.equal(h.calls.failures.length, 0);
  assert.match(result.reason, /Could not merge #318/);
});

test('does nothing when the triggering branch has no open pull request', async () => {
  h.state.openPullRequests = [];

  assert.match(only(await run(h)).reason, /No open Dependabot pull request/);
  assert.equal(h.calls.merged.length, 0);
});

test('the sweep considers every open Dependabot pull request', async () => {
  // The safety net for a workflow that finished without a matching trigger.
  h.state.eventName = 'schedule';
  h.state.openPullRequests = [
    { number: 318, user: { login: 'dependabot[bot]' }, draft: false },
    { number: 313, user: { login: 'dependabot[bot]' }, draft: false },
  ];
  const seen = [];
  h.github.rest.pulls.get = async ({ pull_number }) => {
    seen.push(pull_number);
    return { data: { ...h.state.pr, number: pull_number } };
  };

  const results = await run(h);
  assert.deepEqual(seen, [318, 313]);
  assert.equal(results.length, 2);
  assert.deepEqual(
    h.calls.merged.map((call) => call.pull_number),
    [318, 313],
  );
});

test('the sweep skips pull requests that are not Dependabot drafts of its own', async () => {
  h.state.eventName = 'schedule';
  h.state.openPullRequests = [
    { number: 345, user: { login: 'hegsie' }, draft: false },
    { number: 346, user: { login: 'dependabot[bot]' }, draft: true },
  ];

  assert.match(only(await run(h)).reason, /No open Dependabot pull request/);
  assert.equal(h.calls.merged.length, 0);
});

test('the workflow job is named what the self-check filter looks for', () => {
  // If these drift apart the job waits for its own check run and never merges.
  assert.match(AUTO_MERGE_YML, /^ {4}name: Auto-merge$/m);
});

test('the workflow is named what the self-run filter looks for', () => {
  assert.match(AUTO_MERGE_YML, /^name: Dependabot auto-merge$/m);
});

test('the workflow waits on every workflow file that runs against a pull request', () => {
  // CodeQL is not covered here: it comes from GitHub's default setup and has no
  // file to read, so it is asserted separately below.
  for (const file of ['ci.yml', 'build.yml']) {
    const source = workflow(file);
    assert.match(source, /^ {2}pull_request:$/m, `${file} should run on pull requests`);
    const name = /^name:\s*(.+)$/m.exec(source)[1].trim();
    assert.ok(
      AUTO_MERGE_YML.includes(`\n      - ${name}\n`),
      `${name} runs on pull requests but auto-merge does not wait for it`,
    );
  }
});

test('the workflow waits on default-setup CodeQL', () => {
  assert.ok(AUTO_MERGE_YML.includes('\n      - CodeQL\n'));
});

test('the workflow keeps a sweep scheduled as the safety net', () => {
  // Without this, a workflow missing from the wait list can leave a green pull
  // request unmerged indefinitely.
  assert.match(AUTO_MERGE_YML, /^ {2}schedule:$/m);
  assert.match(AUTO_MERGE_YML, /^ {4}- cron: '.+'$/m);
});
