import { expect } from '@open-wc/testing';

// Mock Tauri API
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
let lastInvokedCommand: string | null = null;
let lastInvokedArgs: unknown = null;

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    lastInvokedCommand = command;
    lastInvokedArgs = args;
    return mockInvoke(command, args);
  },
};

// Mock navigator.clipboard
let clipboardText = '';
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: (text: string) => {
      clipboardText = text;
      return Promise.resolve();
    },
    readText: () => Promise.resolve(clipboardText),
  },
  configurable: true,
  writable: true,
});

import {
  copyToClipboard,
  getCommitInfoForCopy,
  getFilePathForCopy,
  copyCommitSha,
  copyCommitMessage,
  copyCommitPatch,
  copyFilePath,
  type CopyResult,
} from '../git.service.ts';

/**
 * Swap navigator.clipboard for the duration of a test. Pass undefined to
 * simulate a browser/WebView that exposes no async clipboard API at all.
 */
function replaceClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
  return () => {
    if (original) {
      Object.defineProperty(navigator, 'clipboard', original);
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  };
}

/**
 * Stub document.execCommand so the legacy fallback path is observable and
 * deterministic — a real execCommand('copy') depends on browser policy.
 * Records the value staged in the off-screen textarea at call time.
 */
function stubExecCommand(result: boolean) {
  const original = document.execCommand;
  const calls: string[] = [];
  const stagedValues: string[] = [];
  document.execCommand = ((command: string) => {
    calls.push(command);
    const staged = document.activeElement;
    if (staged instanceof HTMLTextAreaElement) stagedValues.push(staged.value);
    return result;
  }) as typeof document.execCommand;
  return {
    calls,
    stagedValues,
    restore: () => {
      document.execCommand = original;
    },
  };
}

