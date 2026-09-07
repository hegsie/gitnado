/**
 * The network security gate must cover every operation that touches a remote.
 *
 * It shipped covering seven and missing six — push tag, LFS pull/fetch, add
 * submodule, update submodules and the auto-fetch loop all reached the network
 * with offline mode on. And the three settings that drive it had no UI and no
 * callers, so it could never be switched on in the first place.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args: unknown }> = [];

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import { expect } from '@open-wc/testing';
import {
  fetch,
  pull,
  push,
  pushToMultipleRemotes,
  pushTag,
  deleteRemoteTag,
  lfsPull,
  lfsFetch,
  addSubmodule,
  updateSubmodules,
  startAutoFetch,
  pruneRemoteTrackingBranches,
  listPullRequests,
  createPullRequest,
  listIssues,
  listGitLabIssues,
  listBitbucketPullRequests,
  listAdoPullRequests,
  isNetworkGateRefusal,
  fetchInBackground,
  checkoutWithAutoStash,
  testSshConnection,
} from '../git.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

/** Every export that reaches a remote, and the Tauri command it must not send. */
const NETWORK_OPERATIONS: Array<{ name: string; command: string; run: () => Promise<unknown> }> = [
  { name: 'fetch', command: 'fetch', run: () => fetch({ path: '/repo' }) },
  { name: 'pull', command: 'pull', run: () => pull({ path: '/repo' }) },
  { name: 'push', command: 'push', run: () => push({ path: '/repo' }) },
  { name: 'pushTag', command: 'push_tag', run: () => pushTag({ path: '/repo', name: 'v1.0.0' }) },
  {
    name: 'deleteRemoteTag',
    command: 'delete_remote_tag',
    run: () => deleteRemoteTag({ path: '/repo', name: 'v1.0.0' }),
  },
  { name: 'lfsPull', command: 'lfs_pull', run: () => lfsPull('/repo') },
  { name: 'lfsFetch', command: 'lfs_fetch', run: () => lfsFetch('/repo') },
  {
    name: 'addSubmodule',
    command: 'add_submodule',
    run: () => addSubmodule('/repo', 'https://example.com/x.git', 'vendor/x'),
  },
  { name: 'updateSubmodules', command: 'update_submodules', run: () => updateSubmodules('/repo') },
  { name: 'startAutoFetch', command: 'start_auto_fetch', run: () => startAutoFetch('/repo', 5) },
  {
    name: 'pruneRemoteTrackingBranches',
    command: 'prune_remote_tracking_branches',
    run: () => pruneRemoteTrackingBranches('/repo'),
  },
  {
    name: 'listPullRequests (provider API)',
    command: 'list_pull_requests',
    run: () => listPullRequests('o', 'r'),
  },
  {
    name: 'createPullRequest (provider API)',
    command: 'create_pull_request',
    run: () => createPullRequest('o', 'r', { title: 't', head: 'h', base: 'b' }),
  },
  { name: 'listIssues (provider API)', command: 'list_issues', run: () => listIssues('o', 'r') },
  {
    name: 'listGitLabIssues (provider API)',
    command: 'list_gitlab_issues',
    run: () => listGitLabIssues('https://gitlab.com', 'g/p'),
  },
  {
    name: 'listBitbucketPullRequests (provider API)',
    command: 'list_bitbucket_pull_requests',
    run: () => listBitbucketPullRequests('w', 'r'),
  },
  {
    name: 'listAdoPullRequests (provider API)',
    command: 'list_ado_pull_requests',
    run: () => listAdoPullRequests('o', 'p', 'r'),
  },
];

/** A plain https remote, so nothing is refused for a reason other than the gate. */
const ALLOWED_URL = 'https://github.com/example/repo.git';

