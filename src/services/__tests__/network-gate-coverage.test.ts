/**
 * Exhaustive guard on the network gate's coverage.
 *
 * Twice now the gate has shipped covering less than it claimed, both times for
 * the same reason: coverage was a hand-written list, so it only held what
 * someone remembered to add. Round 18 missed six operations. Round 19 missed a
 * seventh (`prune_remote_tracking_branches`) plus every hosting-provider API —
 * and the test written to catch that class of gap missed them too, because it
 * was another hand-written list of *functions*.
 *
 * This test inverts it. It turns offline mode on, calls EVERY exported function
 * in the services that can reach the network, and asserts that not one of them
 * reaches a command known to make an outbound request. Adding an ungated
 * network call fails this test without anyone having to remember to register it.
 *
 * Round 20 showed the inversion was only half done: the sweep enumerated
 * git.service and nothing else, so `download_model` (multi-GB, huggingface.co),
 * `download_embedding_model` and the two GitHub App endpoints in
 * credential.service shipped with no frontend gate and a green suite. Every
 * service that invokes a command capable of leaving the machine is swept here
 * now — see SWEPT_MODULES.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: string[] = [];

(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: ((command: string) => {
    invoked.push(command);
    // Shapes permissive enough that callers which post-process a result don't
    // throw before reaching their invoke.
    if (command === 'get_remotes') return Promise.resolve([]);
    return Promise.resolve(null);
  }) as MockInvoke,
  transformCallback: () => 0,
};

/**
 * The sweep calls `copyToClipboard` like every other export. The real async
 * clipboard API leaves its promise pending in a headless browser — no
 * permission, no user gesture — which used to hang both sweeps until the
 * 10 s mocha timeout, and got written off as load flakiness for months.
 *
 * `copyToClipboard` now bounds that wait itself, so the sweep no longer hangs
 * either way; this stub keeps it instant and deterministic instead of paying
 * the timeout, exactly as `__TAURI_INTERNALS__` above stubs the IPC layer.
 * The sweep still calls the function and still checks what it invoked, so
 * nothing the test guards is weakened.
 */
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
  configurable: true,
  writable: true,
});

import { expect } from '@open-wc/testing';
import * as gitService from '../git.service.ts';
import * as credentialService from '../credential.service.ts';
import * as localAiService from '../local-ai.service.ts';
import * as updateService from '../update.service.ts';
import { embeddingIndexService } from '../embedding-index.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

/**
 * Tauri commands that make an outbound request.
 *
 * `detect_*_repo` parse the local remote URL, `gitflow_*` are local git
 * operations, and `lfs_prune` / `init_submodules` / `sync_submodules` /
 * `get_remote_status` touch only on-disk state — all deliberately absent.
 */
