/**
 * GPG Dialog setup-detection tests
 *
 * Regression coverage for finding 98: an SSH signer (gpg.format=ssh with a
 * configured user.signingkey) must NOT be pushed into the "generate a GPG key"
 * setup flow just because no GPG keyring keys exist.
 */

// Mock Tauri API before importing any modules that use it
/** Commands that reject with a git error, e.g. a read-only .git/config. */
let failingCommands: Set<string> = new Set();
/** Config the backend reports, per repository path. */
const configByRepo = new Map<string, unknown>();
/** GPG keyring contents the backend reports. */
let gpgKeys: unknown[] = [];
/** ~/.ssh contents the backend reports. */
let sshKeys: unknown[] = [];
/** Every command the component issued, in order. */
let invoked: { command: string; args: unknown }[] = [];

const mockInvoke = (command: string, args?: unknown): Promise<unknown> => {
  invoked.push({ command, args });
  if (failingCommands.has(command)) {
    return Promise.reject({ code: 'COMMAND_ERROR', message: 'could not lock config file' });
  }
  if (command === 'get_gpg_config') {
    const path = ((args as { path?: string }) ?? {}).path ?? '';
    return Promise.resolve(configByRepo.get(path) ?? null);
  }
  if (command === 'get_gpg_keys') return Promise.resolve(gpgKeys);
  if (command === 'get_ssh_keys') return Promise.resolve(sshKeys);
  return Promise.resolve(null);
};
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-gpg-dialog.ts';
import type { GnGpgDialog } from '../gn-gpg-dialog.ts';
import type { GpgConfig, SshKey } from '../../../services/git.service.ts';

function makeConfig(overrides: Partial<GpgConfig>): GpgConfig {
  return {
    gpgAvailable: false,
    gpgVersion: null,
    signingKey: null,
    signCommits: false,
    signTags: false,
    gpgProgram: null,
    gpgFormat: null,
    ...overrides,
  };
}

interface DialogInternals {
  config: GpgConfig | null;
  keys: unknown[];
  setupMode: boolean;
  setupStep: string;
  detectSetupState(): void;
}

describe('gn-gpg-dialog SSH signing setup detection', () => {
  it('does not force a configured SSH signer into GPG generate-guide mode', async () => {
    const el = await fixture<GnGpgDialog>(
      html`<gn-gpg-dialog></gn-gpg-dialog>`
    );
    const internals = el as unknown as DialogInternals;
    // SSH signing configured, but no GPG keyring keys (the common case).
    internals.config = makeConfig({
      gpgFormat: 'ssh',
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: '~/.ssh/id_ed25519.pub',
    });
    internals.keys = [];

    internals.detectSetupState();

    expect(internals.setupMode).to.equal(false);
  });

  it('prompts SSH users to configure a key only when none is set', async () => {
    const el = await fixture<GnGpgDialog>(
      html`<gn-gpg-dialog></gn-gpg-dialog>`
    );
    const internals = el as unknown as DialogInternals;
    internals.config = makeConfig({ gpgFormat: 'ssh', signingKey: null });
    internals.keys = [];

    internals.detectSetupState();

    expect(internals.setupMode).to.equal(true);
    expect(internals.setupStep).to.equal('configure');
  });
});

