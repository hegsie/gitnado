/**
 * EVERY target shape, through every "what kind of target is this string" rule
 * the frontend gate has.
 *
 * This area produced a review finding in eight consecutive rounds, each time
 * for a spelling the previous fix's list did not include — a bare relative
 * remote, a login-less scp remote, a bracketed IPv6 literal, an `@` inside a
 * path, a repository whose name parses as a port. The cause was never one bad
 * rule; it was several rules answering the same question independently, so a
 * fix to one left the others behind. This table is the countermeasure: one row
 * per shape, so a change to any rule has to state here what it did to the rest.
 *
 * The backend half is pinned row for row by
 * `every_target_shape_through_every_parse` in
 * `src-tauri/src/services/security.rs`, and the two tables must agree.
 *
 * The rules are reached through the gate rather than imported, because that is
 * how the app reaches them:
 *
 * - `isLocalRemoteTarget` — a fetch, whose target came out of a repository's
 *   remotes and so IS a git remote;
 * - `isLocalTarget` — the SSH connection test, whose target is whatever the
 *   user typed in a host field and may be a bare host;
 * - the allowlist host — the same two calls with a list that names the host,
 *   and with one that does not.
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
import { fetch, testSshConnection } from '../git.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

interface Row {
  /** The string, as it appears in `remote.<name>.url` or in a host field. */
  target: string;
  /** `isLocalTarget`: the STRICT reading, for a target that may be a bare host
   * or a scheme-less endpoint. */
  local: boolean;
  /** `isLocalRemoteTarget`: the reading for a string known to be a git remote.
   * It may only ever WIDEN `local`, never narrow it. */
  localRemote: boolean;
  /** The host the allowlist judges, or null when the string names none. Only
   * consulted for a target the local rules do not carve out. */
  host: string | null;
}

