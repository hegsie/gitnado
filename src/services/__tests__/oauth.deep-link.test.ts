/**
 * OAuth deep-link scheme recognition. The app accepts callbacks on both the
 * current `gitnado://` scheme and the pre-rename `leviathan://` scheme.
 */

import { expect } from '@open-wc/testing';

// Same environment shims as oauth.service.test.ts — the module reads
// import.meta.env and the Tauri globals when it is evaluated.
(globalThis as unknown as { import: { meta: { env: Record<string, string> } } }).import = {
  meta: { env: { DEV: 'true', MODE: 'test' } },
};
if (typeof import.meta === 'object' && !import.meta.env) {
  (import.meta as unknown as { env: Record<string, string> }).env = { DEV: 'true', MODE: 'test' };
}
(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: () => Promise<unknown> } }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
};

import { OAUTH_DEEP_LINK_PREFIXES, oauthDeepLinkProvider } from '../oauth.service.ts';

describe('oauthDeepLinkProvider', () => {
  it('accepts both the current and the legacy scheme', () => {
    expect(OAUTH_DEEP_LINK_PREFIXES).to.deep.equal(['gitnado://oauth/', 'leviathan://oauth/']);
  });

  it('extracts the provider from a gitnado:// callback', () => {
    expect(oauthDeepLinkProvider('gitnado://oauth/gitlab/callback?code=abc&state=xyz')).to.equal(
      'gitlab'
    );
  });

  it('extracts the provider from a legacy leviathan:// callback', () => {
    expect(
      oauthDeepLinkProvider('leviathan://oauth/bitbucket/callback?code=abc&state=xyz')
    ).to.equal('bitbucket');
  });

  it('handles a provider segment with no trailing path', () => {
    expect(oauthDeepLinkProvider('gitnado://oauth/github?code=1')).to.equal('github');
    expect(oauthDeepLinkProvider('gitnado://oauth/github')).to.equal('github');
  });

  it('rejects non-OAuth and foreign-scheme links', () => {
    expect(oauthDeepLinkProvider('gitnado://open?repo=x')).to.be.null;
    expect(oauthDeepLinkProvider('leviathan://something-else/gitlab')).to.be.null;
    expect(oauthDeepLinkProvider('https://example.com/oauth/gitlab/callback')).to.be.null;
    expect(oauthDeepLinkProvider('other://oauth/gitlab/callback')).to.be.null;
    expect(oauthDeepLinkProvider('')).to.be.null;
  });

  it('rejects an OAuth link with an empty provider segment', () => {
    expect(oauthDeepLinkProvider('gitnado://oauth/')).to.be.null;
    expect(oauthDeepLinkProvider('gitnado://oauth//callback')).to.be.null;
  });
});