// Both banners render unconditionally, and nothing ever cleared `success`:
// a green "Commit signing enabled" therefore sat under the red error of the
// NEXT toggle, and survived close/reopen to be replayed over another
// repository's settings.
describe('gn-gpg-dialog banner lifecycle', () => {
  const REPO_A = '/repo/a';
  const REPO_B = '/repo/b';

  beforeEach(() => {
    failingCommands = new Set();
    configByRepo.clear();
    configByRepo.set(
      REPO_A,
      makeConfig({ gpgAvailable: true, gpgVersion: 'gpg (GnuPG) 2.2.27', signingKey: 'KEY1' }),
    );
    configByRepo.set(
      REPO_B,
      makeConfig({ gpgAvailable: true, gpgVersion: 'gpg (GnuPG) 2.2.27', signingKey: 'KEY2' }),
    );
  });

  async function openOn(path: string): Promise<GnGpgDialog> {
    const el = await fixture<GnGpgDialog>(
      html`<gn-gpg-dialog ?open=${true} .repositoryPath=${path}></gn-gpg-dialog>`,
    );
    for (let i = 0; i < 200; i++) {
      if ((el as unknown as DialogInternals).config) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    await el.updateComplete;
    return el;
  }

  function banners(el: GnGpgDialog): { success: string | null; error: string | null } {
    const root = el.shadowRoot!;
    return {
      success: root.querySelector('.message.success')?.textContent?.trim() ?? null,
      error: root.querySelector('.message.error')?.textContent?.trim() ?? null,
    };
  }

  it('a failed toggle does not render under the previous toggle\'s success', async () => {
    const el = await openOn(REPO_A);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleCommitSigning();
    await el.updateComplete;
    expect(banners(el).success, 'the first toggle reports').to.contain('Commit signing');

    // The second toggle fails — a read-only .git/config, a missing key, or
    // --global scope the user cannot write.
    failingCommands.add('set_tag_signing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleTagSigning();
    await el.updateComplete;

    const after = banners(el);
    expect(after.error, 'the failure is reported').to.not.be.null;
    expect(after.success, 'and the stale green banner is gone').to.be.null;
  });

  it('the same holds for every sibling handler', async () => {
    // Each of the three handlers sets `success`, so each of them has to clear
    // it — one straggler is enough to put a green banner over a red one.
    const el = await openOn(REPO_A);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleTagSigning();
    await el.updateComplete;
    expect(banners(el).success).to.contain('Tag signing');

    failingCommands.add('set_commit_signing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleCommitSigning();
    await el.updateComplete;
    expect(banners(el).error, 'the commit-signing failure is reported').to.not.be.null;
    expect(banners(el).success, 'no stale tag-signing banner beside it').to.be.null;

    failingCommands.delete('set_commit_signing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleSelectKey('KEY1');
    await el.updateComplete;
    expect(banners(el).success).to.contain('Signing key');

    failingCommands.add('set_signing_key');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleSelectKey('KEY2');
    await el.updateComplete;
    expect(banners(el).error, 'the key failure is reported').to.not.be.null;
    expect(banners(el).success, 'no stale key banner beside it').to.be.null;
  });

  it('a success does not survive close, repository switch and reopen', async () => {
    const el = await openOn(REPO_A);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleCommitSigning();
    await el.updateComplete;
    expect(banners(el).success).to.contain('Commit signing');

    // The dialog stays mounted; the host only toggles ?open. Ctrl+Tab then
    // rebinds repositoryPath to another repository.
    el.open = false;
    await el.updateComplete;
    el.repositoryPath = REPO_B;
    el.open = true;
    await el.updateComplete;
    for (let i = 0; i < 200; i++) {
      if ((el as unknown as DialogInternals).config === configByRepo.get(REPO_B)) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    await el.updateComplete;

    expect(
      banners(el).success,
      'repo B never had its commit signing enabled',
    ).to.be.null;
  });

  it('the loaders do not blank a message the user just asked for', async () => {
    // loadData() runs AFTER a handler has set its message (Refresh & Check
    // calls it directly), so clearing there would erase the result.
    const el = await openOn(REPO_A);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleToggleCommitSigning();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleRefreshAndCheck();
    await el.updateComplete;

    expect(banners(el).success, 'still on screen after a reload').to.contain('Commit signing');
  });
});


/**
 * gpg.format=ssh means git signs with an SSH key from ~/.ssh and never touches
 * the GPG keyring. The setup wizard used to render the OpenPGP key list here:
 * with a GPG key present, picking one wrote a GPG key id into user.signingkey
 * and broke every signed commit ("failed to read ssh signing key"); with no
 * GPG keys — the common case — it was a dead end that told the user to run
 * `gpg --full-generate-key` and left Complete Setup disabled forever.
 */
describe('gn-gpg-dialog SSH signing key picker', () => {
  const REPO = '/repo/ssh';
  const ED25519: SshKey = {
    name: 'id_ed25519',
    path: '/home/u/.ssh/id_ed25519',
    publicPath: '/home/u/.ssh/id_ed25519.pub',
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:abc',
    comment: 'me@example.com',
    publicKey: 'ssh-ed25519 AAAA me@example.com',
  };
  const RSA: SshKey = {
    name: 'id_rsa',
    path: '/home/u/.ssh/id_rsa',
    publicPath: '/home/u/.ssh/id_rsa.pub',
    keyType: 'ssh-rsa',
    fingerprint: 'SHA256:def',
    comment: null,
    publicKey: 'ssh-rsa AAAA',
  };
  // get_ssh_keys lists a private key with a known name even when its .pub file
  // is missing: publicPath then names a file that does not exist, so nothing
  // can sign with it.
  const ORPHAN: SshKey = {
    name: 'id_ecdsa',
    path: '/home/u/.ssh/id_ecdsa',
    publicPath: '/home/u/.ssh/id_ecdsa.pub',
    keyType: 'unknown',
    fingerprint: null,
    comment: null,
    publicKey: null,
  };

  beforeEach(() => {
    failingCommands = new Set();
    configByRepo.clear();
    gpgKeys = [];
    sshKeys = [];
    invoked = [];
  });

  /** Wait for any in-flight load to finish and the render to catch up. */
  async function settle(el: GnGpgDialog): Promise<void> {
    for (let i = 0; i < 500; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (!(el as unknown as { loading: boolean }).loading) break;
    }
    await el.updateComplete;
  }

  async function open(): Promise<GnGpgDialog> {
    // The host keeps this dialog mounted and only toggles ?open, and the
    // repository is pinned on that transition — open it the same way so the
    // load runs against REPO rather than an unpinned empty path.
    const el = await fixture<GnGpgDialog>(
      html`<gn-gpg-dialog .repositoryPath=${REPO}></gn-gpg-dialog>`,
    );
    el.open = true;
    await el.updateComplete;
    await settle(el);
    return el;
  }

  it('offers the ~/.ssh keys, not the GPG keyring, when gpg.format=ssh', async () => {
    configByRepo.set(REPO, makeConfig({
      gpgFormat: 'ssh',
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: null,
    }));
    sshKeys = [ED25519, RSA];

    const el = await open();

    const items = el.shadowRoot!.querySelectorAll('.key-item');
    expect(items, 'both ~/.ssh keys are offered').to.have.length(2);
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).to.contain('me@example.com');
    expect(text, 'the GPG keyring is irrelevant here').to.not.contain('No GPG keys found');
  });

  it("writes the chosen key's public-key path to user.signingkey", async () => {
    configByRepo.set(REPO, makeConfig({
      gpgFormat: 'ssh',
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: null,
    }));
    sshKeys = [ED25519, RSA];

    const el = await open();
    let changed = 0;
    el.addEventListener('gpg-changed', () => { changed++; });

    const first = el.shadowRoot!.querySelector('.key-item') as HTMLElement | null;
    expect(first, 'there is a key to pick').to.not.be.null;
    first!.click();
    await settle(el);

    const call = invoked.find((c) => c.command === 'set_signing_key');
    expect(call, 'the key was persisted').to.not.be.undefined;
    const args = call!.args as { path: string; keyId: string };
    expect(args.keyId, 'an SSH public-key path, never a GPG key id')
      .to.equal('/home/u/.ssh/id_ed25519.pub');
    expect(args.path).to.equal(REPO);
    expect(
      el.shadowRoot!.querySelector('.message.success')?.textContent ?? '',
    ).to.contain('Signing key');
    expect(changed, 'gpg-changed is dispatched like every sibling handler').to.equal(1);
  });

  it('marks the configured SSH key as selected in the normal view', async () => {
    // A configured signing key leaves setupMode false, so this is the view the
    // wizard hands off into.
    configByRepo.set(REPO, makeConfig({
      gpgFormat: 'ssh',
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: '~/.ssh/id_ed25519.pub',
    }));
    sshKeys = [ED25519, RSA];

    const el = await open();

    const selected = el.shadowRoot!.querySelector('.key-item.selected');
    expect(selected, 'the configured key is shown as chosen').to.not.be.null;
    expect(selected!.textContent).to.contain('me@example.com');
    const text = el.shadowRoot!.textContent ?? '';
    expect(text, 'no GPG key generation advice for an SSH signer')
      .to.not.contain('gpg --full-generate-key');
  });

  it('an SSH signer with no keys gets ssh-keygen guidance, never a GPG key', async () => {
    configByRepo.set(REPO, makeConfig({ gpgFormat: 'ssh', signingKey: null }));
    sshKeys = [];

    const el = await open();

    const text = el.shadowRoot!.textContent ?? '';
    expect(text).to.contain('ssh-keygen');
    expect(text).to.not.contain('No GPG keys found');
    const back = el.shadowRoot!.querySelector('.dialog-footer.wizard .btn-secondary');
    expect(back, 'the wizard footer has a left button').to.not.be.null;
    expect(
      back!.textContent!.trim(),
      'Back would lead to the GPG generate guide; Refresh is the real flow',
    ).to.equal('Refresh');
    const complete = el.shadowRoot!.querySelector(
      '.dialog-footer.wizard .btn-primary',
    ) as HTMLButtonElement;
    expect(complete.disabled, 'nothing to complete until a key is picked').to.equal(true);
  });

  it('does not offer a key whose public key file is missing', async () => {
    // Writing that nonexistent .pub path into user.signingkey reports success
    // while ssh_key_is_usable() rejects it and every signed commit then fails
    // with "failed to read ssh signing key".
    configByRepo.set(REPO, makeConfig({
      gpgFormat: 'ssh',
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: null,
    }));
    sshKeys = [ED25519, ORPHAN];

    const el = await open();

    const items = el.shadowRoot!.querySelectorAll('.key-item');
    expect(items, 'only the key that can actually sign is offered').to.have.length(1);
    expect(items[0].textContent).to.contain('me@example.com');
    const text = el.shadowRoot!.textContent ?? '';
    expect(text, 'the skipped key is explained, not silently dropped')
      .to.contain('id_ecdsa cannot sign');
    expect(text, 'and the way to recover it is offered')
      .to.contain('ssh-keygen -y -f /home/u/.ssh/id_ecdsa > /home/u/.ssh/id_ecdsa.pub');
  });

  it('an SSH signer whose only key has no public key file gets ssh-keygen guidance', async () => {
    configByRepo.set(REPO, makeConfig({ gpgFormat: 'ssh', signingKey: null }));
    sshKeys = [ORPHAN];

    const el = await open();

    expect(
      el.shadowRoot!.querySelectorAll('.key-item'),
      'nothing selectable when no key can sign',
    ).to.have.length(0);
    expect(el.shadowRoot!.textContent ?? '').to.contain('No usable SSH keys found');
    const complete = el.shadowRoot!.querySelector(
      '.dialog-footer.wizard .btn-primary',
    ) as HTMLButtonElement;
    expect(complete.disabled, 'nothing to complete until a usable key exists').to.equal(true);
    expect(invoked.some((c) => c.command === 'set_signing_key')).to.equal(false);
  });

  it('a failing get_ssh_keys is reported, not silently empty', async () => {
    configByRepo.set(REPO, makeConfig({ gpgFormat: 'ssh', signingKey: null }));
    failingCommands.add('get_ssh_keys');

    const el = await open();

    expect(
      el.shadowRoot!.querySelector('.message.error')?.textContent ?? '',
    ).to.contain('could not lock config file');
  });

  it('openpgp repos still get the GPG keyring and never query ~/.ssh', async () => {
    // Guard against over-reach — this passes before and after the fix.
    configByRepo.set(REPO, makeConfig({
      gpgFormat: null,
      gpgAvailable: true,
      gpgVersion: 'gpg (GnuPG) 2.2.27',
      signingKey: 'LONGKEY1',
    }));
    gpgKeys = [{
      keyId: 'KEY1',
      keyIdLong: 'LONGKEY1',
      userId: 'Test User',
      email: 'test@example.com',
      keyType: 'rsa',
      keySize: 4096,
      trust: 'ultimate',
      expires: null,
    }];
    sshKeys = [ED25519];

    const el = await open();

    expect(el.shadowRoot!.textContent ?? '').to.contain('Test User');
    expect(invoked.some((c) => c.command === 'get_ssh_keys')).to.equal(false);
  });
});

// The signing switches used to be a bare <input type="checkbox"> whose visible
// "Sign commits" / "Sign tags" text was an unlinked sibling, so they reached
// the accessibility tree unnamed and could not be described.
describe('gn-gpg-dialog signing switches', () => {
  const REPO = '/repo/signing';

  beforeEach(() => {
    failingCommands = new Set();
    configByRepo.clear();
    configByRepo.set(
      REPO,
      makeConfig({ gpgAvailable: true, gpgVersion: 'gpg (GnuPG) 2.2.27', signingKey: 'KEY1' }),
    );
  });

  async function openOn(path: string): Promise<GnGpgDialog> {
    const el = await fixture<GnGpgDialog>(
      html`<gn-gpg-dialog ?open=${true} .repositoryPath=${path}></gn-gpg-dialog>`,
    );
    for (let i = 0; i < 200; i++) {
      if ((el as unknown as DialogInternals).config) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    await el.updateComplete;
    return el;
  }

  function switchNamed(el: GnGpgDialog, name: string): HTMLButtonElement {
    const toggle = Array.from(el.shadowRoot!.querySelectorAll('gn-toggle')).find(
      (t) => t.label === name,
    );
    expect(toggle, `the "${name}" switch is named`).to.exist;
    return toggle!.shadowRoot!.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  }

  it('names and describes both switches', async () => {
    const el = await openOn(REPO);
    expect(switchNamed(el, 'Sign commits').getAttribute('role')).to.equal('switch');
    expect(switchNamed(el, 'Sign tags').getAttribute('role')).to.equal('switch');

    const commits = Array.from(el.shadowRoot!.querySelectorAll('gn-toggle')).find(
      (t) => t.label === 'Sign commits',
    );
    expect(commits!.description).to.contain('Automatically sign all commits');
  });

  it('turns the switch on only once the backend has accepted the change', async () => {
    const el = await openOn(REPO);
    const commits = switchNamed(el, 'Sign commits');
    expect(commits.getAttribute('aria-checked')).to.equal('false');

    commits.click();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).updateComplete;
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(switchNamed(el, 'Sign commits').getAttribute('aria-checked')).to.equal('true');
  });

  it('leaves the switch off when the config write fails', async () => {
    const el = await openOn(REPO);
    failingCommands.add('set_commit_signing');

    switchNamed(el, 'Sign commits').click();
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(
      switchNamed(el, 'Sign commits').getAttribute('aria-checked'),
      'the switch does not run ahead of the backend',
    ).to.equal('false');
    expect(
      el.shadowRoot!.querySelector('.message.error'),
      'and the failure is reported',
    ).to.not.be.null;
  });
});
