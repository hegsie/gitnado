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

type TokenProvider = 'github' | 'gitlab' | 'azure-devops' | 'bitbucket';

function account(
  integrationType: TokenProvider,
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
  integrationType: TokenProvider,
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

async function cloneAndReadArgs(
  url: string,
  extra: Record<string, unknown> = {},
  options?: Parameters<typeof cloneRepository>[1],
) {
  const result = await cloneRepository({ url, path: '/dest/repo', ...extra }, options);
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

  // ── The account the URL was picked from (clone dialog's account picker) ──

  it("uses the picked account's token ahead of the host's default account", async () => {
    // Two GitHub accounts: the host lookup lands on the default (work) one,
    // which is the wrong identity for a repository picked from the personal
    // account — a private clone under it fails as "not found".
    const work = account('github', 'gh-work');
    const personal = account('github', 'gh-personal', undefined, false);
    unifiedProfileStore.getState().setAccounts([work, personal]);
    seedAccountToken('github', 'gh-work', 'work-tok');
    seedAccountToken('github', 'gh-personal', 'personal-tok');

    const args = await cloneAndReadArgs('https://github.com/me/private.git', {}, {
      account: personal,
    });

    expect(args.token).to.equal('personal-tok');
  });

  it('falls back to the host lookup when the picked account has no stored token', async () => {
    const work = account('github', 'gh-work');
    const personal = account('github', 'gh-personal', undefined, false);
    unifiedProfileStore.getState().setAccounts([work, personal]);
    seedAccountToken('github', 'gh-work', 'work-tok');

    const args = await cloneAndReadArgs('https://github.com/me/private.git', {}, {
      account: personal,
    });

    expect(args.token, 'another account for the host can still work').to.equal('work-tok');
  });

  it("refreshes the picked account's expiring OAuth token", async () => {
    const gl = account('gitlab', 'gl-1', 'https://gitlab.com');
    unifiedProfileStore.getState().setAccounts([gl]);
    keyring.set('gitlab_token_gl-1', 'old-tok');
    keyring.set(
      'gitlab_token_gl-1_oauth',
      JSON.stringify({ accessToken: 'old-tok', refreshToken: 'r', expiresAt: Date.now() - 1 }),
    );
    refreshedAccessToken = 'fresh-tok';

    const args = await cloneAndReadArgs('https://gitlab.com/g/p.git', {}, { account: gl });

    expect(args.token).to.equal('fresh-tok');
  });

  it("uses the picked self-hosted GitLab account's token", async () => {
    const hosted = account('gitlab', 'gl-acme', 'https://git.acme.dev', false);
    unifiedProfileStore.getState().setAccounts([
      account('gitlab', 'gl-com', 'https://gitlab.com'),
      hosted,
    ]);
    seedAccountToken('gitlab', 'gl-com', 'com-tok');
    seedAccountToken('gitlab', 'gl-acme', 'acme-tok');

    const args = await cloneAndReadArgs('https://git.acme.dev/g/p.git', {}, { account: hosted });

    expect(args.token).to.equal('acme-tok');
  });

  it("uses the picked Azure DevOps account's token", async () => {
    const ado = account('azure-devops', 'ado-1', 'contoso');
    unifiedProfileStore.getState().setAccounts([ado]);
    seedAccountToken('azure-devops', 'ado-1', 'ado-tok');

    const args = await cloneAndReadArgs(
      'https://dev.azure.com/contoso/proj/_git/repo',
      {},
      { account: ado },
    );

    expect(args.token).to.equal('ado-tok');
  });

  it("uses the picked Bitbucket account's credential", async () => {
    // Bitbucket had no clone-token resolution at all, so a private repository
    // picked from a Bitbucket account cloned unauthenticated and failed. The
    // one token slot carries either an OAuth access token or the prefixed
    // app-password credential; the backend tells them apart.
    const bb = account('bitbucket', 'bb-1', 'team');
    unifiedProfileStore.getState().setAccounts([bb]);
    seedAccountToken('bitbucket', 'bb-1', 'bbapp:alice:app-pass');

    const args = await cloneAndReadArgs('https://alice@bitbucket.org/team/repo.git', {}, {
      account: bb,
    });

    expect(args.token).to.equal('bbapp:alice:app-pass');
  });

  it('does not attach the picked account token to a plaintext clone URL', async () => {
    const personal = account('github', 'gh-personal');
    unifiedProfileStore.getState().setAccounts([personal]);
    seedAccountToken('github', 'gh-personal', 'personal-tok');

    const args = await cloneAndReadArgs('http://github.com/me/private.git', {}, {
      account: personal,
    });

    expect(args.token, 'a token must not go over http in clear').to.equal(undefined);
  });

  it('ignores the picked account when the caller supplied a token', async () => {
    const personal = account('github', 'gh-personal');
    unifiedProfileStore.getState().setAccounts([personal]);
    seedAccountToken('github', 'gh-personal', 'personal-tok');

    const args = await cloneAndReadArgs(
      'https://github.com/me/private.git',
      { token: 'explicit' },
      { account: personal },
    );

    expect(args.token).to.equal('explicit');
    expect(invokedCommands).to.not.include('get_keyring_token');
  });

  // ── Bitbucket by host ────────────────────────────────────────────────────

  it("attaches the default Bitbucket account's credential for a bitbucket.org clone", async () => {
    unifiedProfileStore.getState().setAccounts([account('bitbucket', 'bb-1', 'team')]);
    seedAccountToken('bitbucket', 'bb-1', 'bb-oauth-tok');

    const args = await cloneAndReadArgs('https://bitbucket.org/team/repo.git');

    expect(args.token).to.equal('bb-oauth-tok');
  });

  it('falls back to the legacy Bitbucket username and app password', async () => {
    keyring.set('bitbucket_username', 'alice');
    keyring.set('bitbucket_password', 'app-pass');

    const args = await cloneAndReadArgs('https://bitbucket.org/team/repo.git');

    expect(args.token, 'carried in the prefixed form the backend splits').to.equal(
      'bbapp:alice:app-pass',
    );
  });

  it('attaches no Bitbucket credential to a look-alike host', async () => {
    unifiedProfileStore.getState().setAccounts([account('bitbucket', 'bb-1', 'team')]);
    seedAccountToken('bitbucket', 'bb-1', 'bb-oauth-tok');

    const args = await cloneAndReadArgs('https://bitbucket.org.evil.test/team/repo.git');

    expect(args.token).to.equal(undefined);
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
