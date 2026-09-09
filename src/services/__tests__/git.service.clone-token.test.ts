import { expect } from '@open-wc/testing';
import { cloneRepository } from '../git.service.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { createEmptyIntegrationAccount } from '../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';

/**
 * Clone happens before a repository exists on disk, so the remote-based token
 * detection fetch/pull/push use cannot run. These cover the URL-host lookup
 * that stands in for it.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const keyring = new Map<string, string>();
const invokedCommands: string[] = [];
let cloneArgs: Record<string, unknown> | null = null;
let keyringFails = false;
/** Set to make `oauth_refresh_token` succeed with this access token. */
let refreshedAccessToken: string | null = null;
let refreshArgs: Record<string, unknown> | null = null;

const repositoryStub = {
  path: '/dest/repo',
  name: 'repo',
  currentBranch: 'main',
  isBare: false,
  headCommit: null,
};

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  const a = args as Record<string, unknown> | undefined;
  if (command === 'get_keyring_token') {
    if (keyringFails) throw new Error('keyring unavailable');
    return keyring.get(a!.key as string) ?? null;
  }
  if (command === 'store_keyring_token') {
    keyring.set(a!.key as string, a!.value as string);
    return null;
  }
  if (command === 'oauth_refresh_token') {
    refreshArgs = { ...(a ?? {}) };
    if (!refreshedAccessToken) throw new Error('refresh rejected');
    return { accessToken: refreshedAccessToken, refreshToken: 'r2', expiresIn: 7200 };
  }
  if (command === 'clone_repository') return repositoryStub;
  return null;
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokedCommands.push(command);
    if (command === 'clone_repository') {
      cloneArgs = { ...(args as Record<string, unknown>) };
    }
    return mockInvoke(command, args);
  },
};

function account(
  integrationType: 'github' | 'gitlab' | 'azure-devops',
  id: string,
  instanceOrOrg?: string,
  isDefault = true,
): IntegrationAccount {
  return {
    ...createEmptyIntegrationAccount(integrationType, instanceOrOrg),
    id,
    name: id,
    isDefault,
  };
}

