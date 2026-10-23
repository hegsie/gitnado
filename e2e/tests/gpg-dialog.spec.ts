import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the GPG signing dialog (gn-gpg-dialog) when the repository
 * signs with SSH (gpg.format=ssh).
 *
 * Git then signs with a key from ~/.ssh and never consults the GPG keyring,
 * so the setup wizard must offer the SSH keys — offering GPG keys would write
 * a GPG key id into user.signingkey and break every signed commit, and
 * offering "generate a GPG key" is a dead end with no way out.
 */

const ED25519 = {
  name: 'id_ed25519',
  path: '/home/u/.ssh/id_ed25519',
  publicPath: '/home/u/.ssh/id_ed25519.pub',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
  comment: 'me@example.com',
  publicKey: 'ssh-ed25519 AAAA me@example.com',
};

// get_ssh_keys lists a private key with a known name even when its .pub file
// is missing, so publicPath names a file that does not exist.
const ORPHAN = {
  name: 'id_ecdsa',
  path: '/home/u/.ssh/id_ecdsa',
  publicPath: '/home/u/.ssh/id_ecdsa.pub',
  keyType: 'unknown',
  fingerprint: null,
  comment: null,
  publicKey: null,
};

const SSH_CONFIG = {
  gpgAvailable: true,
  gpgVersion: 'gpg (GnuPG) 2.2.27',
  signingKey: null,
  signCommits: false,
  signTags: false,
  gpgProgram: null,
  gpgFormat: 'ssh',
};

async function openGpgDialog(page: Page): Promise<void> {
  await openViaCommandPalette(page, 'GPG Signing Settings');
  await page.locator('gn-gpg-dialog .dialog').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('GPG Dialog - SSH signing', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('an SSH signer picks a key from ~/.ssh and the choice is persisted', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_gpg_config: SSH_CONFIG,
      get_gpg_keys: [],
      get_ssh_keys: [ED25519],
      set_signing_key: null,
    });
    await openGpgDialog(page);

    const item = page.locator('gn-gpg-dialog .key-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('me@example.com');

    await item.click();

    await expect(page.locator('gn-gpg-dialog .message.success')).toBeVisible();
    const calls = await findCommand(page, 'set_signing_key');
    expect(calls).toHaveLength(1);
    // The public-key path, never a GPG key id: git reads the file at sign time.
    expect((calls[0].args as { keyId: string }).keyId).toBe('/home/u/.ssh/id_ed25519.pub');
  });

  test('an SSH signer with no keys is not told to generate a GPG key', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_gpg_config: SSH_CONFIG,
      get_gpg_keys: [],
      get_ssh_keys: [],
    });
    await openGpgDialog(page);

    await expect(page.locator('gn-gpg-dialog .command-block code')).toHaveText(
      'ssh-keygen -t ed25519 -C "your@email.com"'
    );
    await expect(page.locator('gn-gpg-dialog')).not.toContainText('No GPG keys found');
    // Back would lead into the GPG key-generation guide; Refresh is the way out.
    await expect(
      page.locator('gn-gpg-dialog .dialog-footer.wizard .btn-secondary')
    ).toHaveText('Refresh');
  });

  test('a key with no public key file is not offered as a signing choice', async ({ page }) => {
    // Selecting it would write a nonexistent .pub path into user.signingkey and
    // report success, while git then fails every signed commit.
    await startCommandCaptureWithMocks(page, {
      get_gpg_config: SSH_CONFIG,
      get_gpg_keys: [],
      get_ssh_keys: [ED25519, ORPHAN],
      set_signing_key: null,
    });
    await openGpgDialog(page);

    const item = page.locator('gn-gpg-dialog .key-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('me@example.com');
    await expect(page.locator('gn-gpg-dialog .unusable-keys')).toContainText(
      'id_ecdsa cannot sign'
    );

    await item.click();

    const calls = await findCommand(page, 'set_signing_key');
    expect(calls).toHaveLength(1);
    expect((calls[0].args as { keyId: string }).keyId).toBe('/home/u/.ssh/id_ed25519.pub');
  });

  test('a failing SSH key listing surfaces an error', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_gpg_config: SSH_CONFIG,
      get_gpg_keys: [],
    });
    await injectCommandError(page, 'get_ssh_keys', 'permission denied');
    await openGpgDialog(page);

    await expect(page.locator('gn-gpg-dialog .message.error')).toContainText('permission denied');
  });
});