const NETWORK_COMMANDS = new Set([
  // git operations
  'clone_repository', 'fetch', 'pull', 'push', 'push_tag', 'delete_remote_tag',
  'push_to_multiple_remotes', 'fetch_all_remotes', 'add_submodule',
  'update_submodules', 'lfs_pull', 'lfs_fetch',
  'prune_remote_tracking_branches', 'start_auto_fetch',
  // `deepen_repository` and `unshallow_repository` both shell out to
  // `git fetch` (`--deepen` / `--unshallow`); `test_credentials` opens an
  // `ssh -T` session to the remote's host when the remote is an SSH one. All
  // three were absent from this list, so the sweep called them, they invoked,
  // and it stayed green - this file's own documented failure mode.
  'deepen_repository', 'unshallow_repository', 'test_credentials',
  // hosting-provider APIs
  'check_ado_connection', 'check_github_connection', 'check_gitlab_connection',
  'create_ado_pull_request', 'create_azure_devops_work_item',
  'create_bitbucket_issue', 'create_bitbucket_pull_request',
  'create_gitlab_issue', 'create_gitlab_merge_request', 'create_issue',
  'create_pull_request', 'create_release', 'delete_release',
  'get_ado_pull_request', 'get_ado_work_items', 'get_bitbucket_pull_request',
  'get_check_runs', 'get_gitlab_labels', 'get_gitlab_merge_request',
  'get_issue', 'get_issue_comments', 'get_latest_release', 'get_pull_request',
  'get_pull_request_reviews', 'get_release_by_tag', 'get_workflow_runs',
  'list_ado_organizations', 'list_ado_pipeline_runs', 'list_ado_pull_requests',
  'list_bitbucket_issues', 'list_bitbucket_pipelines',
  'list_bitbucket_pull_requests', 'list_gitlab_issues',
  'list_gitlab_merge_requests', 'list_gitlab_pipelines', 'list_issues',
  'list_pull_requests', 'list_releases', 'query_ado_work_items',
  'test_ssh_connection', 'update_issue_state', 'add_issue_comment',
  'get_repo_labels', 'check_bitbucket_connection',
  'check_bitbucket_connection_with_token',
  // account repository listings (clone dialog's "From account" picker)
  'list_github_repositories', 'list_gitlab_projects',
  'list_bitbucket_repositories', 'list_ado_repositories',
  // GitHub App auth — `configure_github_app` mints an installation token from
  // api.github.com before it stores anything, and the installation listing is
  // a plain API read.
  'configure_github_app', 'list_github_app_installations',
  // model weights, fetched from huggingface.co
  'download_model', 'download_embedding_model',
  // the auto-updater: `check_for_update` fetches latest.json from the release
  // host and `download_and_install_update` pulls a binary and runs it.
  'check_for_update', 'download_and_install_update',
]);

/**
 * Commands that must NEVER be gated: they read local files only. Routing one
 * through the provider wrapper would make offline mode refuse something that
 * never left the machine — which is what happened to the issue-template
 * readers, latent only because nothing calls them yet.
 */
const LOCAL_COMMANDS = new Set([
  // keyring reads/writes and the local-AI + embedding operations that only
  // touch this machine. Gating any of these would make offline mode hide the
  // controls that turn offline mode off, or refuse an already-downloaded model.
  'get_keyring_token', 'store_keyring_token', 'delete_keyring_token',
  'get_github_app_config', 'remove_github_app_config',
  'detect_credential_manager',
  'get_system_capabilities', 'get_available_models', 'get_downloaded_models',
  'get_recommended_model', 'get_model_status', 'get_loaded_model_name',
  'load_model', 'unload_model', 'delete_model', 'cancel_model_download',
  'build_embedding_index', 'refresh_embedding_index', 'semantic_search',
  'get_embedding_index_status', 'cancel_embedding_build',
  'is_embedding_model_downloaded',
  'get_issue_templates',
  'get_issue_template_content',
  'lfs_prune',
  'init_submodules',
  'sync_submodules',
  'get_remote_status',
  'detect_github_repo',
  'detect_gitlab_repo',
  'detect_bitbucket_repo',
  'detect_ado_repo',
  // update.service: reading the running version, and the three commands that
  // only start/stop/inspect the periodic timer. The timer is deliberately NOT
  // gated here — every tick of it runs the backend gate itself, so turning
  // offline mode back off resumes updates without a restart. Gating the
  // scheduling call would break exactly that.
  'get_app_version',
  'start_auto_update_check',
  'stop_auto_update_check',
  'is_auto_update_running',
]);

/**
 * Exports that register long-lived listeners or intentionally never invoke.
 * Calling them would leak subscriptions across the suite, and none of them
 * reach the network themselves.
 */
