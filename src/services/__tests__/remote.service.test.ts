import { expect } from '@open-wc/testing';

// Mock Tauri API
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
let lastInvokedCommand: string | null = null;
let lastInvokedArgs: unknown = null;
const invokeHistory: Array<{ command: string; args: unknown }> = [];

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    lastInvokedCommand = command;
    lastInvokedArgs = args;
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import {
  getRemotes,
  addRemote,
  removeRemote,
  renameRemote,
  setRemoteUrl,
  fetch,
  fetchInBackground,
  pull,
  push,
  pushToMultipleRemotes,
  startAutoFetch,
  stopAutoFetch,
  isAutoFetchRunning,
  getRemoteStatus,
  pruneRemoteTrackingBranches,
  type RemoteStatus,
} from '../git.service.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { createEmptyIntegrationAccount } from '../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import type { Remote } from '../../types/git.types.ts';
import type { MultiPushResult } from '../../types/api.types.ts';

describe('git.service - Remote operations', () => {
  beforeEach(() => {
    lastInvokedCommand = null;
    lastInvokedArgs = null;
    invokeHistory.length = 0;
  });

  describe('getRemotes', () => {
    it('invokes get_remotes command', async () => {
      const mockRemotes: Remote[] = [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
      ];
      mockInvoke = () => Promise.resolve(mockRemotes);

      const result = await getRemotes('/test/repo');
      expect(lastInvokedCommand).to.equal('get_remotes');
      expect((lastInvokedArgs as Record<string, unknown>).path).to.equal('/test/repo');
      expect(result.success).to.be.true;
    });

    it('returns list of remotes', async () => {
      const mockRemotes: Remote[] = [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/original/repo.git', pushUrl: null },
      ];
      mockInvoke = () => Promise.resolve(mockRemotes);

      const result = await getRemotes('/test/repo');
      expect(result.data?.length).to.equal(2);
      expect(result.data?.[0].name).to.equal('origin');
      expect(result.data?.[1].name).to.equal('upstream');
    });

    it('returns empty array when no remotes', async () => {
      mockInvoke = () => Promise.resolve([]);

      const result = await getRemotes('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data).to.deep.equal([]);
    });

    it('handles error when repository not found', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REPO_NOT_FOUND', message: 'Repository not found' });

      const result = await getRemotes('/invalid/path');
      expect(result.success).to.be.false;
    });
  });

  describe('addRemote', () => {
    it('invokes add_remote command with correct arguments', async () => {
      const mockRemote: Remote = {
        name: 'upstream',
        url: 'https://github.com/original/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      const result = await addRemote(
        '/test/repo',
        'upstream',
        'https://github.com/original/repo.git'
      );
      expect(lastInvokedCommand).to.equal('add_remote');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.name).to.equal('upstream');
      expect(args.url).to.equal('https://github.com/original/repo.git');
      expect(result.success).to.be.true;
    });

    it('returns the created remote', async () => {
      const mockRemote: Remote = {
        name: 'fork',
        url: 'https://github.com/fork/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      const result = await addRemote('/test/repo', 'fork', 'https://github.com/fork/repo.git');
      expect(result.data?.name).to.equal('fork');
      expect(result.data?.url).to.equal('https://github.com/fork/repo.git');
    });

    it('handles duplicate remote name error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REMOTE_EXISTS', message: 'Remote already exists' });

      const result = await addRemote('/test/repo', 'origin', 'https://github.com/user/repo.git');
      expect(result.success).to.be.false;
    });
  });

  describe('removeRemote', () => {
    it('invokes remove_remote command with correct arguments', async () => {
      mockInvoke = () => Promise.resolve(null);

      await removeRemote('/test/repo', 'upstream');
      expect(lastInvokedCommand).to.equal('remove_remote');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.name).to.equal('upstream');
    });

    it('returns success on removal', async () => {
      mockInvoke = () => Promise.resolve(null);

      const result = await removeRemote('/test/repo', 'origin');
      expect(result.success).to.be.true;
    });

    it('handles non-existent remote error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REMOTE_NOT_FOUND', message: 'Remote not found' });

      const result = await removeRemote('/test/repo', 'nonexistent');
      expect(result.success).to.be.false;
    });
  });

  describe('renameRemote', () => {
    it('invokes rename_remote command with correct arguments', async () => {
      const mockRemote: Remote = {
        name: 'new-name',
        url: 'https://github.com/user/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      await renameRemote('/test/repo', 'old-name', 'new-name');
      expect(lastInvokedCommand).to.equal('rename_remote');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.oldName).to.equal('old-name');
      expect(args.newName).to.equal('new-name');
    });

    it('returns the renamed remote', async () => {
      const mockRemote: Remote = {
        name: 'upstream',
        url: 'https://github.com/original/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      const result = await renameRemote('/test/repo', 'origin', 'upstream');
      expect(result.success).to.be.true;
      expect(result.data?.name).to.equal('upstream');
    });

    it('handles non-existent remote error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REMOTE_NOT_FOUND', message: 'Remote not found' });

      const result = await renameRemote('/test/repo', 'nonexistent', 'newname');
      expect(result.success).to.be.false;
    });
  });

  describe('setRemoteUrl', () => {
    it('invokes set_remote_url command with correct arguments', async () => {
      const mockRemote: Remote = {
        name: 'origin',
        url: 'https://github.com/newuser/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      await setRemoteUrl('/test/repo', 'origin', 'https://github.com/newuser/repo.git');
      expect(lastInvokedCommand).to.equal('set_remote_url');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.name).to.equal('origin');
      expect(args.url).to.equal('https://github.com/newuser/repo.git');
    });

    it('supports setting push URL separately', async () => {
      const mockRemote: Remote = {
        name: 'origin',
        url: 'https://github.com/user/repo.git',
        pushUrl: 'git@github.com:user/repo.git',
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      await setRemoteUrl('/test/repo', 'origin', 'git@github.com:user/repo.git', true);
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.push).to.be.true;
    });

    it('returns updated remote', async () => {
      const mockRemote: Remote = {
        name: 'origin',
        url: 'https://github.com/newuser/repo.git',
        pushUrl: null,
      };
      mockInvoke = () => Promise.resolve(mockRemote);

      const result = await setRemoteUrl(
        '/test/repo',
        'origin',
        'https://github.com/newuser/repo.git'
      );
      expect(result.success).to.be.true;
      expect(result.data?.url).to.equal('https://github.com/newuser/repo.git');
    });

    it('handles non-existent remote error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REMOTE_NOT_FOUND', message: 'Remote not found' });

      const result = await setRemoteUrl('/test/repo', 'nonexistent', 'https://example.com');
      expect(result.success).to.be.false;
    });
  });

  describe('fetch', () => {
    it('invokes fetch command with path', async () => {
      mockInvoke = () => Promise.resolve(null);

      await fetch({ path: '/test/repo', silent: true });
      expect(lastInvokedCommand).to.equal('fetch');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('supports fetching specific remote', async () => {
      mockInvoke = () => Promise.resolve(null);

      await fetch({ path: '/test/repo', remote: 'upstream', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.remote).to.equal('upstream');
    });

    it('resolves an omitted remote before fetching', async () => {
      mockInvoke = (command) =>
        Promise.resolve(command === 'get_fetch_remote' ? 'upstream' : null);

      await fetch({ path: '/test/repo', silent: true });

      expect(lastInvokedCommand).to.equal('fetch');
      expect((lastInvokedArgs as Record<string, unknown>).remote).to.equal('upstream');
    });

    // The window-focus refresh runs this same backend command, and the
    // backend's success event is toasted by setupRemoteOperationListeners. So
    // with fetch-on-focus enabled, "Fetched from origin" appeared every single
    // time the user alt-tabbed back into the app — exactly the noise the
    // background fetch is documented to avoid.
    it('marks a background fetch quiet so it does not toast', async () => {
      mockInvoke = (command) =>
        Promise.resolve(command === 'get_fetch_remote' ? 'upstream' : null);

      await fetchInBackground('/test/repo');
      expect(lastInvokedCommand).to.equal('fetch');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.quiet, 'the background fetch must suppress the success event').to.be.true;
      expect(args.remote).to.equal('upstream');
    });

    it('leaves a user-initiated fetch loud', async () => {
      mockInvoke = () => Promise.resolve(null);

      await fetch({ path: '/test/repo', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.quiet, 'a fetch the user asked for still reports itself').to.not.be.true;
    });

    it('supports prune option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await fetch({ path: '/test/repo', prune: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.prune).to.be.true;
    });

    it('supports authentication token', async () => {
      mockInvoke = () => Promise.resolve(null);

      await fetch({ path: '/test/repo', token: 'ghp_test_token', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.token).to.equal('ghp_test_token');
    });

    it('returns success on successful fetch', async () => {
      mockInvoke = () => Promise.resolve(null);

      const result = await fetch({ path: '/test/repo', silent: true });
      expect(result.success).to.be.true;
    });

    it('handles network error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'NETWORK_ERROR', message: 'Could not connect to remote' });

      const result = await fetch({ path: '/test/repo', silent: true });
      expect(result.success).to.be.false;
    });
  });

  describe('pull', () => {
    it('invokes pull command with path', async () => {
      mockInvoke = () => Promise.resolve(null);

      await pull({ path: '/test/repo', silent: true });
      expect(lastInvokedCommand).to.equal('pull');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('supports specific remote and branch', async () => {
      mockInvoke = () => Promise.resolve(null);

      await pull({ path: '/test/repo', remote: 'origin', branch: 'main', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.remote).to.equal('origin');
      expect(args.branch).to.equal('main');
    });

    it('supports rebase option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await pull({ path: '/test/repo', rebase: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.rebase).to.be.true;
    });

    it('supports authentication token', async () => {
      mockInvoke = () => Promise.resolve(null);

      await pull({ path: '/test/repo', token: 'ghp_test_token', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.token).to.equal('ghp_test_token');
    });

    it('returns success on successful pull', async () => {
      mockInvoke = () => Promise.resolve(null);

      const result = await pull({ path: '/test/repo', silent: true });
      expect(result.success).to.be.true;
    });

    it('handles merge conflict error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'MERGE_CONFLICT', message: 'Merge conflict occurred' });

      const result = await pull({ path: '/test/repo', silent: true });
      expect(result.success).to.be.false;
    });
  });

  describe('push', () => {
    it('invokes push command with path', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', silent: true });
      expect(lastInvokedCommand).to.equal('push');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('supports specific remote and branch', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', remote: 'origin', branch: 'feature', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.remote).to.equal('origin');
      expect(args.branch).to.equal('feature');
    });

    it('supports force push option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', force: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.force).to.be.true;
    });

    it('supports force with lease option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', forceWithLease: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.forceWithLease).to.be.true;
    });

    it('supports push tags option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', pushTags: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.pushTags).to.be.true;
    });

    it('supports set upstream option', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', setUpstream: true, silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.setUpstream).to.be.true;
    });

    it('supports authentication token', async () => {
      mockInvoke = () => Promise.resolve(null);

      await push({ path: '/test/repo', token: 'ghp_test_token', silent: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.token).to.equal('ghp_test_token');
    });

    it('returns success on successful push', async () => {
      mockInvoke = () => Promise.resolve(null);

      const result = await push({ path: '/test/repo', silent: true });
      expect(result.success).to.be.true;
    });

    it('handles rejected push error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'PUSH_REJECTED', message: 'Push rejected, non-fast-forward' });

      const result = await push({ path: '/test/repo', silent: true });
      expect(result.success).to.be.false;
    });
  });

  describe('pushToMultipleRemotes', () => {
    it('invokes push_to_multiple_remotes command with correct arguments', async () => {
      const mockResult: MultiPushResult = {
        results: [
          { remote: 'origin', success: true, message: 'Pushed to origin/main' },
          { remote: 'upstream', success: true, message: 'Pushed to upstream/main' },
        ],
        totalSuccess: 2,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin', 'upstream'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      expect(lastInvokedCommand).to.equal('push_to_multiple_remotes');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.remotes).to.deep.equal(['origin', 'upstream']);
      expect(args.force).to.be.false;
    });

    it('supports optional branch parameter', async () => {
      const mockResult: MultiPushResult = {
        results: [{ remote: 'origin', success: true, message: 'Pushed to origin/feature' }],
        totalSuccess: 1,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin'],
        branch: 'feature',
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.branch).to.equal('feature');
    });

    it('supports force push option', async () => {
      const mockResult: MultiPushResult = {
        results: [{ remote: 'origin', success: true, message: 'Force-pushed to origin/main' }],
        totalSuccess: 1,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin'],
        force: true,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.force).to.be.true;
    });

    it('supports force with lease option', async () => {
      const mockResult: MultiPushResult = {
        results: [{ remote: 'origin', success: true }],
        totalSuccess: 1,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin'],
        force: false,
        forceWithLease: true,
        pushTags: false,
        silent: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.forceWithLease).to.be.true;
    });

    it('supports push tags option', async () => {
      const mockResult: MultiPushResult = {
        results: [{ remote: 'origin', success: true }],
        totalSuccess: 1,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin'],
        force: false,
        forceWithLease: false,
        pushTags: true,
        silent: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.pushTags).to.be.true;
    });

    it('returns success with all remotes pushed', async () => {
      const mockResult: MultiPushResult = {
        results: [
          { remote: 'origin', success: true, message: 'Pushed to origin/main' },
          { remote: 'upstream', success: true, message: 'Pushed to upstream/main' },
        ],
        totalSuccess: 2,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      const result = await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin', 'upstream'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      expect(result.success).to.be.true;
      expect(result.data?.totalSuccess).to.equal(2);
      expect(result.data?.totalFailed).to.equal(0);
      expect(result.data?.results).to.have.length(2);
    });

    it('returns partial failure when some remotes fail', async () => {
      const mockResult: MultiPushResult = {
        results: [
          { remote: 'origin', success: true, message: 'Pushed to origin/main' },
          { remote: 'upstream', success: false, message: 'Authentication failed' },
        ],
        totalSuccess: 1,
        totalFailed: 1,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      const result = await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin', 'upstream'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      expect(result.success).to.be.true;
      expect(result.data?.totalSuccess).to.equal(1);
      expect(result.data?.totalFailed).to.equal(1);
      expect(result.data?.results[0].success).to.be.true;
      expect(result.data?.results[1].success).to.be.false;
    });

    it('handles error when command fails entirely', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REMOTE_NOT_FOUND', message: 'Remote not found' });

      const result = await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['nonexistent'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        silent: true,
      });
      expect(result.success).to.be.false;
    });

    it('supports authentication token', async () => {
      const mockResult: MultiPushResult = {
        results: [{ remote: 'origin', success: true }],
        totalSuccess: 1,
        totalFailed: 0,
      };
      mockInvoke = () => Promise.resolve(mockResult);

      await pushToMultipleRemotes({
        path: '/test/repo',
        remotes: ['origin'],
        force: false,
        forceWithLease: false,
        pushTags: false,
        token: 'ghp_test_token',
        silent: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.token).to.equal('ghp_test_token');
    });
  });

  describe('pruneRemoteTrackingBranches', () => {
    const keyring = new Map<string, string>();
    let preferredAccount: IntegrationAccount | null = null;

    /** Keyring-backed invoke mock: only the seeded keys answer. */
    function mockRepo(remotes: Array<{ name: string; url: string }>): void {
      mockInvoke = async (command, args) => {
        const a = args as Record<string, unknown> | undefined;
        if (command === 'get_remotes') {
          return remotes.map((r) => ({ ...r, pushUrl: null }));
        }
        if (command === 'get_keyring_token') return keyring.get(a!.key as string) ?? null;
        if (command === 'store_keyring_token') {
          keyring.set(a!.key as string, a!.value as string);
          return null;
        }
        if (command === 'oauth_refresh_token') {
          return { accessToken: 'gl-refreshed', refreshToken: 'r2', expiresIn: 7200 };
        }
        if (command === 'get_repository_preferred_account') return preferredAccount;
        if (command === 'prune_remote_tracking_branches') {
          return { success: true, branchesPruned: [] };
        }
        return null;
      };
    }

    function account(
      integrationType: 'github' | 'gitlab' | 'azure-devops',
      id: string,
      /** GitLab instance URL, or Azure DevOps organization. */
      instanceOrOrg?: string,
    ): IntegrationAccount {
      return {
        ...createEmptyIntegrationAccount(integrationType, instanceOrOrg),
        id,
        name: id,
        isDefault: true,
      };
    }

    beforeEach(() => {
      keyring.clear();
      preferredAccount = null;
    });

    afterEach(() => {
      unifiedProfileStore.getState().reset();
    });

    it('forwards the app-managed token for the selected remote', async () => {
      keyring.set('github_token', 'ghp_test');
      mockRepo([{ name: 'origin', url: 'https://github.com/acme/repo.git' }]);

      await pruneRemoteTrackingBranches('/test/repo', 'origin');

      expect(lastInvokedCommand).to.equal('prune_remote_tracking_branches');
      expect((lastInvokedArgs as { tokens: Record<string, string> }).tokens.origin).to.equal(
        'ghp_test',
      );
    });

    it('prunes EVERY remote when none is named, reading the list once', async () => {
      keyring.set('github_token', 'ghp_test');
      mockRepo([
        { name: 'origin', url: 'https://github.com/acme/repo.git' },
        { name: 'upstream', url: 'https://github.com/upstream/repo.git' },
      ]);

      await pruneRemoteTrackingBranches('/test/repo');

      const args = lastInvokedArgs as { remotes: string[]; tokens: Record<string, string> };
      expect(args.remotes, 'a dropped remote leaves its stale refs behind').to.deep.equal([
        'origin',
        'upstream',
      ]);
      // Both remotes are on github.com, so both carry the token.
      expect(args.tokens).to.deep.equal({ origin: 'ghp_test', upstream: 'ghp_test' });
      // The listed remotes already carry their URLs, so re-resolving each one is
      // a round trip per remote for a value already in hand.
      expect(
        invokeHistory.filter((c) => c.command === 'get_remotes').length,
        'the remote list is read once, not once per remote',
      ).to.equal(1);
    });

    it("uses a self-hosted GitLab account's refreshed token", async () => {
      // The repo is pinned to this account, so there is no legacy fallback to
      // paper over the account branch: the token can only come from there. Its
      // OAuth bundle has already expired, so the stored access token is dead
      // and the prune must carry the refreshed one.
      const gitlab = account('gitlab', 'gl-1', 'https://git.acme.dev');
      unifiedProfileStore.getState().setAccounts([gitlab]);
      preferredAccount = gitlab;
      keyring.set('gitlab_token_gl-1', 'gl-stale');
      keyring.set(
        'gitlab_token_gl-1_oauth',
        JSON.stringify({
          accessToken: 'gl-stale',
          refreshToken: 'r1',
          expiresAt: Date.now() - 1000,
        }),
      );
      mockRepo([{ name: 'origin', url: 'https://git.acme.dev/group/proj.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      expect((lastInvokedArgs as { tokens: Record<string, string> }).tokens.origin).to.equal(
        'gl-refreshed',
      );
    });

    it('sends no token for a plaintext http remote, account or not', async () => {
      // A self-hosted GitLab account reached over http:// resolves through the
      // account tier, which used to hand the token straight over — and the
      // backend scopes a credential helper to `http://` just as happily as to
      // `https://`, so the OAuth token would go out as a Basic password in
      // clear. The tokenless fallback tier already refused this URL; both tiers
      // must agree.
      const gitlab = account('gitlab', 'gl-1', 'http://gitlab.internal');
      unifiedProfileStore.getState().setAccounts([gitlab]);
      preferredAccount = gitlab;
      keyring.set('gitlab_token_gl-1', 'gl-secret');
      mockRepo([{ name: 'origin', url: 'http://gitlab.internal/group/proj.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      const args = lastInvokedArgs as { remotes: string[]; tokens: Record<string, string> };
      expect(args.remotes, 'the prune itself still runs, just unauthenticated').to.deep.equal([
        'origin',
      ]);
      expect(args.tokens, 'a token must never ride a plaintext transport').to.deep.equal({});
    });

    it('still sends the token for an https remote on the same self-hosted host', async () => {
      // The guard is about the transport, not the host: the very same account
      // over https:// must keep authenticating, or the fix would break every
      // self-hosted prune it is meant to leave alone.
      const gitlab = account('gitlab', 'gl-1', 'https://gitlab.internal');
      unifiedProfileStore.getState().setAccounts([gitlab]);
      preferredAccount = gitlab;
      keyring.set('gitlab_token_gl-1', 'gl-secret');
      mockRepo([{ name: 'origin', url: 'https://gitlab.internal/group/proj.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      expect((lastInvokedArgs as { tokens: Record<string, string> }).tokens).to.deep.equal({
        origin: 'gl-secret',
      });
    });

    it("ignores a preferred GitLab account from a DIFFERENT instance", async () => {
      // Two GitLab accounts, neither pinned to this repo by a url pattern or a
      // profile default. The backend resolver's last tier is the GLOBAL default
      // — the gitlab.com account — and it reports that as a match, so trusting
      // it would ship a gitlab.com PAT to an unrelated self-hosted host (which
      // could replay it against gitlab.com) AND still fail to authenticate
      // there, which is the very failure this path exists to fix.
      const dotCom = { ...account('gitlab', 'gl-com', 'https://gitlab.com'), isDefault: true };
      const selfHosted = {
        ...account('gitlab', 'gl-self', 'https://git.acme.dev'),
        isDefault: false,
      };
      unifiedProfileStore.getState().setAccounts([dotCom, selfHosted]);
      preferredAccount = dotCom;
      keyring.set('gitlab_token_gl-com', 'gl-com-pat');
      keyring.set('gitlab_token_gl-self', 'gl-self-pat');
      mockRepo([{ name: 'origin', url: 'https://git.acme.dev/group/proj.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      const { tokens } = lastInvokedArgs as { tokens: Record<string, string> };
      expect(tokens.origin, "the host's own account must answer for it").to.equal('gl-self-pat');
      expect(
        Object.values(tokens),
        "another instance's credential must never reach this host",
      ).to.not.contain('gl-com-pat');
    });

    it("sends no token when no GitLab account serves the remote's host", async () => {
      // Same host mismatch, but the self-hosted account has nothing stored.
      // Falling through to the global default's token would be exactly the leak
      // above; an unauthenticated prune is the correct outcome.
      const dotCom = { ...account('gitlab', 'gl-com', 'https://gitlab.com'), isDefault: true };
      const selfHosted = {
        ...account('gitlab', 'gl-self', 'https://git.acme.dev'),
        isDefault: false,
      };
      unifiedProfileStore.getState().setAccounts([dotCom, selfHosted]);
      preferredAccount = dotCom;
      keyring.set('gitlab_token_gl-com', 'gl-com-pat');
      mockRepo([{ name: 'origin', url: 'https://git.acme.dev/group/proj.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      const args = lastInvokedArgs as { remotes: string[]; tokens: Record<string, string> };
      expect(args.remotes, 'the prune still runs, just unauthenticated').to.deep.equal(['origin']);
      expect(args.tokens, "the default account's token must not stand in").to.deep.equal({});
    });

    it('still prunes, unauthenticated, when the keyring cannot be read', async () => {
      // A keyring read failure now throws instead of reading as "no token".
      // The branch-cleanup dialog calls this while holding the repository's
      // ref-op lock and reads the outcome off the result, so a throw here left
      // that lock held for the life of the app. The lookup failure is logged
      // and the prune goes ahead without a token, as fetch and clone do.
      const gh = account('github', 'gh-1');
      unifiedProfileStore.getState().setAccounts([gh]);
      preferredAccount = gh;
      mockRepo([{ name: 'origin', url: 'https://github.com/acme/repo.git' }]);
      const readable = mockInvoke;
      mockInvoke = async (command, args) => {
        if (command === 'get_keyring_token') {
          throw { code: 'OPERATION_FAILED', message: 'Keychain read failed: locked' };
        }
        return readable(command, args);
      };

      await pruneRemoteTrackingBranches('/test/repo');

      expect(lastInvokedCommand).to.equal('prune_remote_tracking_branches');
      const args = lastInvokedArgs as { remotes: string[]; tokens: Record<string, string> };
      expect(args.remotes).to.deep.equal(['origin']);
      expect(args.tokens).to.deep.equal({});
    });

    it("ignores a preferred Azure DevOps account from a DIFFERENT organization", async () => {
      // Every ADO account is scoped to one organization, and a
      // `{org}.visualstudio.com` host is per organization — so the resolver's
      // global-default last tier can hand back `contoso` for a `fabrikam`
      // remote. Trusting it would scope contoso's PAT to fabrikam's host and
      // still fail to authenticate there.
      const contoso = { ...account('azure-devops', 'ado-contoso', 'contoso'), isDefault: true };
      const fabrikam = {
        ...account('azure-devops', 'ado-fabrikam', 'fabrikam'),
        isDefault: false,
      };
      unifiedProfileStore.getState().setAccounts([contoso, fabrikam]);
      preferredAccount = contoso;
      keyring.set('azure-devops_token_ado-contoso', 'contoso-pat');
      keyring.set('azure-devops_token_ado-fabrikam', 'fabrikam-pat');
      mockRepo([{ name: 'origin', url: 'https://fabrikam.visualstudio.com/proj/_git/repo' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      const { tokens } = lastInvokedArgs as { tokens: Record<string, string> };
      expect(tokens.origin, "the organization's own account must answer for it").to.equal(
        'fabrikam-pat',
      );
      expect(
        Object.values(tokens),
        "another organization's credential must never reach this host",
      ).to.not.contain('contoso-pat');
    });

    it('still sends the token when the preferred ADO account owns the organization', async () => {
      // The guard is about the organization, not about ADO: the matching
      // account must keep authenticating, or every ADO prune would go out
      // unauthenticated. `dev.azure.com` names the org in the path.
      const contoso = account('azure-devops', 'ado-contoso', 'Contoso');
      unifiedProfileStore.getState().setAccounts([contoso]);
      preferredAccount = contoso;
      keyring.set('azure-devops_token_ado-contoso', 'contoso-pat');
      mockRepo([{ name: 'origin', url: 'https://dev.azure.com/contoso/proj/_git/repo' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      expect((lastInvokedArgs as { tokens: Record<string, string> }).tokens).to.deep.equal({
        origin: 'contoso-pat',
      });
    });

    it("sends no token when no ADO account owns the remote's organization", async () => {
      // Same organization mismatch, but nothing else serves fabrikam. Falling
      // through to the default account's token would be exactly the leak above;
      // an unauthenticated prune is the correct outcome.
      const contoso = { ...account('azure-devops', 'ado-contoso', 'contoso'), isDefault: true };
      unifiedProfileStore.getState().setAccounts([contoso]);
      preferredAccount = contoso;
      keyring.set('azure-devops_token_ado-contoso', 'contoso-pat');
      mockRepo([{ name: 'origin', url: 'https://dev.azure.com/fabrikam/proj/_git/repo' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      const args = lastInvokedArgs as { remotes: string[]; tokens: Record<string, string> };
      expect(args.remotes, 'the prune still runs, just unauthenticated').to.deep.equal(['origin']);
      expect(args.tokens, "the default account's token must not stand in").to.deep.equal({});
    });

    it('propagates a failure to list the remotes', async () => {
      mockInvoke = async (command) => {
        if (command === 'get_remotes') throw { code: 'COMMAND_ERROR', message: 'no remotes' };
        return null;
      };

      const result = await pruneRemoteTrackingBranches('/test/repo');

      expect(result.success, 'a prune that never ran is not a success').to.be.false;
      expect(result.error?.message).to.contain('no remotes');
      expect(invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches')).to.be
        .false;
    });

    it('refuses when the remote list comes back unusable', async () => {
      // A non-array payload would enumerate to nothing, and pruning "no
      // remotes" would report success while leaving every stale ref in place.
      mockInvoke = async () => null;

      const result = await pruneRemoteTrackingBranches('/test/repo');

      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('REMOTE_LIST_FAILED');
      expect(invokeHistory.some((c) => c.command === 'prune_remote_tracking_branches')).to.be
        .false;
    });

    it('sends no token when the repo-specific account has none stored', async () => {
      // A repo pinned to an account means THAT account or nothing — falling
      // back to the global default would authenticate as the wrong identity.
      preferredAccount = account('github', 'gh-repo');
      keyring.set('github_token', 'ghp_default');
      mockRepo([{ name: 'origin', url: 'https://github.com/acme/repo.git' }]);

      await pruneRemoteTrackingBranches('/test/repo');

      expect(
        (lastInvokedArgs as { tokens: Record<string, string> }).tokens,
        "the default account's token must not stand in",
      ).to.deep.equal({});
    });
  });

  describe('startAutoFetch', () => {
    it('invokes start_auto_fetch command with correct arguments', async () => {
      mockInvoke = (command) => {
        if (command === 'get_fetch_remote') return Promise.resolve('upstream');
        if (command === 'get_remotes') {
          return Promise.resolve([
            { name: 'upstream', url: 'https://github.com/acme/repo.git', pushUrl: null },
          ]);
        }
        return Promise.resolve(null);
      };

      await startAutoFetch('/test/repo', 5);
      expect(lastInvokedCommand).to.equal('start_auto_fetch');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.intervalMinutes).to.equal(5);
      expect(args.remote).to.equal('upstream');
      expect(args.remoteUrl).to.equal('https://github.com/acme/repo.git');
    });

    it('returns success when auto-fetch is started', async () => {
      mockInvoke = (command) => {
        if (command === 'get_fetch_remote') return Promise.resolve('origin');
        if (command === 'get_remotes') {
          return Promise.resolve([
            { name: 'origin', url: 'https://github.com/acme/repo.git', pushUrl: null },
          ]);
        }
        return Promise.resolve(null);
      };

      const result = await startAutoFetch('/test/repo', 10);
      expect(result.success).to.be.true;
    });

    it('handles error when starting auto-fetch', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'OPERATION_FAILED', message: 'Failed to start auto-fetch' });

      const result = await startAutoFetch('/test/repo', 5);
      expect(result.success).to.be.false;
    });
  });

  describe('stopAutoFetch', () => {
    it('invokes stop_auto_fetch command with correct arguments', async () => {
      mockInvoke = () => Promise.resolve(null);

      await stopAutoFetch('/test/repo');
      expect(lastInvokedCommand).to.equal('stop_auto_fetch');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('returns success when auto-fetch is stopped', async () => {
      mockInvoke = () => Promise.resolve(null);

      const result = await stopAutoFetch('/test/repo');
      expect(result.success).to.be.true;
    });

    it('handles error when stopping auto-fetch', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'OPERATION_FAILED', message: 'Failed to stop auto-fetch' });

      const result = await stopAutoFetch('/test/repo');
      expect(result.success).to.be.false;
    });
  });

  describe('isAutoFetchRunning', () => {
    it('invokes is_auto_fetch_running command', async () => {
      mockInvoke = () => Promise.resolve(true);

      await isAutoFetchRunning('/test/repo');
      expect(lastInvokedCommand).to.equal('is_auto_fetch_running');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('returns true when auto-fetch is running', async () => {
      mockInvoke = () => Promise.resolve(true);

      const result = await isAutoFetchRunning('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data).to.be.true;
    });

    it('returns false when auto-fetch is not running', async () => {
      mockInvoke = () => Promise.resolve(false);

      const result = await isAutoFetchRunning('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data).to.be.false;
    });

    it('handles error checking auto-fetch status', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'OPERATION_FAILED', message: 'Failed to check status' });

      const result = await isAutoFetchRunning('/test/repo');
      expect(result.success).to.be.false;
    });
  });

  describe('getRemoteStatus', () => {
    it('invokes get_remote_status command', async () => {
      const mockStatus: RemoteStatus = {
        ahead: 2,
        behind: 1,
        hasUpstream: true,
        upstreamName: 'origin/main',
      };
      mockInvoke = () => Promise.resolve(mockStatus);

      await getRemoteStatus('/test/repo');
      expect(lastInvokedCommand).to.equal('get_remote_status');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
    });

    it('returns ahead/behind counts', async () => {
      const mockStatus: RemoteStatus = {
        ahead: 5,
        behind: 3,
        hasUpstream: true,
        upstreamName: 'origin/develop',
      };
      mockInvoke = () => Promise.resolve(mockStatus);

      const result = await getRemoteStatus('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data?.ahead).to.equal(5);
      expect(result.data?.behind).to.equal(3);
      expect(result.data?.hasUpstream).to.be.true;
      expect(result.data?.upstreamName).to.equal('origin/develop');
    });

    it('handles branch without upstream', async () => {
      const mockStatus: RemoteStatus = {
        ahead: 0,
        behind: 0,
        hasUpstream: false,
      };
      mockInvoke = () => Promise.resolve(mockStatus);

      const result = await getRemoteStatus('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data?.hasUpstream).to.be.false;
      expect(result.data?.upstreamName).to.be.undefined;
    });

    it('handles error getting remote status', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'OPERATION_FAILED', message: 'Failed to get status' });

      const result = await getRemoteStatus('/test/repo');
      expect(result.success).to.be.false;
    });
  });
});