const ROWS: Row[] = [
  // Paths, in every spelling both halves accept.
  { target: "/srv/git/x.git", local: true, localRemote: true, host: null },
  { target: "./x.git", local: true, localRemote: true, host: null },
  { target: "../x.git", local: true, localRemote: true, host: null },
  // `git remote add local .`
  { target: ".", local: true, localRemote: true, host: null },
  { target: "..", local: true, localRemote: true, host: null },
  // a colon INSIDE a path
  { target: ".\\x:y", local: true, localRemote: true, host: null },
  { target: "~/x.git", local: true, localRemote: true, host: null },
  // Windows drives
  { target: "C:\\repos\\x.git", local: true, localRemote: true, host: null },
  { target: "C:/repos/x.git", local: true, localRemote: true, host: null },
  // host-less `file://` is this machine
  { target: "file:///x", local: true, localRemote: true, host: null },
  { target: "file://localhost/x", local: true, localRemote: true, host: null },
  // THE bare relative remote. Local as a REMOTE — `git push` to it opens no
  // socket — and NOT local as a bare host or endpoint, which is the whole
  // reason there are two columns here.
  { target: "sub/mybackup.git", local: false, localRemote: true, host: "sub" },
  { target: "sub\\mybackup.git", local: false, localRemote: true, host: "sub" },
  // Same SHAPE as the row above, and it is a scheme-less provider instance URL
  // rather than a path. Nothing in the string tells them apart, so the widened
  // rule is asked for by the CALLER: `providerApiHost` hands this to the gate
  // as a host, where the strict column applies and the host is judged.
  { target: "gitlab.example.com/gitlab", local: false, localRemote: true, host: "gitlab.example.com" },
  // No separator at all: indistinguishable from a bare host, so not local even
  // as a remote. `./mybackup.git` is the spelling that says otherwise.
  { target: "mybackup.git", local: false, localRemote: false, host: "mybackup.git" },
  // a one-letter authority with no login is a drive, and `x` is no path
  { target: "c:x", local: false, localRemote: false, host: null },
  // UNC is SMB, in either spelling
  { target: "\\\\server\\share\\x", local: false, localRemote: false, host: "server" },
  { target: "//server/share/x", local: false, localRemote: false, host: "server" },
  // The scp-like form, with a login and without.
  { target: "git@host:x", local: false, localRemote: false, host: "host" },
  { target: "deploy@host:x", local: false, localRemote: false, host: "host" },
  // a `~` does not make an scp remote a path
  { target: "~deploy@host:x", local: false, localRemote: false, host: "host" },
  // the login left to ~/.ssh/config
  { target: "gitserver:team/app.git", local: false, localRemote: false, host: "gitserver" },
  // a repository named `2024`; the backend's `parse_remote_target` reads it as
  // ssh rather than as port 2024, and the HOST is `gitserver` either way
  { target: "gitserver:2024", local: false, localRemote: false, host: "gitserver" },
  { target: "host:22", local: false, localRemote: false, host: "host" },
  { target: "git@host:2222", local: false, localRemote: false, host: "host" },
  { target: "x:22", local: false, localRemote: false, host: "x" },
  // Port 443, GitHub's own documented workaround for a network that blocks
  // port 22 (`ssh.github.com:443`, and the same spelling for
  // `altssh.gitlab.com` and `altssh.bitbucket.org`). The backend used to read
  // these with NO port at all: it rebuilt a scheme-less target through a
  // synthesised `https://` URL, and a WHATWG URL parser normalizes away a port
  // equal to the scheme's default — so 443 was the one port `ssh -T` never
  // received. This half judges only the HOST, which never differed; the port
  // column that catches it lives in the backend table these rows mirror.
  { target: "ssh.github.com:443", local: false, localRemote: false, host: "ssh.github.com" },
  { target: "host:443", local: false, localRemote: false, host: "host" },
  { target: "host:80", local: false, localRemote: false, host: "host" },
  { target: "git@host:443", local: false, localRemote: false, host: "host" },
  { target: "x:443", local: false, localRemote: false, host: "x" },
  // bracketed IPv6, read whole
  { target: "[::1]:x", local: false, localRemote: false, host: "[::1]" },
  { target: "git@[::1]:x", local: false, localRemote: false, host: "[::1]" },
  { target: "[::1]:22", local: false, localRemote: false, host: "[::1]" },
  { target: "[::1]:443", local: false, localRemote: false, host: "[::1]" },
  // the `@` is in the PATH
  { target: "gitserver:x@evil.test:y", local: false, localRemote: false, host: "gitserver" },
  { target: "git@github.com:x@evil.test:y", local: false, localRemote: false, host: "github.com" },
  // Schemes.
  { target: "https://h/x", local: false, localRemote: false, host: "h" },
  { target: "http://h:8443/x", local: false, localRemote: false, host: "h" },
  { target: "git://h/x", local: false, localRemote: false, host: "h" },
  { target: "ssh://h/x", local: false, localRemote: false, host: "h" },
  { target: "ssh://git@h:2222/x", local: false, localRemote: false, host: "h" },
  // …another machine is not this one
  { target: "file://server/share/x", local: false, localRemote: false, host: "server" },
  // Bare hosts, which is why the separator rule cannot be unconditional.
  { target: "api.github.com", local: false, localRemote: false, host: "api.github.com" },
  { target: "git@github.com", local: false, localRemote: false, host: "github.com" },
  // the host is after the `@`, not before it
  { target: "github.com@evil.test", local: false, localRemote: false, host: "evil.test" },
  // Forms git does not accept, and strings with no host at all.
  { target: "@host:x", local: false, localRemote: false, host: null },
  { target: "x@:y", local: false, localRemote: false, host: null },
  { target: "ssh://", local: false, localRemote: false, host: null },
  { target: "", local: false, localRemote: false, host: null },
];

/** A remote name that is not in the mocked list, so it can never match one. */
const DECOY = 'decoy.invalid';

function mockRemotes(url: string): void {
  mockInvoke = (command: string) => {
    if (command === 'get_remotes') {
      return Promise.resolve([{ name: 'origin', url, fetchUrl: url, pushUrl: url }]);
    }
    if (command === 'get_fetch_remote') return Promise.resolve('origin');
    return Promise.resolve(null);
  };
}

/** Did a fetch against a remote whose url is `url` reach the backend? */
async function fetchReached(url: string): Promise<boolean> {
  invokeHistory.length = 0;
  mockRemotes(url);
  await fetch({ path: '/repo', remote: 'origin', silent: true });
  return invokeHistory.some((c) => c.command === 'fetch');
}

/** Did an SSH connection test against `host` reach the backend? */
async function sshReached(host: string): Promise<boolean> {
  invokeHistory.length = 0;
  mockInvoke = () => Promise.resolve(null);
  await testSshConnection(host);
  return invokeHistory.some((c) => c.command === 'test_ssh_connection');
}

