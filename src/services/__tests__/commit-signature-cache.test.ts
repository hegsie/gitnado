import { expect } from '@open-wc/testing';
import { commitSignatureCache, createCacheKey } from '../cache.service.ts';

// Mock Tauri API
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let invokeCallCount = 0;
let lastInvokedCommand: string | null = null;

const mockSignature = {
  signed: true,
  status: 'good',
  keyId: 'ABCDEF12',
  signer: 'Test User',
  valid: true,
  trust: 'ultimate',
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string) => {
    invokeCallCount++;
    lastInvokedCommand = command;
    return Promise.resolve(mockSignature);
  },
};

import { getCommitsSignatures, type CommitSignature } from '../git.service.ts';

describe('getCommitsSignatures - cache consistency', () => {
  beforeEach(() => {
    invokeCallCount = 0;
    lastInvokedCommand = null;
    commitSignatureCache.clear();
  });

  it('should call Tauri when signature is not cached', async () => {
    (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__.invoke = (command: string) => {
      invokeCallCount++;
      lastInvokedCommand = command;
      return Promise.resolve([['abc123', mockSignature]]);
    };

    const result = await getCommitsSignatures('/test/repo', ['abc123']);

    expect(result.success).to.be.true;
    expect(result.data?.[0]?.[1].signed).to.be.true;
    expect(lastInvokedCommand).to.equal('get_commits_signatures');
    expect(invokeCallCount).to.equal(1);
  });

  it('should return cached result without Tauri call', async () => {
    // Pre-populate the cache
    const cacheKey = createCacheKey('/test/repo', 'abc123');
    commitSignatureCache.set(cacheKey, mockSignature);

    const result = await getCommitsSignatures('/test/repo', ['abc123']);

    expect(result.success).to.be.true;
    expect(result.data).to.deep.equal([['abc123', mockSignature as CommitSignature]]);
    // Should not have called Tauri
    expect(invokeCallCount).to.equal(0);
  });

  it('should cache the result after a Tauri call', async () => {
    (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__.invoke = (command: string) => {
      invokeCallCount++;
      lastInvokedCommand = command;
      return Promise.resolve([['def456', mockSignature]]);
    };

    // First call: not cached, calls Tauri
    await getCommitsSignatures('/test/repo', ['def456']);
    expect(invokeCallCount).to.equal(1);

    // Second call: should be cached
    invokeCallCount = 0;
    const result = await getCommitsSignatures('/test/repo', ['def456']);
    expect(result.success).to.be.true;
    expect(invokeCallCount).to.equal(0);
  });

  it('should use different cache keys for different repos', async () => {
    (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__.invoke = (command: string) => {
      invokeCallCount++;
      lastInvokedCommand = command;
      return Promise.resolve([['abc123', mockSignature]]);
    };

    const cacheKey = createCacheKey('/repo-a', 'abc123');
    commitSignatureCache.set(cacheKey, mockSignature);

    // Different repo path should not hit cache
    const result = await getCommitsSignatures('/repo-b', ['abc123']);
    expect(invokeCallCount).to.equal(1);
    expect(result.success).to.be.true;
  });
});