const SKIP = new Set([
  'setupRemoteOperationListeners',
  'cleanupRemoteOperationListeners',
  'onFileChange',
  'onOperationProgress',
  'isNetworkGateRefusal',
  // local-ai.service: registers app-lifetime Tauri event listeners.
  'listenForModelDownloadFailures',
  // embedding-index.service: same, for the index progress events.
  'onProgress',
  // update.service: app-lifetime Tauri event listeners for the updater's
  // progress and result events. None of them invoke a command.
  'onUpdateAvailable',
  'onUpdateChecked',
  'onUpdateDownloading',
  'onDownloadProgress',
  'onUpdateReady',
  'onUpdateError',
]);

/**
 * Every service whose exports can reach a Tauri command that leaves the
 * machine. A service listed here is swept whole — no per-function registry to
 * keep up to date, which is the entire point of this file.
 *
 * Deliberately NOT listed: services that only ever invoke commands in
 * LOCAL_COMMANDS, and ai.service, whose gate is pinned by its own
 * `ai.service.test.ts` because its refusal depends on which provider is active.
 */
const SWEPT_MODULES: Array<{ label: string; entries: Array<[string, unknown]> }> = [
  { label: 'git.service', entries: Object.entries(gitService) },
  { label: 'credential.service', entries: Object.entries(credentialService) },
  { label: 'local-ai.service', entries: Object.entries(localAiService) },
  // The auto-updater was the last outbound path with no frontend gate and no
  // entry in this sweep — and the only one that runs unattended and installs a
  // binary. It is swept whole now, like everything else here.
  { label: 'update.service', entries: Object.entries(updateService) },
  {
    label: 'embedding-index.service',
    // A class instance: its methods live on the prototype, so Object.entries
    // would return nothing and the sweep would pass vacuously.
    entries: Object.getOwnPropertyNames(
      Object.getPrototypeOf(embeddingIndexService) as object,
    )
      .filter((name) => name !== 'constructor')
      .map((name) => [
        name,
        (embeddingIndexService as unknown as Record<string, unknown>)[name],
      ]) as Array<[string, unknown]>,
  },
];

/**
 * Every callable the sweep will exercise: each module's exported functions,
 * plus the methods of exported namespace objects (credential.service groups
 * per-provider credential helpers that way, and a gap could hide in one).
 */
function sweptCallables(): Array<{ label: string; name: string; fn: (...a: unknown[]) => unknown }> {
  const out: Array<{ label: string; name: string; fn: (...a: unknown[]) => unknown }> = [];
  for (const { label, entries } of SWEPT_MODULES) {
    for (const [name, value] of entries) {
      if (SKIP.has(name)) continue;
      if (typeof value === 'function') {
        out.push({ label, name, fn: value as (...a: unknown[]) => unknown });
        continue;
      }
      // A plain namespace object of helpers (GitHubCredentials, ...).
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
          if (typeof member === 'function' && !SKIP.has(key)) {
            out.push({
              label,
              name: `${name}.${key}`,
              fn: (member as (...a: unknown[]) => unknown).bind(value),
            });
          }
        }
      }
    }
  }
  return out;
}

/** A grab-bag of arguments wide enough to get any of these functions to its
 * invoke. Extra arguments are ignored by JS; missing ones arrive undefined. */
const ARGS: unknown[] = [
  { path: '/repo', name: 'v1', url: 'https://example.test/x.git', title: 't', head: 'h', base: 'b' },
  'https://example.test/x.git',
  'main',
  'feature',
  1,
];