describe('git.service - Clipboard operations', () => {
  beforeEach(() => {
    lastInvokedCommand = null;
    lastInvokedArgs = null;
    clipboardText = '';
  });

  describe('copyToClipboard', () => {
    it('copies text to clipboard using navigator API', async () => {
      const result = await copyToClipboard('test text');

      expect(result.success).to.be.true;
      expect(result.data?.success).to.be.true;
      expect(result.data?.text).to.equal('test text');
      expect(clipboardText).to.equal('test text');
    });

    it('falls back to the legacy copy when the async API rejects', async () => {
      const restoreClipboard = replaceClipboard({
        writeText: () => Promise.reject(new Error('Clipboard access denied')),
      });
      const execCommand = stubExecCommand(true);

      const result = await copyToClipboard('fallback text');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('fallback text');
      expect(execCommand.calls).to.deep.equal(['copy']);
      expect(execCommand.stagedValues).to.deep.equal(['fallback text']);

      execCommand.restore();
      restoreClipboard();
    });

    it('falls back to the legacy copy when navigator.clipboard is unavailable', async () => {
      const restoreClipboard = replaceClipboard(undefined);
      const execCommand = stubExecCommand(true);

      const result = await copyToClipboard('no async api');

      expect(result.success).to.be.true;
      expect(execCommand.stagedValues).to.deep.equal(['no async api']);

      execCommand.restore();
      restoreClipboard();
    });

    it('does not hang when the async API never settles', async () => {
      // Headless browsers (and WebViews without clipboard-write permission)
      // leave writeText pending forever rather than rejecting. The call must
      // still resolve, via the fallback.
      const restoreClipboard = replaceClipboard({
        writeText: () => new Promise<void>(() => {}),
      });
      const execCommand = stubExecCommand(true);

      const result = await copyToClipboard('never settles');

      expect(result.success).to.be.true;
      expect(execCommand.stagedValues).to.deep.equal(['never settles']);

      execCommand.restore();
      restoreClipboard();
    });

    it('reports a clipboard error when both the async API and the fallback fail', async () => {
      const restoreClipboard = replaceClipboard({
        writeText: () => Promise.reject(new Error('Clipboard access denied')),
      });
      const execCommand = stubExecCommand(false);

      const result = await copyToClipboard('test');

      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('CLIPBOARD_ERROR');
      expect(result.error?.message).to.equal('Clipboard access denied');

      execCommand.restore();
      restoreClipboard();
    });

    it('leaves no staging element behind and restores focus', async () => {
      const focusTarget = document.createElement('button');
      document.body.appendChild(focusTarget);
      focusTarget.focus();

      const restoreClipboard = replaceClipboard(undefined);
      const execCommand = stubExecCommand(true);

      await copyToClipboard('tidy up');

      expect(document.querySelectorAll('textarea[aria-hidden="true"]').length).to.equal(0);
      expect(document.activeElement).to.equal(focusTarget);

      execCommand.restore();
      restoreClipboard();
      focusTarget.remove();
    });
  });

  describe('getCommitInfoForCopy', () => {
    it('invokes get_commit_info_for_copy for SHA format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'abc123def456789',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getCommitInfoForCopy('/test/repo', 'abc123', 'sha');

      expect(lastInvokedCommand).to.equal('get_commit_info_for_copy');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.oid).to.equal('abc123');
      expect(args.format).to.equal('sha');
      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('abc123def456789');
    });

    it('invokes get_commit_info_for_copy for short_sha format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'abc123d',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getCommitInfoForCopy('/test/repo', 'abc123def', 'short_sha');

      expect(lastInvokedCommand).to.equal('get_commit_info_for_copy');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('short_sha');
      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('abc123d');
    });

    it('invokes get_commit_info_for_copy for message format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'Initial commit\n\nThis is the first commit.',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getCommitInfoForCopy('/test/repo', 'abc123', 'message');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.contain('Initial commit');
    });

    it('invokes get_commit_info_for_copy for full format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'abc123d Initial commit',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getCommitInfoForCopy('/test/repo', 'abc123', 'full');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('abc123d Initial commit');
    });

    it('invokes get_commit_info_for_copy for patch format', async () => {
      const mockPatch = `commit abc123def
Author: Test User <test@example.com>
Date:   Mon Jan 1 00:00:00 2024 +0000

    Initial commit

 1 file changed, 1 insertion(+)

diff --git a/file.txt b/file.txt
new file mode 100644
--- /dev/null
+++ b/file.txt
@@ -0,0 +1 @@
+content`;
      const mockCopyResult: CopyResult = {
        success: true,
        text: mockPatch,
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getCommitInfoForCopy('/test/repo', 'abc123', 'patch');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.contain('commit abc123def');
      expect(result.data?.text).to.contain('Author:');
      expect(result.data?.text).to.contain('diff --git');
    });

    it('handles commit not found error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'COMMIT_NOT_FOUND', message: 'Commit not found' });

      const result = await getCommitInfoForCopy('/test/repo', 'nonexistent', 'sha');

      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('COMMIT_NOT_FOUND');
    });
  });

  describe('getFilePathForCopy', () => {
    it('invokes get_file_path_for_copy for relative format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'src/main.ts',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getFilePathForCopy('/test/repo', 'src/main.ts', 'relative');

      expect(lastInvokedCommand).to.equal('get_file_path_for_copy');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.filePath).to.equal('src/main.ts');
      expect(args.format).to.equal('relative');
      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('src/main.ts');
    });

    it('invokes get_file_path_for_copy for absolute format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: '/test/repo/src/main.ts',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getFilePathForCopy('/test/repo', 'src/main.ts', 'absolute');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('/test/repo/src/main.ts');
    });

    it('invokes get_file_path_for_copy for filename format', async () => {
      const mockCopyResult: CopyResult = {
        success: true,
        text: 'main.ts',
      };
      mockInvoke = () => Promise.resolve(mockCopyResult);

      const result = await getFilePathForCopy('/test/repo', 'src/components/main.ts', 'filename');

      expect(result.success).to.be.true;
      expect(result.data?.text).to.equal('main.ts');
    });

    it('handles invalid path error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'INVALID_PATH', message: 'Invalid path' });

      const result = await getFilePathForCopy('/nonexistent', 'file.txt', 'relative');

      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('INVALID_PATH');
    });
  });

  describe('copyCommitSha', () => {
    it('copies full SHA to clipboard', async () => {
      const fullSha = 'abc123def456789012345678901234567890abcd';
      mockInvoke = () => Promise.resolve({ success: true, text: fullSha });

      const result = await copyCommitSha('/test/repo', 'abc123');

      expect(result.success).to.be.true;
      expect(clipboardText).to.equal(fullSha);
    });

    it('copies short SHA to clipboard', async () => {
      const shortSha = 'abc123d';
      mockInvoke = () => Promise.resolve({ success: true, text: shortSha });

      const result = await copyCommitSha('/test/repo', 'abc123', true);

      // Verify short_sha format was requested
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('short_sha');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal(shortSha);
    });

    it('handles backend error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'COMMIT_NOT_FOUND', message: 'Commit not found' });

      const result = await copyCommitSha('/test/repo', 'nonexistent');

      expect(result.success).to.be.false;
    });
  });

  describe('copyCommitMessage', () => {
    it('copies commit message to clipboard', async () => {
      const message = 'Fix bug in authentication flow';
      mockInvoke = () => Promise.resolve({ success: true, text: message });

      const result = await copyCommitMessage('/test/repo', 'abc123');

      expect(lastInvokedCommand).to.equal('get_commit_info_for_copy');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('message');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal(message);
    });
  });

  describe('copyCommitPatch', () => {
    it('copies commit patch to clipboard', async () => {
      const patch = 'commit abc123\nAuthor: Test\n\ndiff --git...';
      mockInvoke = () => Promise.resolve({ success: true, text: patch });

      const result = await copyCommitPatch('/test/repo', 'abc123');

      expect(lastInvokedCommand).to.equal('get_commit_info_for_copy');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('patch');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal(patch);
    });
  });

  describe('copyFilePath', () => {
    it('copies relative file path by default', async () => {
      mockInvoke = () => Promise.resolve({ success: true, text: 'src/main.ts' });

      const result = await copyFilePath('/test/repo', 'src/main.ts');

      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('relative');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal('src/main.ts');
    });

    it('copies absolute file path', async () => {
      mockInvoke = () => Promise.resolve({ success: true, text: '/test/repo/src/main.ts' });

      const result = await copyFilePath('/test/repo', 'src/main.ts', 'absolute');

      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('absolute');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal('/test/repo/src/main.ts');
    });

    it('copies filename only', async () => {
      mockInvoke = () => Promise.resolve({ success: true, text: 'main.ts' });

      const result = await copyFilePath('/test/repo', 'src/components/main.ts', 'filename');

      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.format).to.equal('filename');
      expect(result.success).to.be.true;
      expect(clipboardText).to.equal('main.ts');
    });
  });
});