/** Seed a per-account keyring token, plus the OAuth bundle ADO refreshes from. */
function seedAccountToken(
  integrationType: 'github' | 'gitlab' | 'azure-devops',
  accountId: string,
  token: string,
  withOAuthBundle = false,
) {
  const key = `${integrationType}_token_${accountId}`;
  keyring.set(key, token);
  if (withOAuthBundle) {
    // Expiry an hour out — well past the 5-minute refresh threshold, so
    // getFreshAccountToken returns the stored token without attempting a
    // refresh grant.
    keyring.set(
      `${key}_oauth`,
      JSON.stringify({ accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
    );
  }
}

async function cloneAndReadArgs(url: string, extra: Record<string, unknown> = {}) {
  const result = await cloneRepository({ url, path: '/dest/repo', ...extra });
  expect(result.success, 'clone resolved').to.be.true;
  return (cloneArgs ?? {}) as { token?: string };
}

describe('git.service - cloneRepository token lookup', () => {
  beforeEach(() => {
    keyring.clear();
    invokedCommands.length = 0;
    cloneArgs = null;
    keyringFails = false;
    refreshedAccessToken = null;
    refreshArgs = null;
  });

  afterEach(() => {
    unifiedProfileStore.getState().reset();
  });

  it("attaches the connected GitLab account's token when cloning from gitlab.com", async () => {
    unifiedProfileStore.getState().setAccounts([account('gitlab', 'gl-1', 'https://gitlab.com')]);
    seedAccountToken('gitlab', 'gl-1', 'gl-tok');

    const args = await cloneAndReadArgs('https://gitlab.com/group/proj.git');

    expect(args.token, "the connected GitLab account's token").to.equal('gl-tok');
  });

  it('uses the token of the GitLab account matching a self-hosted instance host', async () => {
    unifiedProfileStore.getState().setAccounts([
      account('gitlab', 'gl-dotcom', 'https://gitlab.com', true),
      account('gitlab', 'gl-self', 'https://git.acme.dev', false),
    ]);
    seedAccountToken('gitlab', 'gl-dotcom', 'dotcom-tok');
    seedAccountToken('gitlab', 'gl-self', 'selfhosted-tok');

    const args = await cloneAndReadArgs('https://git.acme.dev/group/proj.git');

    expect(args.token, "the self-hosted instance's own token, not the default account's")
      .to.equal('selfhosted-tok');
  });

  it('attaches the Azure DevOps token for a dev.azure.com clone', async () => {
    unifiedProfileStore.getState().setAccounts([account('azure-devops', 'ado-1', 'myorg')]);
    seedAccountToken('azure-devops', 'ado-1', 'ado-tok', true);

    const args = await cloneAndReadArgs('https://dev.azure.com/myorg/proj/_git/repo');

    expect(args.token, 'the connected Azure DevOps token').to.equal('ado-tok');
  });

  it('attaches the Azure DevOps token for an {org}.visualstudio.com clone', async () => {
    unifiedProfileStore.getState().setAccounts([account('azure-devops', 'ado-1', 'myorg')]);
    seedAccountToken('azure-devops', 'ado-1', 'ado-tok', true);

    const args = await cloneAndReadArgs('https://myorg.visualstudio.com/proj/_git/repo');

    expect(args.token, 'the connected Azure DevOps token').to.equal('ado-tok');
  });

  it('does not attach the GitHub token to a look-alike host', async () => {
    unifiedProfileStore.getState().setAccounts([account('github', 'gh-1')]);
    seedAccountToken('github', 'gh-1', 'gh-tok');

    const args = await cloneAndReadArgs('https://github.com.evil.example/a/b.git');

    expect(args.token, 'no token for a look-alike host').to.be.undefined;
  });

  it('still attaches the GitHub token for a github.com clone', async () => {
    unifiedProfileStore.getState().setAccounts([account('github', 'gh-1')]);
    seedAccountToken('github', 'gh-1', 'gh-tok');

    const args = await cloneAndReadArgs('https://github.com/o/r.git');

    expect(args.token, 'the connected GitHub token').to.equal('gh-tok');
  });

  it('attaches no token for a host with no connected account', async () => {
    unifiedProfileStore.getState().setAccounts([account('gitlab', 'gl-1', 'https://gitlab.com')]);
    seedAccountToken('gitlab', 'gl-1', 'gl-tok');

    const bitbucket = await cloneAndReadArgs('https://bitbucket.org/w/r.git');
    expect(bitbucket.token, 'no credential is resolved for Bitbucket').to.be.undefined;

    invokedCommands.length = 0;
    const other = await cloneAndReadArgs('https://example.com/x/y.git');
    expect(other.token, 'no token for an unknown host').to.be.undefined;
    expect(invokedCommands, 'no keyring read for an unknown host')
      .to.not.include('get_keyring_token');
  });

  it('does not attach a token to a plaintext clone URL', async () => {
    unifiedProfileStore.getState().setAccounts([
      account('gitlab', 'gl-1', 'https://gitlab.com'),
      account('github', 'gh-1'),
    ]);
    seedAccountToken('gitlab', 'gl-1', 'gl-tok');
    seedAccountToken('github', 'gh-1', 'gh-tok');

    const overHttp = await cloneAndReadArgs('http://gitlab.com/group/proj.git');
    expect(overHttp.token, 'a token must not ride plaintext http').to.be.undefined;

    invokedCommands.length = 0;
    const overGitProto = await cloneAndReadArgs('git://github.com/o/r.git');
    expect(overGitProto.token, 'a token must not ride the git:// protocol').to.be.undefined;
    expect(invokedCommands, 'no keyring read for a plaintext transport')
      .to.not.include('get_keyring_token');
  });

  it("uses the Azure DevOps account matching the URL's organization", async () => {
    unifiedProfileStore.getState().setAccounts([
      account('azure-devops', 'ado-default', 'otherorg', true),
      account('azure-devops', 'ado-target', 'myorg', false),
    ]);
    seedAccountToken('azure-devops', 'ado-default', 'other-tok', true);
    seedAccountToken('azure-devops', 'ado-target', 'target-tok', true);

    const https = await cloneAndReadArgs('https://dev.azure.com/myorg/proj/_git/repo');
    expect(https.token, "the org's own token, not the default account's").to.equal('target-tok');

    cloneArgs = null;
    const ssh = await cloneAndReadArgs('git@ssh.dev.azure.com:v3/myorg/proj/repo');
    expect(ssh.token, 'the v3-prefixed ssh path names the same org').to.equal('target-tok');
  });

  it('attaches no Azure DevOps token when no account owns the URL organization', async () => {
    unifiedProfileStore
      .getState()
      .setAccounts([account('azure-devops', 'ado-default', 'otherorg', true)]);
    seedAccountToken('azure-devops', 'ado-default', 'other-tok', true);

    const args = await cloneAndReadArgs('https://dev.azure.com/myorg/proj/_git/repo');

    expect(args.token, "another org's token must not be handed over").to.be.undefined;
  });

  it('refreshes an expiring GitLab OAuth token before cloning', async () => {
    unifiedProfileStore
      .getState()
      .setAccounts([account('gitlab', 'gl-1', 'https://git.acme.dev')]);
    keyring.set('gitlab_token_gl-1', 'stale-tok');
    keyring.set(
      'gitlab_token_gl-1_oauth',
      JSON.stringify({ accessToken: 'stale-tok', refreshToken: 'r', expiresAt: Date.now() - 1000 }),
    );
    refreshedAccessToken = 'fresh-tok';

    const args = await cloneAndReadArgs('https://git.acme.dev/group/proj.git');

    expect(args.token, 'the refreshed access token, not the expired one').to.equal('fresh-tok');
    expect(refreshArgs?.provider, 'refreshed against GitLab').to.equal('gitlab');
    expect(refreshArgs?.instanceUrl, "the account's own instance").to.equal('https://git.acme.dev');
  });

  it('falls back to the stored GitLab token when the refresh grant fails', async () => {
    unifiedProfileStore.getState().setAccounts([account('gitlab', 'gl-1', 'https://gitlab.com')]);
    keyring.set('gitlab_token_gl-1', 'stale-tok');
    keyring.set(
      'gitlab_token_gl-1_oauth',
      JSON.stringify({ accessToken: 'stale-tok', refreshToken: 'r', expiresAt: Date.now() - 1000 }),
    );
    refreshedAccessToken = null; // the grant is rejected

    const args = await cloneAndReadArgs('https://gitlab.com/group/proj.git');

    expect(args.token, 'still something to try rather than nothing').to.equal('stale-tok');
  });

  it('does not overwrite a token the caller supplied', async () => {
    unifiedProfileStore.getState().setAccounts([account('gitlab', 'gl-1', 'https://gitlab.com')]);
    seedAccountToken('gitlab', 'gl-1', 'gl-tok');

    const args = await cloneAndReadArgs('https://gitlab.com/group/proj.git', { token: 'explicit' });

    expect(args.token, "the caller's token wins").to.equal('explicit');
  });

  // The clone dialog offers Cancel before the command is sent, and the backend
  // resets its cancellation flag when a clone starts — so a cancel that landed
  // during the token lookup has to be honoured HERE, or the clone runs anyway.
  it('does not send the clone when the caller reports it cancelled', async () => {
    const result = await cloneRepository(
      { url: 'https://github.com/octocat/repo.git', path: '/dest/repo' },
      { isCancelled: () => true },
    );

    expect(result.success).to.be.false;
    expect(result.error?.code).to.equal('OPERATION_CANCELLED');
    expect(invokedCommands).to.not.include('clone_repository');
  });

  it('sends the clone when the caller reports it not cancelled', async () => {
    const result = await cloneRepository(
      { url: 'https://github.com/octocat/repo.git', path: '/dest/repo' },
      { isCancelled: () => false },
    );

    expect(result.success).to.be.true;
    expect(invokedCommands).to.include('clone_repository');
  });

  it('clones without a token when the credential lookup fails', async () => {
    unifiedProfileStore.getState().setAccounts([account('gitlab', 'gl-1', 'https://gitlab.com')]);
    seedAccountToken('gitlab', 'gl-1', 'gl-tok');
    keyringFails = true;

    const args = await cloneAndReadArgs('https://gitlab.com/group/proj.git');

    expect(invokedCommands, 'the clone still ran').to.include('clone_repository');
    expect(args.token, 'unauthenticated rather than blocked').to.be.undefined;
  });
});