describe('network gate coverage', () => {
  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  it('offline mode stops every exported function from reaching a network command', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const leaked = new Map<string, string>();
    for (const { label, name, fn } of sweptCallables()) {
      invoked.length = 0;
      try {
        await fn(...ARGS);
      } catch {
        // A rejected call is fine — it certainly didn't reach the network.
      }
      const hit = invoked.find((c) => NETWORK_COMMANDS.has(c));
      if (hit) leaked.set(`${label}: ${name}`, hit);
    }

    expect(
      Array.from(leaked, ([fn, cmd]) => `${fn} -> ${cmd}`),
      'these reached the network with offline mode on',
    ).to.deep.equal([]);
  });

  it('offline mode does not block commands that never leave the machine', async () => {
    // Routing a local read through the provider wrapper makes offline mode
    // refuse something that never left the machine. The issue-template readers
    // only `fs::read` well-known paths under the repo directory.
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const localCalls: Array<{ name: string; command: string; run: () => Promise<unknown> }> = [
      {
        name: 'getIssueTemplates',
        command: 'get_issue_templates',
        run: () => gitService.getIssueTemplates('/repo'),
      },
      {
        name: 'getIssueTemplateContent',
        command: 'get_issue_template_content',
        run: () => gitService.getIssueTemplateContent('/repo', '.github/ISSUE_TEMPLATE/bug.md'),
      },
      { name: 'lfsPrune', command: 'lfs_prune', run: () => gitService.lfsPrune('/repo') },
      {
        name: 'initSubmodules',
        command: 'init_submodules',
        run: () => gitService.initSubmodules('/repo'),
      },
      {
        name: 'syncSubmodules',
        command: 'sync_submodules',
        run: () => gitService.syncSubmodules('/repo'),
      },
      {
        name: 'getRemoteStatus',
        command: 'get_remote_status',
        run: () => gitService.getRemoteStatus('/repo'),
      },
    ];

    const blocked: string[] = [];
    for (const local of localCalls) {
      invoked.length = 0;
      try {
        await local.run();
      } catch {
        /* ignore */
      }
      if (!invoked.includes(local.command)) blocked.push(`${local.name} -> ${local.command}`);
    }

    expect(blocked, 'these are local reads and must not be gated').to.deep.equal([]);
  });

  it('every command in LOCAL_COMMANDS is absent from NETWORK_COMMANDS', () => {
    const both = [...LOCAL_COMMANDS].filter((c) => NETWORK_COMMANDS.has(c));
    expect(both, 'a command cannot be both local and network').to.deep.equal([]);
  });

  it('a configured allowlist does not refuse provider APIs on the allowed host', async () => {
    // Failing closed is right for a git remote and wrong for a provider call,
    // which has no repo-relative remote to resolve. Passing repoPath: null with
    // no host made EVERY provider API refuse the moment any allowlist existed.
    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });

    invoked.length = 0;
    const result = await gitService.listPullRequests('owner', 'repo');

    expect(result.success, 'a github.com allowlist permits GitHub APIs').to.not.equal(false);
    expect(invoked.includes('list_pull_requests')).to.equal(true);
  });

  it('a configured allowlist still refuses a provider on a host not on the list', async () => {
    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });

    invoked.length = 0;
    const result = await gitService.listGitLabIssues('https://gitlab.com', 'g/p');

    expect(result.success, 'gitlab.com is not on the list').to.equal(false);
    expect(invoked.includes('list_gitlab_issues')).to.equal(false);
  });

  /**
   * A refusal the user cannot read is barely better than a silent one: each of
   * these is rendered by its caller (`aiError` in the settings dialog, a thrown
   * message in the GitHub App flow), so the text has to name the setting and
   * where to change it.
   */
  it('a refused download or GitHub App call explains itself', async () => {
    settingsStore.setState({ offlineMode: true, confirmNetworkOps: false, remoteAllowlist: [] });

    const model = await localAiService.downloadModel('gemma-3-1b-q4km');
    expect(model.success).to.equal(false);
    expect(model.error?.code, 'the code every other refusal uses').to.equal('BLOCKED');
    expect(model.error?.message).to.contain('Offline mode');
    expect(model.error?.message).to.contain('Settings > Security');

    let embeddingError: string | null = null;
    try {
      await embeddingIndexService.downloadModel();
    } catch (err) {
      embeddingError = (err as Error).message;
    }
    expect(embeddingError, 'the embedding model download must refuse too').to.contain(
      'Offline mode',
    );

    let appError: string | null = null;
    try {
      await credentialService.configureGitHubApp(1, 'pem', 2);
    } catch (err) {
      appError = (err as Error).message;
    }
    expect(appError).to.contain('api.github.com');
    expect(appError).to.contain('offline mode');

    let listError: string | null = null;
    try {
      await credentialService.listGitHubAppInstallations(1, 'pem');
    } catch (err) {
      listError = (err as Error).message;
    }
    expect(listError).to.contain('api.github.com');

    // The Settings "Check for Updates" button renders this message inline, so
    // pressing it offline says why instead of silently doing nothing — which
    // is what it did while the updater had no gate at all.
    const update = await updateService.checkForUpdate();
    expect(update.success).to.equal(false);
    expect(update.error?.code, 'the code every other refusal uses').to.equal('BLOCKED');
    expect(update.error?.message).to.contain('offline mode');
    expect(update.error?.message).to.contain('Settings > Security');

    const install = await updateService.downloadAndInstallUpdate();
    expect(install.success, 'installing a binary is the same request').to.equal(false);
    expect(install.error?.code).to.equal('BLOCKED');
  });

  it('an allowlist refusal names the host that is missing from it', async () => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: ['github.com'] });

    const model = await localAiService.downloadModel('gemma-3-1b-q4km');
    expect(model.success).to.equal(false);
    expect(model.error?.message).to.contain('huggingface.co');
    expect(model.error?.message).to.contain('allowlist');

    // The same allowlist names api.github.com's domain, so the GitHub App
    // calls are permitted — an allowlist that refused everything would just be
    // offline mode with extra steps.
    invoked.length = 0;
    try {
      await credentialService.listGitHubAppInstallations(1, 'pem');
    } catch {
      /* the mocked command returns null, which the caller rejects — fine */
    }
    expect(invoked.includes('list_github_app_installations')).to.equal(true);

    // github.com IS on this list, so the updater is allowed through — an
    // allowlist that refused either way would just be offline mode by another
    // name.
    invoked.length = 0;
    const allowedUpdate = await updateService.checkForUpdate();
    expect(allowedUpdate.success, 'a github.com allowlist permits the updater').to.not.equal(false);
    expect(invoked.includes('check_for_update')).to.equal(true);

    // A list that does not name it refuses, and says which host is missing.
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: ['gitlab.com'] });
    invoked.length = 0;
    const refusedUpdate = await updateService.checkForUpdate();
    expect(refusedUpdate.success).to.equal(false);
    expect(refusedUpdate.error?.message).to.contain('github.com');
    expect(refusedUpdate.error?.message).to.contain('allowlist');
    expect(invoked.includes('check_for_update')).to.equal(false);
  });

  it('the same sweep does reach those commands when offline mode is off', async () => {
    // Guards the test itself: if the sweep stopped exercising anything (an
    // argument shape drifting, say), the assertion above would pass vacuously.
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });

    const reached = new Set<string>();
    for (const { fn } of sweptCallables()) {
      invoked.length = 0;
      try {
        await fn(...ARGS);
      } catch {
        /* ignore */
      }
      for (const c of invoked) if (NETWORK_COMMANDS.has(c)) reached.add(c);
    }

    expect(reached.size, 'the sweep actually exercises network commands').to.be.greaterThan(10);
    // The four that shipped ungated. Without these the sweep could stop
    // exercising them (an argument shape drifting, an export renamed) and the
    // offline assertion above would pass without proving anything.
    for (const command of [
      'download_model',
      'download_embedding_model',
      'configure_github_app',
      'list_github_app_installations',
      'check_for_update',
      'download_and_install_update',
      // The shallow-clone fetches and the SSH credential test, ungated on the
      // frontend until they were classified above.
      'deepen_repository',
      'unshallow_repository',
      'test_credentials',
    ]) {
      expect(reached.has(command), `the sweep reaches ${command} when nothing blocks it`).to.equal(
        true,
      );
    }
  });
});
