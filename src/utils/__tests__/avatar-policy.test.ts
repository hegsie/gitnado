/**
 * Unit tests for the avatar fetch policy.
 *
 * Author avatars are `new Image()` loads to gravatar.com, so they never pass
 * through git.service's Tauri-command network gate. This module is their gate,
 * and these tests cover every combination of the three settings that feed it
 * plus the allowlist host-matching rules it borrows from that gate.
 */
import { expect } from '@open-wc/testing';
import {
  GRAVATAR_HOST,
  allowlistPermits,
  avatarBlockedExplanation,
  avatarFetchBlockReason,
  shouldFetchAvatars,
  shouldFetchAvatarsNow,
  type AvatarPolicyInput,
} from '../avatar-policy.ts';
import { settingsStore } from '../../stores/settings.store.ts';

function policy(overrides: Partial<AvatarPolicyInput> = {}): AvatarPolicyInput {
  return {
    showAvatars: true,
    offlineMode: false,
    remoteAllowlist: [],
    ...overrides,
  };
}

describe('avatar-policy — allowlistPermits', () => {
  it('permits everything when the allowlist is empty', () => {
    // "Leave empty to allow all" — the same early return checkNetworkAllowed makes.
    expect(allowlistPermits(GRAVATAR_HOST, [])).to.be.true;
  });

  it('permits an exact host match', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['www.gravatar.com'])).to.be.true;
  });

  it('permits a subdomain of an allowlisted domain', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['gravatar.com'])).to.be.true;
  });

  it('accepts a leading wildcard as the same thing a bare domain means', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['*.gravatar.com'])).to.be.true;
  });

  it('accepts a full URL entry and matches on its host', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['https://gravatar.com/avatar'])).to.be.true;
  });

  it('is case- and whitespace-insensitive', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['  GravaTar.CoM  '])).to.be.true;
  });

  it('refuses a look-alike host that merely contains the allowed domain', () => {
    // A substring match over the URL — what the old allowlist did — would let
    // this through.
    expect(allowlistPermits('gravatar.com.evil.test', ['gravatar.com'])).to.be.false;
    expect(allowlistPermits('notgravatar.com', ['gravatar.com'])).to.be.false;
  });

  it('refuses a host that is not on a non-empty allowlist', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['github.com', 'gitlab.com'])).to.be.false;
  });

  it('refuses when every entry is blank', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['   '])).to.be.false;
  });

  it('refuses a blank host', () => {
    expect(allowlistPermits('', ['gravatar.com'])).to.be.false;
  });

  it('permits when any one entry of several matches', () => {
    expect(allowlistPermits(GRAVATAR_HOST, ['github.com', 'gravatar.com'])).to.be.true;
  });
});

describe('avatar-policy — avatarFetchBlockReason / shouldFetchAvatars', () => {
  // Every combination of the three inputs, with the allowlist in each of its
  // three meaningful shapes (empty / permitting / refusing).
  const allowlists: Array<{ label: string; value: string[]; permits: boolean }> = [
    { label: 'empty allowlist', value: [], permits: true },
    { label: 'allowlist with gravatar', value: ['gravatar.com'], permits: true },
    { label: 'allowlist without gravatar', value: ['github.com'], permits: false },
  ];

  for (const showAvatars of [true, false]) {
    for (const offlineMode of [true, false]) {
      for (const list of allowlists) {
        const input = policy({ showAvatars, offlineMode, remoteAllowlist: list.value });
        const expected = !showAvatars
          ? 'disabled'
          : offlineMode
            ? 'offline'
            : list.permits
              ? null
              : 'allowlist';

        it(`showAvatars=${showAvatars} offlineMode=${offlineMode} ${list.label} → ${expected ?? 'allowed'}`, () => {
          expect(avatarFetchBlockReason(input)).to.equal(expected);
          expect(shouldFetchAvatars(input)).to.equal(expected === null);
        });
      }
    }
  }

  it('reports the feature switch before the network settings', () => {
    // With avatars off there is nothing to explain about the network.
    expect(avatarFetchBlockReason(policy({ showAvatars: false, offlineMode: true }))).to.equal(
      'disabled'
    );
  });

  it('reports offline mode before the allowlist', () => {
    expect(
      avatarFetchBlockReason(policy({ offlineMode: true, remoteAllowlist: ['github.com'] }))
    ).to.equal('offline');
  });
});

describe('avatar-policy — avatarBlockedExplanation', () => {
  it('is null when nothing blocks the fetch', () => {
    expect(avatarBlockedExplanation(policy())).to.equal(null);
  });

  it('is null when only the feature switch is off — that is not a block', () => {
    // The user turning avatars off must not make the control look unavailable.
    expect(avatarBlockedExplanation(policy({ showAvatars: false }))).to.equal(null);
  });

  it('names offline mode and gravatar.com', () => {
    const reason = avatarBlockedExplanation(policy({ offlineMode: true }));
    expect(reason).to.be.a('string');
    expect(reason).to.contain('Offline Mode');
    expect(reason).to.contain('gravatar.com');
  });

  it('names the allowlist and the host it is missing', () => {
    const reason = avatarBlockedExplanation(policy({ remoteAllowlist: ['github.com'] }));
    expect(reason).to.be.a('string');
    expect(reason).to.contain('allowlist');
    expect(reason).to.contain(GRAVATAR_HOST);
  });

  it('explains offline mode even when avatars are also switched off', () => {
    const reason = avatarBlockedExplanation(policy({ showAvatars: false, offlineMode: true }));
    expect(reason).to.contain('Offline Mode');
  });
});

describe('avatar-policy — shouldFetchAvatarsNow reads the live store', () => {
  afterEach(() => {
    settingsStore.getState().resetToDefaults();
  });

  it('is false with the shipped defaults (avatars are opt-in)', () => {
    settingsStore.getState().resetToDefaults();
    expect(shouldFetchAvatarsNow()).to.be.false;
  });

  it('is true once the user opts in', () => {
    settingsStore.getState().resetToDefaults();
    settingsStore.getState().setShowAvatars(true);
    expect(shouldFetchAvatarsNow()).to.be.true;
  });

  it('goes false again when offline mode is switched on', () => {
    settingsStore.getState().resetToDefaults();
    settingsStore.getState().setShowAvatars(true);
    settingsStore.getState().setOfflineMode(true);
    expect(shouldFetchAvatarsNow()).to.be.false;
  });

  it('goes false when an allowlist excludes gravatar.com', () => {
    settingsStore.getState().resetToDefaults();
    settingsStore.getState().setShowAvatars(true);
    settingsStore.getState().setRemoteAllowlist(['github.com']);
    expect(shouldFetchAvatarsNow()).to.be.false;
  });
});
