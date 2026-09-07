/**
 * Credential Service Tests
 *
 * Tests for keyring operations using invokeCommand wrapper.
 */

import { expect } from '@open-wc/testing';

// Simulated credential storage
const credentialStorage = new Map<string, string>();
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
let storeFailure = false;

const mockInvoke = async (command: string, args?: unknown): Promise<unknown> => {
  const params = args as Record<string, unknown> | undefined;
  invokeCallArgs.push({ command, args: (params || {}) as Record<string, unknown> });

  if (command === 'store_keyring_token') {
    if (storeFailure) return Promise.reject('Storage error');
    const key = params?.key as string;
    const value = params?.value as string;
    credentialStorage.set(key, value);
    return null;
  }

  if (command === 'get_keyring_token') {
    const key = params?.key as string;
    return credentialStorage.get(key) ?? null;
  }

  if (command === 'delete_keyring_token') {
    const key = params?.key as string;
    credentialStorage.delete(key);
    return null;
  }

  if (command === 'get_github_app_config') {
    return { appId: 123, installationId: 456 };
  }

  if (command === 'configure_github_app') {
    return { configured: true };
  }

  if (command === 'remove_github_app_config') {
    return null;
  }

  if (command === 'list_github_app_installations') {
    return [{ id: 1, account: { login: 'org', id: 1, type: 'Organization', avatarUrl: null }, appId: 123, targetType: 'Organization' }];
  }

  if (command === 'detect_credential_manager') {
    return { gcmAvailable: true, gcmVersion: '2.0', configuredHelper: 'manager-core', usingGitnadoFallback: false };
  }

  return null;
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: typeof mockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
};

import {
  storeCredential,
  getCredential,
  deleteCredential,
  hasCredential,
  CredentialKeys,
  configureGitHubApp,
  getGitHubAppConfig,
  removeGitHubAppConfig,
  listGitHubAppInstallations,
  detectCredentialManager,
} from '../credential.service.ts';

describe('credential.service - Keyring Operations via invokeCommand', () => {
  beforeEach(() => {
    credentialStorage.clear();
    invokeCallArgs.length = 0;
    storeFailure = false;
  });

  describe('storeCredential', () => {
    it('should invoke store_keyring_token', async () => {
      await storeCredential(CredentialKeys.GITHUB_TOKEN, 'test-token');

      const call = invokeCallArgs.find((c) => c.command === 'store_keyring_token');
      expect(call).to.not.be.undefined;
      expect(call!.args.key).to.equal('github_token');
      expect(call!.args.value).to.equal('test-token');
    });

    it('should store value in keyring', async () => {
      await storeCredential(CredentialKeys.GITHUB_TOKEN, 'my-token');
      expect(credentialStorage.get('github_token')).to.equal('my-token');
    });

    it('should throw on store failure', async () => {
      storeFailure = true;

      try {
        await storeCredential(CredentialKeys.GITHUB_TOKEN, 'test');
        expect.fail('Should have thrown');
      } catch (e) {
        // invokeCommand wraps the rejection and keyringStore re-throws
        expect((e as Error).message).to.be.a('string');
      }
    });
  });

  describe('getCredential', () => {
    it('should return stored credential', async () => {
      credentialStorage.set('github_token', 'stored-token');

      const result = await getCredential(CredentialKeys.GITHUB_TOKEN);
      expect(result).to.equal('stored-token');
    });

    it('should return null for missing credential', async () => {
      const result = await getCredential(CredentialKeys.GITHUB_TOKEN);
      expect(result).to.be.null;
    });
  });

  describe('deleteCredential', () => {
    it('should delete stored credential', async () => {
      credentialStorage.set('github_token', 'to-delete');

      await deleteCredential(CredentialKeys.GITHUB_TOKEN);

      expect(credentialStorage.has('github_token')).to.be.false;
    });

    it('should not throw when deleting non-existent credential', async () => {
      await deleteCredential(CredentialKeys.GITHUB_TOKEN);
      // Should not throw
    });
  });

  describe('hasCredential', () => {
    it('should return true when credential exists', async () => {
      credentialStorage.set('github_token', 'exists');

      const result = await hasCredential(CredentialKeys.GITHUB_TOKEN);
      expect(result).to.be.true;
    });

    it('should return false when credential missing', async () => {
      const result = await hasCredential(CredentialKeys.GITHUB_TOKEN);
      expect(result).to.be.false;
    });
  });

  describe('GitHub App functions', () => {
    it('configureGitHubApp should invoke and return data', async () => {
      const result = await configureGitHubApp(123, 'pem-key', 456);
      expect(result).to.deep.equal({ configured: true });
    });

    it('getGitHubAppConfig should invoke and return config', async () => {
      const result = await getGitHubAppConfig();
      expect(result).to.deep.equal({ appId: 123, installationId: 456 });
    });

    it('removeGitHubAppConfig should invoke without error', async () => {
      await removeGitHubAppConfig();
      const call = invokeCallArgs.find((c) => c.command === 'remove_github_app_config');
      expect(call).to.not.be.undefined;
    });

    it('listGitHubAppInstallations should invoke and return list', async () => {
      const result = await listGitHubAppInstallations(123, 'pem-key');
      expect(result).to.be.an('array');
      expect(result.length).to.equal(1);
      expect(result[0].id).to.equal(1);
    });
  });

  describe('detectCredentialManager', () => {
    it('should invoke and return status', async () => {
      const result = await detectCredentialManager('/path/to/repo');
      expect(result.gcmAvailable).to.be.true;
      expect(result.gcmVersion).to.equal('2.0');
    });
  });
});
