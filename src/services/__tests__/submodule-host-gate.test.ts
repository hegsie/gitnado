/**
 * `git submodule update` contacts the hosts named in `.gitmodules` — not the
 * superproject's remote.
 *
 * The gate used to check only the superproject, so an allowlist of
 * `github.com` on a github.com superproject sat there while the app cloned and
 * fetched from whatever `.gitmodules` pointed at. These pin the destinations
 * the operation really has, and pin that a relative url — which git resolves
 * against the superproject's own remote — is not refused for having no host of
 * its own.
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
import { addSubmodule, updateSubmodules } from '../git.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import { uiStore } from '../../stores/ui.store.ts';

/** The superproject's own remote — always on the allowlist in these tests, so
 * that anything refused is refused for the SUBMODULE's host. */
const SUPER_URL = 'https://github.com/me/super.git';

interface MockSubmodule {
  name: string;
  path: string;
  url: string | null;
}

function mockRepo(submodules: MockSubmodule[], superUrl = SUPER_URL): void {
  mockInvoke = (command: string) => {
    if (command === 'get_remotes') {
      return Promise.resolve([
        { name: 'origin', url: superUrl, fetchUrl: superUrl, pushUrl: superUrl },
      ]);
    }
    if (command === 'get_submodules') {
      return Promise.resolve(
        submodules.map((s) => ({
          ...s,
          headOid: null,
          branch: null,
          initialized: true,
          status: 'current',
        })),
      );
    }
    return Promise.resolve(null);
  };
}

function reachedUpdate(): boolean {
  return invokeHistory.some((c) => c.command === 'update_submodules');
}

describe('the submodule hosts the gate has to check', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  it('refuses an update whose submodule points off the allowlist', async () => {
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: 'https://gitlab.com/x/y.git' }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo');

    expect(result.success, 'the superproject being allowlisted is not enough').to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
    expect(reachedUpdate(), 'update_submodules must not be invoked').to.equal(false);
  });

  it('tells the user WHICH host was refused', async () => {
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: 'https://gitlab.com/x/y.git' }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    await updateSubmodules('/repo');

    const toasts = uiStore.getState().toasts;
    expect(toasts.length, 'a refusal the user cannot see is a silent failure').to.be.greaterThan(0);
    expect(toasts.some((t) => t.message.includes('gitlab.com'))).to.equal(true);
    expect(toasts.some((t) => t.type === 'error')).to.equal(true);
  });

  it('allows an update whose submodules are all on the allowlist', async () => {
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: 'https://github.com/x/y.git' }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo');

    expect(result.success, 'an allowlisted submodule host').to.not.equal(false);
    expect(reachedUpdate()).to.equal(true);
  });

  it('does not refuse a relative submodule url', async () => {
    // `../dep.git` resolves against the superproject's remote, which the check
    // above it already admitted. No host can be parsed out of the relative
    // string, so handing it to the allowlist would refuse it outright.
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: '../dep.git' }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo');

    expect(result.success, 'a relative submodule url is not an unknown host').to.not.equal(false);
    expect(reachedUpdate()).to.equal(true);
  });

  it('checks only the submodules the update names', async () => {
    mockRepo([
      { name: 'ok', path: 'vendor/ok', url: 'https://github.com/x/ok.git' },
      { name: 'off', path: 'vendor/off', url: 'https://gitlab.com/x/off.git' },
    ]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const allowed = await updateSubmodules('/repo', { submodulePaths: ['vendor/ok'] });
    expect(allowed.success, 'another submodule off the list is not this one').to.not.equal(false);

    invokeHistory.length = 0;
    const refused = await updateSubmodules('/repo', { submodulePaths: ['vendor/off'] });
    expect(refused.success).to.equal(false);
    expect(reachedUpdate()).to.equal(false);
  });

  it('treats an empty path list as every submodule, because git does', async () => {
    // The backend emits a bare `--` for an empty list, and git then updates
    // all of them — so an empty list must not narrow the check to nothing.
    mockRepo([{ name: 'off', path: 'vendor/off', url: 'https://gitlab.com/x/off.git' }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo', { submodulePaths: [] });

    expect(result.success).to.equal(false);
    expect(reachedUpdate()).to.equal(false);
  });

  it('refuses when a submodule has no url at all', async () => {
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: null }]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo');

    expect(result.success, 'an allowlist that cannot see a destination refuses').to.equal(false);
    expect(reachedUpdate()).to.equal(false);
  });

  it('fails closed when the submodules cannot be listed', async () => {
    mockInvoke = (command: string) => {
      if (command === 'get_remotes') {
        return Promise.resolve([
          { name: 'origin', url: SUPER_URL, fetchUrl: SUPER_URL, pushUrl: SUPER_URL },
        ]);
      }
      if (command === 'get_submodules') {
        return Promise.reject(new Error('cannot read .gitmodules'));
      }
      return Promise.resolve(null);
    };
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await updateSubmodules('/repo');

    expect(result.success).to.equal(false);
    expect(reachedUpdate()).to.equal(false);
  });

  it('does not list submodules at all when no policy is in force', async () => {
    mockRepo([{ name: 'dep', path: 'vendor/dep', url: 'https://gitlab.com/x/y.git' }]);

    const result = await updateSubmodules('/repo');

    expect(result.success).to.not.equal(false);
    expect(
      invokeHistory.some((c) => c.command === 'get_submodules'),
      'nothing could refuse it, so it must not pay for the round trip',
    ).to.equal(false);
  });

  it('checks a relative "git submodule add" against the superproject remote', async () => {
    mockRepo([]);
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await addSubmodule('/repo', '../dep.git', 'vendor/dep');

    expect(result.success, 'a relative add resolves to the allowlisted superproject').to.not.equal(
      false,
    );
    expect(invokeHistory.some((c) => c.command === 'add_submodule')).to.equal(true);
  });

  it('still refuses a relative "git submodule add" on an unlisted superproject', async () => {
    mockRepo([], 'https://gitlab.com/me/super.git');
    settingsStore.setState({ remoteAllowlist: ['github.com'] });

    const result = await addSubmodule('/repo', '../dep.git', 'vendor/dep');

    expect(result.success).to.equal(false);
    expect(invokeHistory.some((c) => c.command === 'add_submodule')).to.equal(false);
  });
});