describe('target parsing differential', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    mockInvoke = () => Promise.resolve(null);
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  for (const row of ROWS) {
    const label = row.target === '' ? '(empty)' : row.target;

    it(`${label}: offline mode carves it out as a REMOTE only when it is a place on this machine`, async () => {
      settingsStore.setState({ offlineMode: true });

      expect(await fetchReached(row.target), label).to.equal(row.localRemote);
    });

    it(`${label}: offline mode carves it out as a HOST FIELD under the strict rule`, async () => {
      settingsStore.setState({ offlineMode: true });

      expect(await sshReached(row.target), label).to.equal(row.local);
    });

    it(`${label}: the widened remote rule never narrows the strict one`, () => {
      expect(!row.local || row.localRemote, label).to.equal(true);
    });

    it(`${label}: an allowlist naming its host lets it through, and one that does not refuses it`, async () => {
      if (row.host !== null) {
        settingsStore.setState({ remoteAllowlist: [row.host] });
        expect(await fetchReached(row.target), `${label} on an allowlist naming its host`).to.equal(
          true,
        );
      }

      settingsStore.setState({ remoteAllowlist: [DECOY] });
      // Only the local carve-out can let a target past a list that does not
      // name its host — and an unresolvable host must fail CLOSED, never open.
      expect(await fetchReached(row.target), `${label} on an unrelated allowlist`).to.equal(
        row.localRemote,
      );
    });

    it(`${label}: the host field is judged on the same host`, async () => {
      if (row.host !== null) {
        settingsStore.setState({ remoteAllowlist: [row.host] });
        expect(await sshReached(row.target), `${label} on an allowlist naming its host`).to.equal(
          true,
        );
      }

      settingsStore.setState({ remoteAllowlist: [DECOY] });
      expect(await sshReached(row.target), `${label} on an unrelated allowlist`).to.equal(row.local);
    });
  }

  /**
   * `resolveRemoteUrl` / `resolveRemotePushUrl` decide whether the string they
   * were handed is already a URL or the NAME of a remote. That test was a regex
   * requiring an `@` — the requirement the backend dropped when it learned
   * git's scp login is optional — so the two halves disagreed about
   * `gitserver:team/app.git`: the backend passed it through as a URL, this half
   * looked it up as a remote name, found none, and judged whichever remote
   * happened to be first in the list.
   */
  describe('"is this already a URL?" agrees with the backend', () => {
    beforeEach(() => {
      mockRemotes('https://elsewhere.test/x/y.git');
      settingsStore.setState({ remoteAllowlist: ['gitserver'] });
    });

    it('passes a login-less scp remote through as a URL', async () => {
      invokeHistory.length = 0;

      const result = await fetch({ path: '/repo', remote: 'gitserver:team/app.git', silent: true });

      expect(result.success, 'gitserver is on the list').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });

    it('still judges an scp remote with a login on its own host', async () => {
      invokeHistory.length = 0;
      settingsStore.setState({ remoteAllowlist: ['elsewhere.test'] });

      const result = await fetch({ path: '/repo', remote: 'deploy@gitserver:team/app.git', silent: true });

      expect(result.success, 'the URL names gitserver, not elsewhere.test').to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    /**
     * ...and a caller that NAMED a remote gets that remote or nothing. Falling
     * back to the first in the list judged, and reported, a host the caller
     * never named. The backend (`resolve_remote_url`) and `resolveRemotePushUrl`
     * both fail closed here; `resolveRemoteUrl` did not.
     */
    it('fails closed when a NAMED remote is not in the list', async () => {
      invokeHistory.length = 0;
      settingsStore.setState({ remoteAllowlist: ['elsewhere.test'] });

      const result = await fetch({ path: '/repo', remote: 'upstream', silent: true });

      expect(
        result.success,
        'origin\'s host must not stand in for the remote the caller named',
      ).to.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(false);
    });

    it('still resolves the default remote when the caller names none', async () => {
      invokeHistory.length = 0;
      settingsStore.setState({ remoteAllowlist: ['elsewhere.test'] });

      const result = await fetch({ path: '/repo', silent: true });

      expect(result.success, 'no name means the remote git itself would use').to.not.equal(false);
      expect(invokeHistory.some((c) => c.command === 'fetch')).to.equal(true);
    });
  });
});
