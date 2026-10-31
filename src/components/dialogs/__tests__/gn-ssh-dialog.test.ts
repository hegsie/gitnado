/**
 * SSH Key Management Dialog Tests
 *
 * Covers error surfacing on initial load, clearing sensitive form state
 * (passphrase, email, filename, test host) on close, and toast feedback
 * when deleting an SSH key.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { SshConfig, SshKey } from '../../../services/git.service.ts';

let failCommands: Set<string> = new Set();
let mockKeys: SshKey[] = [];
const mockConfig: SshConfig = {
  sshAvailable: true,
  sshVersion: 'OpenSSH_9.0',
  sshDir: '/home/user/.ssh',
  gitSshCommand: null,
};

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (command === 'plugin:dialog|message') return 'Ok';

  if (failCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: `${command} failed` };
  }

  switch (command) {
    case 'get_ssh_config':
      return mockConfig;
    case 'get_ssh_keys':
      return mockKeys;
    case 'delete_ssh_key':
      mockKeys = [];
      return null;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import '../gn-ssh-dialog.ts';
import type { GnSshDialog } from '../gn-ssh-dialog.ts';
import { uiStore } from '../../../stores/ui.store.ts';

describe('gn-ssh-dialog', () => {
  beforeEach(() => {
    failCommands = new Set();
    mockKeys = [
      {
        name: 'id_ed25519',
        path: '/home/user/.ssh/id_ed25519',
        publicPath: '/home/user/.ssh/id_ed25519.pub',
        keyType: 'ed25519',
        fingerprint: 'SHA256:abc',
        comment: 'user@example.com',
        publicKey: 'ssh-ed25519 AAAAC3 user@example.com',
      },
    ];
    uiStore.setState({ toasts: [] });
  });

  it('surfaces an error banner when loading SSH keys or config fails', async () => {
    failCommands.add('get_ssh_keys');

    const el = await fixture<GnSshDialog>(
      html`<gn-ssh-dialog ?open=${true}></gn-ssh-dialog>`,
    );
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const banner = el.shadowRoot!.querySelector('.status-banner.error');
    expect(banner).to.not.be.null;
    expect(banner!.textContent).to.include('get_ssh_keys failed');
  });

  it('clears passphrase and form inputs when closed', async () => {
    const el = await fixture<GnSshDialog>(
      html`<gn-ssh-dialog ?open=${true}></gn-ssh-dialog>`,
    );
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const internal = el as unknown as {
      generateEmail: string;
      generateFilename: string;
      generatePassphrase: string;
      testHost: string;
      copiedKey: string | null;
      error: string | null;
      handleClose: () => void;
    };

    internal.generateEmail = 'secret@example.com';
    internal.generateFilename = 'id_custom';
    internal.generatePassphrase = 'super-secret-passphrase';
    internal.testHost = 'git@custom.host';
    internal.copiedKey = 'id_ed25519';
    internal.error = 'Previous error';

    internal.handleClose();

    expect(internal.generateEmail).to.equal('');
    expect(internal.generateFilename).to.equal('');
    expect(internal.generatePassphrase).to.equal('');
    expect(internal.testHost).to.equal('');
    expect(internal.copiedKey).to.be.null;
    expect(internal.error).to.be.null;
  });

  it('shows a success toast when an SSH key is deleted', async () => {
    const el = await fixture<GnSshDialog>(
      html`<gn-ssh-dialog ?open=${true}></gn-ssh-dialog>`,
    );
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    const internal = el as unknown as {
      handleDeleteKey: (key: SshKey) => Promise<void>;
    };
    await internal.handleDeleteKey(mockKeys[0]);

    const toasts = uiStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'success' && t.message.includes('id_ed25519'))).to.be.true;
  });
});