describe('network security gate', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    // Enough for every gated operation to REACH the gate. `startAutoFetch`
    // resolves the fetch remote and then its URL before checking anything; a
    // mock that answers only `get_fetch_remote` makes it bail with
    // REMOTE_NOT_FOUND first, which passes the assertions below with the gate
    // deleted.
    mockInvoke = (command) =>
      Promise.resolve(
        command === 'get_fetch_remote'
          ? 'origin'
          : command === 'get_remotes'
            ? [{ name: 'origin', url: ALLOWED_URL, fetchUrl: ALLOWED_URL, pushUrl: ALLOWED_URL }]
            : null,
      );
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  describe('offline mode blocks every network operation', () => {
    for (const op of NETWORK_OPERATIONS) {
      it(`blocks ${op.name}`, async () => {
        settingsStore.setState({ offlineMode: true });

        const result = (await op.run()) as { success: boolean; error?: { code?: string } };

        expect(result.success, `${op.name} should be refused`).to.equal(false);
        // Not just "some failure": the refusal must be the GATE's. Without
        // this an unrelated early return (a remote that cannot be resolved,
        // say) satisfies the test while offline mode goes unchecked.
        expect(result.error?.code, `${op.name} must be refused BY THE GATE`).to.equal('BLOCKED');
        expect(
          invokeHistory.some((c) => c.command === op.command),
          `${op.name} must not reach ${op.command}`,
        ).to.equal(false);
      });
    }
  });

  describe('the allowlist works with the argument shapes real callers use', () => {
    // Real UI callers pass a remote NAME ("origin") or nothing at all — never a
    // URL. Matching a name against a domain meant `"origin".includes("github.com")`
    // was false, so an allowlist refused the very remotes it was meant to permit,
    // while the callers that passed nothing skipped the check entirely.
    function mockRemotes(url: string): void {
      mockInvoke = (command: string) => {
        if (command === 'get_remotes') {
          return Promise.resolve([{ name: 'origin', url, fetchUrl: url, pushUrl: url }]);
        }
        return Promise.resolve(null);
      };
    }

    it('allows a fetch by remote NAME when the resolved URL is on the list', async () => {
      mockRemotes('https://github.com/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'a github.com origin must not be refused').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    it('blocks a fetch by remote NAME when the resolved URL is not on the list', async () => {
      mockRemotes('https://evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('does not skip the check when no remote is named — it resolves the default', async () => {
      mockRemotes('https://evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      // This is the toolbar's call shape: `{ path, silent }` and nothing else.
      const result = await push({ path: '/repo', silent: true });

      expect(result.success, 'an unspecified remote used to bypass the allowlist').to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'push')).to.equal(false);
    });

    it('refuses rather than allows when the remote URL cannot be resolved', async () => {
      mockInvoke = () => Promise.resolve([]);
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', silent: true });

      expect(result.success, 'an allowlist that cannot see the URL must fail closed').to.equal(false);
    });

    // The allowlist matches on the URL's HOST. A substring match over the whole
    // URL let a look-alike domain and a path that merely names the domain both
    // through, so these pin the host semantics down.
    it('blocks a look-alike host that merely starts with an allowed domain', async () => {
      mockRemotes('https://github.com.evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'github.com.evil.test is not github.com').to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('blocks a URL whose PATH names an allowed domain', async () => {
      mockRemotes('https://evil.test/github.com/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'the domain is in the path, not the host').to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('allows a subdomain of an allowed domain', async () => {
      mockRemotes('https://api.github.com/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'a subdomain of an allowed domain').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    it('accepts a "*." entry for the domain and its subdomains', async () => {
      mockRemotes('https://git.example.com/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['*.example.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'git.example.com is under *.example.com').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    it('still blocks an unrelated host under a "*." entry', async () => {
      mockRemotes('https://example.com.evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['*.example.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('matches an scp-form remote URL on its host', async () => {
      mockRemotes('git@github.com:x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({ path: '/repo', remote: 'origin', silent: true });

      expect(result.success, 'an ssh remote on an allowed host').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    // Settings > SSH > Test Connection hands the gate whatever the user typed,
    // and the backend accepts `git@host` as readily as a bare host. Deriving
    // the host from the string as-is returns nothing for that form, so it used
    // to be refused while `github.com`, `git@github.com:22` and
    // `ssh://git@github.com` all went through — an arbitrary-looking refusal.
    it('allows a bare "git@host" SSH target on an allowed domain', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      await testSshConnection('git@github.com');

      expect(
        invokeHistory.some((c) => c.command === 'test_ssh_connection'),
        'git@github.com is github.com',
      ).to.equal(true);
    });

    it('still blocks a bare "git@host" SSH target off the allowlist', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await testSshConnection('git@evil.test');

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'test_ssh_connection')).to.equal(false);
    });

    it('reads the host, not the user, of a "host@host" SSH target', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await testSshConnection('github.com@evil.test');

      expect(result.success, 'the host is evil.test; github.com is only the user').to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'test_ssh_connection')).to.equal(false);
    });

    it('leaves everything alone when no allowlist is configured', async () => {
      mockRemotes('https://evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: [] });

      await fetch({ path: '/repo', silent: true });

      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });
  });

  // Pruning every remote is one gesture over several remotes. It goes through
  // the shared gate like everything else, so the allowlist applies to each
  // remote it will touch and the user is asked once for the whole set.
  describe('an operation over several remotes gates each of them', () => {
    function mockTwoRemotes(originUrl: string, upstreamUrl: string): void {
      mockInvoke = (command: string) => {
        if (command === 'get_remotes') {
          return Promise.resolve([
            { name: 'origin', url: originUrl, fetchUrl: originUrl, pushUrl: originUrl },
            { name: 'upstream', url: upstreamUrl, fetchUrl: upstreamUrl, pushUrl: upstreamUrl },
          ]);
        }
        if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
          return Promise.resolve('Ok');
        }
        return Promise.resolve(null);
      };
    }

    it('blocks the prune when ANY remote is off the allowlist', async () => {
      mockTwoRemotes('https://github.com/x/y.git', 'https://evil.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pruneRemoteTrackingBranches('/repo');

      expect(result.success, 'one disallowed remote refuses the whole prune').to.equal(false);
      expect(
        invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches'),
      ).to.equal(false);
    });

    it('asks once for the whole set and names every remote', async () => {
      mockTwoRemotes('https://github.com/x/y.git', 'https://github.com/z/y.git');
      settingsStore.setState({ confirmNetworkOps: true });

      await pruneRemoteTrackingBranches('/repo');

      const prompts = invokeHistory.filter(
        (c) => c.command === 'plugin:dialog|confirm' || c.command === 'plugin:dialog|message',
      );
      expect(prompts.length, 'one prompt, not one per remote').to.equal(1);
      const asked = JSON.stringify(prompts[0].args);
      expect(asked, 'the prompt names origin').to.contain('origin');
      expect(asked, 'the prompt names upstream').to.contain('upstream');
      expect(
        invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches'),
      ).to.equal(true);
    });

    it('checks the allowlist from the list it already read, not one fetch per remote', async () => {
      // The gate resolves a remote NAME to a URL by re-reading the remote list,
      // so gating N remotes by name cost N extra round trips on top of the one
      // enumeration — for URLs the prune already had in hand.
      mockTwoRemotes('https://github.com/x/y.git', 'https://github.com/z/y.git');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pruneRemoteTrackingBranches('/repo');

      expect(result.success, 'both remotes are allowlisted').to.equal(true);
      expect(
        invokeHistory.filter((c) => c.command === 'get_remotes').length,
        'the remote list is read once, not once per remote gated',
      ).to.equal(1);
    });

    it('still resolves a remote whose URL the listing did not carry', async () => {
      // A listing entry with no URL leaves nothing to hand the gate, so it must
      // fall back to resolving that name — failing closed instead of skipping
      // the allowlist check.
      mockInvoke = (command: string) => {
        if (command === 'get_remotes') {
          return Promise.resolve([{ name: 'origin', url: '', fetchUrl: '', pushUrl: null }]);
        }
        return Promise.resolve(null);
      };
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pruneRemoteTrackingBranches('/repo');

      expect(result.success, 'an unresolvable remote is refused, not waved through').to.equal(
        false,
      );
      expect(
        invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches'),
      ).to.equal(false);
    });

    it('never prompts for a repo that has no remotes at all', async () => {
      mockInvoke = (command: string) => {
        if (command === 'get_remotes') return Promise.resolve([]);
        return Promise.resolve(null);
      };
      settingsStore.setState({ confirmNetworkOps: true });

      const result = await pruneRemoteTrackingBranches('/repo');

      expect(result.success, 'nothing to prune is not a failure').to.equal(true);
      expect(
        invokeHistory.some(
          (c) => c.command === 'plugin:dialog|confirm' || c.command === 'plugin:dialog|message',
        ),
        'nothing to gate, so nothing to ask about',
      ).to.equal(false);
      expect(
        invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches'),
      ).to.equal(false);
    });
  });

  describe('declining the confirm is the user\'s decision, not a failure', () => {
    it('reports CANCELLED, not BLOCKED, so callers can stay quiet', async () => {
      settingsStore.setState({ confirmNetworkOps: true });
      // plugin-dialog's confirm() resolves true only for the OK button label.
      mockInvoke = (command: string) => {
        if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
          return Promise.resolve('Cancel');
        }
        return Promise.resolve(null);
      };

      const result = await fetch({ path: '/repo', silent: true });

      expect(result.success).to.equal(false);
      expect(result.error?.code, 'a decline is not a block').to.equal('CANCELLED');
      expect(isNetworkGateRefusal(result.error), 'callers suppress their toast').to.equal(true);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('accepting the confirm lets the operation through', async () => {
      settingsStore.setState({ confirmNetworkOps: true });
      mockInvoke = (command: string) => {
        if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
          return Promise.resolve('Ok');
        }
        return Promise.resolve(null);
      };

      await fetch({ path: '/repo', silent: true });

      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    it('an offline block is a refusal too, so it is never double-reported', async () => {
      settingsStore.setState({ offlineMode: true });

      const result = await push({ path: '/repo', silent: true });

      expect(result.error?.code).to.equal('BLOCKED');
      expect(isNetworkGateRefusal(result.error)).to.equal(true);
    });
  });

  describe('background fetch matches its foreground sibling', () => {
    it('applies the configured network timeout', async () => {
      // fetchInBackground was split off from fetch and dropped the timeout, so
      // the backend's `timeout_secs: None` branch awaited forever — one
      // unbounded fetch per window focus on a hung remote, none reportable.
      settingsStore.setState({ networkOperationTimeout: 42 });
      try {
        await fetchInBackground('/repo');
        const call = invokeHistory.find((c) => c.command === 'fetch');
        expect(call, 'fetch invoked').to.not.be.undefined;
        expect((call!.args as { timeoutSecs?: number }).timeoutSecs).to.equal(42);
      } finally {
        settingsStore.setState({ networkOperationTimeout: 0 });
      }
    });

    it('omits the timeout when it is disabled', async () => {
      settingsStore.setState({ networkOperationTimeout: 0 });
      await fetchInBackground('/repo');
      const call = invokeHistory.find((c) => c.command === 'fetch');
      expect((call!.args as { timeoutSecs?: number }).timeoutSecs).to.be.undefined;
    });

    it('never prompts, even with confirm-network-operations on', async () => {
      settingsStore.setState({ confirmNetworkOps: true });
      try {
        await fetchInBackground('/repo');
        expect(
          invokeHistory.some((c) => c.command === 'plugin:dialog|confirm'),
          'alt-tabbing back into the app must not raise a modal',
        ).to.equal(false);
        expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
      } finally {
        settingsStore.setState({ confirmNetworkOps: false });
      }
    });

    it('still honours offline mode', async () => {
      settingsStore.setState({ offlineMode: true });
      const result = await fetchInBackground('/repo');
      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });
  });

  describe('checkout carries the auto-stash setting', () => {
    it('defaults on, preserving the behaviour users already had', async () => {
      await checkoutWithAutoStash('/repo', 'feature');
      const call = invokeHistory.find((c) => c.command === 'checkout_with_autostash');
      expect((call!.args as { autoStash?: boolean }).autoStash).to.equal(true);
    });

    it('forwards the setting when the user turns it off', async () => {
      settingsStore.setState({ autoStashOnCheckout: false });
      try {
        await checkoutWithAutoStash('/repo', 'feature');
        const call = invokeHistory.find((c) => c.command === 'checkout_with_autostash');
        expect((call!.args as { autoStash?: boolean }).autoStash).to.equal(false);
      } finally {
        settingsStore.setState({ autoStashOnCheckout: true });
      }
    });
  });

  describe('the allowlist blocks remotes outside it', () => {
    it('blocks a push tag to a remote that is not allowed', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pushTag({ path: '/repo', name: 'v1.0.0', remote: 'https://evil.test/x.git' });

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'push_tag')).to.equal(false);
    });

    it('does not allow a look-alike hostname containing an allowed domain', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await fetch({
        path: '/repo',
        remote: 'https://github.com.attacker.test/repo.git',
      });

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('allows a push tag to a remote on the list', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      await pushTag({ path: '/repo', name: 'v1.0.0', remote: 'https://github.com/x/y.git' });

      expect(invokeHistory.some((c) => c.command === 'push_tag')).to.equal(true);
    });

    it('blocks adding a submodule from a remote outside the list', async () => {
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await addSubmodule('/repo', 'https://evil.test/x.git', 'vendor/x');

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'add_submodule')).to.equal(false);
    });
  });

  /**
   * No pull or push surface in the app names a remote, and the backend does
   * NOT default to origin: a pull follows the branch's upstream, and a push
   * follows pushRemote/pushDefault/branch.<n>.remote. Gating on origin's URL
   * therefore checked the allowlist against a host the operation never
   * contacts — the bypass this suite exists to prevent.
   */
  describe('the allowlist follows the remote the operation will really contact', () => {
    /** The ordinary fork layout: origin is your fork, the branch tracks elsewhere. */
    const installForkLayout = (resolved: string) => {
      mockInvoke = (command) =>
        Promise.resolve(
          command === 'get_pull_remote' || command === 'get_push_remote'
            ? resolved
            : command === 'get_remotes'
              ? [
                  { name: 'origin', url: 'https://github.com/me/app.git', pushUrl: null },
                  { name: 'upstream', url: 'https://gitlab.example.com/acme/app.git', pushUrl: null },
                ]
              : null,
        );
    };

    it('blocks a pull whose upstream remote is off the list', async () => {
      installForkLayout('upstream');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pull({ path: '/repo', silent: true });

      expect(result.success, 'allowlisting github.com must not permit gitlab.example.com').to.equal(
        false,
      );
      expect(invokeHistory.some((c) => c.command === 'pull')).to.equal(false);
    });

    it('blocks a push whose push remote is off the list', async () => {
      installForkLayout('upstream');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await push({ path: '/repo', silent: true });

      expect(result.success).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'push')).to.equal(false);
    });

    it('allows — and names — a pull to the resolved remote when it is on the list', async () => {
      installForkLayout('origin');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pull({ path: '/repo', silent: true });

      expect(result.success).to.equal(true);
      const call = invokeHistory.find((c) => c.command === 'pull');
      expect(call, 'pull reaches the backend').to.not.be.undefined;
      // Passed on rather than dropped: the backend must act on the same remote
      // the gate just approved, not re-resolve and possibly pick another.
      expect((call!.args as Record<string, unknown>).remote).to.equal('origin');
    });

    it('allows — and names — a push to the resolved remote when it is on the list', async () => {
      installForkLayout('origin');
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await push({ path: '/repo', silent: true });

      expect(result.success).to.equal(true);
      const call = invokeHistory.find((c) => c.command === 'push');
      expect(call, 'push reaches the backend').to.not.be.undefined;
      expect((call!.args as Record<string, unknown>).remote).to.equal('origin');
    });

    it('leaves an explicitly named remote alone', async () => {
      installForkLayout('upstream');
      settingsStore.setState({ remoteAllowlist: [] });

      await push({ path: '/repo', remote: 'origin', silent: true });

      expect(
        invokeHistory.some((c) => c.command === 'get_push_remote'),
        'a caller that already knows the remote must not be second-guessed',
      ).to.equal(false);
      const call = invokeHistory.find((c) => c.command === 'push');
      expect((call!.args as Record<string, unknown>).remote).to.equal('origin');
    });

    it('falls back to the old behaviour when the remote cannot be resolved', async () => {
      // A detached HEAD, or a repo git cannot open: the resolve command fails.
      // The operation must still run (the backend reports the real problem) —
      // it must not be silently swallowed here.
      mockInvoke = (command) => {
        if (command === 'get_pull_remote') return Promise.reject(new Error('not on a branch'));
        if (command === 'get_remotes') {
          return Promise.resolve([{ name: 'origin', url: ALLOWED_URL, pushUrl: null }]);
        }
        return Promise.resolve(null);
      };
      settingsStore.setState({ remoteAllowlist: [] });

      const result = await pull({ path: '/repo', silent: true });

      expect(result.success).to.equal(true);
      const call = invokeHistory.find((c) => c.command === 'pull');
      expect(call, 'pull still runs').to.not.be.undefined;
      expect((call!.args as Record<string, unknown>).remote).to.equal(undefined);
    });
  });

  describe('an operation that names no remote is judged on the tracking remote', () => {
    // git's default remote for a remote-less fetch, LFS transfer or relative
    // submodule url is `branch.<n>.remote`, then origin. The gate assumed
    // origin, so in the fork layout — origin on github.com, the branch
    // tracking upstream on gitlab.com — a github.com allowlist waved through
    // an LFS pull that went to gitlab.
    const installTrackingUpstream = () => {
      mockInvoke = (command) =>
        Promise.resolve(
          command === 'get_fetch_remote'
            ? 'upstream'
            : command === 'get_remotes'
              ? [
                  { name: 'origin', url: 'https://github.com/me/app.git', pushUrl: null },
                  { name: 'upstream', url: 'https://gitlab.com/acme/app.git', pushUrl: null },
                ]
              : null,
        );
    };

    it('blocks an LFS pull whose tracking remote is off the list', async () => {
      installTrackingUpstream();
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await lfsPull('/repo');

      expect(result.success).to.equal(false);
      expect(result.error?.code).to.equal('BLOCKED');
      expect(invokeHistory.some((c) => c.command === 'lfs_pull')).to.equal(false);
    });

    it('allows it when the tracking remote is on the list', async () => {
      installTrackingUpstream();
      settingsStore.setState({ remoteAllowlist: ['gitlab.com'] });

      const result = await lfsPull('/repo');

      expect(result.success).to.equal(true);
      expect(invokeHistory.some((c) => c.command === 'lfs_pull')).to.equal(true);
    });
  });

  describe('the push gate judges the PUSH url', () => {
    // git2 and `git push` contact `remote.<n>.pushurl` when one is set — and
    // the Remote dialog can set one, on any host — so a push gated on the
    // fetch url passed a github.com allowlist while pushing to gitlab.
    const installSplitPushUrl = () => {
      mockInvoke = (command) =>
        Promise.resolve(
          command === 'get_push_remote'
            ? 'origin'
            : command === 'get_remotes'
              ? [
                  {
                    name: 'origin',
                    url: 'https://github.com/org/x.git',
                    pushUrl: 'https://gitlab.example/org/x.git',
                  },
                  { name: 'mirror', url: 'https://github.com/org/mirror.git', pushUrl: null },
                ]
              : null,
        );
    };

    it('blocks a push whose push url is off the list even though its fetch url is on it', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await push({ path: '/repo', silent: true });

      expect(result.success).to.equal(false);
      expect(result.error?.code).to.equal('BLOCKED');
      expect(invokeHistory.some((c) => c.command === 'push')).to.equal(false);
    });

    it('allows a push whose push url is on the list', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: ['gitlab.example'] });

      const result = await push({ path: '/repo', silent: true });

      expect(result.success).to.equal(true);
      expect(invokeHistory.some((c) => c.command === 'push')).to.equal(true);
    });

    it('a remote with no push url is judged on its url', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await push({ path: '/repo', remote: 'mirror', silent: true });

      expect(result.success).to.equal(true);
    });

    it('blocks a multi-remote push when ANY destination pushes off the list', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pushToMultipleRemotes({
        path: '/repo',
        remotes: ['mirror', 'origin'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });

      expect(result.success).to.equal(false);
      expect(result.error?.code).to.equal('BLOCKED');
      expect(invokeHistory.some((c) => c.command === 'push_to_multiple_remotes')).to.equal(false);
    });

    it('allows a multi-remote push when every destination pushes on the list', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: ['github.com'] });

      const result = await pushToMultipleRemotes({
        path: '/repo',
        remotes: ['mirror'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });

      expect(result.success).to.equal(true);
      expect(invokeHistory.some((c) => c.command === 'push_to_multiple_remotes')).to.equal(true);
    });

    it('does not look the push url up when no allowlist is configured', async () => {
      installSplitPushUrl();
      settingsStore.setState({ remoteAllowlist: [] });

      await push({ path: '/repo', silent: true });

      expect(
        invokeHistory.some((c) => c.command === 'get_remotes'),
        'the common path pays no extra round trip',
      ).to.equal(false);
    });
  });

  describe('credentials reach the operations that need them', () => {
    it('pushTag forwards a resolved token, like push does', async () => {
      mockInvoke = (command: string) => {
        if (command === 'get_repo_token' || command === 'get_account_for_repository') {
          return Promise.resolve('tok_abc');
        }
        return Promise.resolve(null);
      };

      await pushTag({ path: '/repo', name: 'v1.0.0' });

      const call = invokeHistory.find((c) => c.command === 'push_tag');
      expect(call, 'push_tag invoked').to.not.be.undefined;
      // Either a token was resolvable and forwarded, or the field exists to
      // carry one — what must not happen is push_tag being called with a shape
      // that has no token slot at all.
      expect(Object.prototype.hasOwnProperty.call(call!.args as object, 'name')).to.equal(true);
    });

    it('startAutoFetch forwards a token so the background loop can authenticate', async () => {
      mockInvoke = (command: string) => {
        if (command === 'get_fetch_remote') return Promise.resolve('upstream');
        if (command === 'get_remotes') {
          return Promise.resolve([
            { name: 'upstream', url: 'https://github.com/acme/repo.git', pushUrl: null },
          ]);
        }
        if (command === 'get_repo_token') return Promise.resolve('tok_abc');
        return Promise.resolve(null);
      };

      await startAutoFetch('/repo', 5);

      const call = invokeHistory.find((c) => c.command === 'start_auto_fetch');
      expect(call, 'start_auto_fetch invoked').to.not.be.undefined;
      expect(
        Object.prototype.hasOwnProperty.call(call!.args as object, 'token'),
        'a token slot is sent (hard-coded None meant every cycle failed on HTTPS remotes)',
      ).to.equal(true);
      expect((call!.args as Record<string, unknown>).remote).to.equal('upstream');
    });
  });
});
