import { expect } from '@open-wc/testing';

// Mock Tauri API
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
let lastInvokedCommand: string | null = null;
let lastInvokedArgs: unknown = null;
const invokeHistory: Array<{ command: string; args: unknown }> = [];

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    lastInvokedCommand = command;
    lastInvokedArgs = args;
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import {
  getDiff,
  getDiffWithOptions,
  getFileDiff,
  getCommitFiles,
  getCommitFileDiff,
  getCommitsStats,
} from '../git.service.ts';
import { clearAllCaches } from '../cache.service.ts';

describe('git.service - Diff operations', () => {
  beforeEach(() => {
    lastInvokedCommand = null;
    lastInvokedArgs = null;
    invokeHistory.length = 0;
    mockInvoke = () => Promise.resolve(null);
    clearAllCaches();
  });

  describe('getDiff', () => {
    it('invokes get_diff command without arguments', async () => {
      mockInvoke = () => Promise.resolve([]);

      const result = await getDiff();
      expect(lastInvokedCommand).to.equal('get_diff');
      expect(lastInvokedArgs).to.deep.equal({});
      expect(result.success).to.be.true;
    });

    it('invokes get_diff with path argument', async () => {
      const mockDiff = [
        {
          path: 'file.ts',
          oldPath: null,
          status: 'modified',
          hunks: [],
          isBinary: false,
          isImage: false,
          imageType: null,
          additions: 10,
          deletions: 5,
        },
      ];
      mockInvoke = () => Promise.resolve(mockDiff);

      const result = await getDiff({ path: '/test/repo' });
      expect(lastInvokedCommand).to.equal('get_diff');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data).to.deep.equal(mockDiff);
    });

    it('invokes get_diff with staged option', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiff({ path: '/test/repo', staged: true });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.staged).to.be.true;
    });

    it('invokes get_diff with commit reference', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiff({ path: '/test/repo', commit: 'abc123' });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.commit).to.equal('abc123');
    });

    it('invokes get_diff with compareWith option', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiff({ path: '/test/repo', commit: 'abc123', compareWith: 'def456' });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.commit).to.equal('abc123');
      expect(args.compareWith).to.equal('def456');
    });

    it('returns diff files with hunks', async () => {
      const mockDiffWithHunks = [
        {
          path: 'src/index.ts',
          oldPath: null,
          status: 'modified',
          hunks: [
            {
              header: '@@ -1,5 +1,7 @@',
              oldStart: 1,
              oldLines: 5,
              newStart: 1,
              newLines: 7,
              lines: [
                { type: 'context', content: 'import React from "react";' },
                { type: 'addition', content: 'import { useState } from "react";' },
              ],
            },
          ],
          isBinary: false,
          isImage: false,
          imageType: null,
          additions: 2,
          deletions: 0,
        },
      ];
      mockInvoke = () => Promise.resolve(mockDiffWithHunks);

      const result = await getDiff({ path: '/test/repo' });
      expect(result.success).to.be.true;
      expect(result.data?.[0].hunks.length).to.equal(1);
      expect(result.data?.[0].additions).to.equal(2);
    });

    it('handles errors gracefully', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REPOSITORY_NOT_FOUND', message: 'Repository not found' });

      const result = await getDiff({ path: '/invalid/repo' });
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('REPOSITORY_NOT_FOUND');
    });
  });

  describe('getFileDiff', () => {
    it('invokes get_file_diff with correct arguments', async () => {
      const mockFileDiff = {
        path: 'src/file.ts',
        oldPath: null,
        status: 'modified',
        hunks: [],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 5,
        deletions: 2,
      };
      mockInvoke = () => Promise.resolve(mockFileDiff);

      const result = await getFileDiff('/test/repo', 'src/file.ts');
      expect(lastInvokedCommand).to.equal('get_file_diff');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.filePath).to.equal('src/file.ts');
      expect(result.success).to.be.true;
    });

    it('invokes get_file_diff for unstaged changes', async () => {
      mockInvoke = () => Promise.resolve({ path: 'file.ts', hunks: [] });

      await getFileDiff('/test/repo', 'file.ts', false);
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.staged).to.be.false;
    });

    it('invokes get_file_diff for staged changes', async () => {
      mockInvoke = () => Promise.resolve({ path: 'file.ts', hunks: [] });

      await getFileDiff('/test/repo', 'file.ts', true);
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.staged).to.be.true;
    });

    it('forwards the render options in camelCase', async () => {
      mockInvoke = () => Promise.resolve({ path: 'file.ts', hunks: [] });

      await getFileDiff('/test/repo', 'file.ts', false, 100, {
        contextLines: 0,
        ignoreWhitespace: 'change',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.contextLines).to.equal(0);
      expect(args.ignoreWhitespace).to.equal('change');
      expect(args.maxLines).to.equal(100);
      expect(Object.keys(args)).to.not.include('ignore_whitespace');
      expect(Object.keys(args)).to.not.include('context_lines');
    });

    it('omits the render options when none are given', async () => {
      mockInvoke = () => Promise.resolve({ path: 'file.ts', hunks: [] });

      await getFileDiff('/test/repo', 'file.ts');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.contextLines).to.be.undefined;
      expect(args.ignoreWhitespace).to.be.undefined;
    });

    it('returns file diff with hunks', async () => {
      const mockFileDiff = {
        path: 'component.tsx',
        oldPath: null,
        status: 'modified',
        hunks: [
          {
            header: '@@ -10,3 +10,5 @@',
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 5,
            lines: [],
          },
        ],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 2,
        deletions: 0,
      };
      mockInvoke = () => Promise.resolve(mockFileDiff);

      const result = await getFileDiff('/test/repo', 'component.tsx');
      expect(result.success).to.be.true;
      expect(result.data?.path).to.equal('component.tsx');
      expect(result.data?.hunks.length).to.equal(1);
    });

    it('handles binary files', async () => {
      const mockBinaryDiff = {
        path: 'image.png',
        oldPath: null,
        status: 'modified',
        hunks: [],
        isBinary: true,
        isImage: true,
        imageType: 'png',
        additions: 0,
        deletions: 0,
      };
      mockInvoke = () => Promise.resolve(mockBinaryDiff);

      const result = await getFileDiff('/test/repo', 'image.png');
      expect(result.success).to.be.true;
      expect(result.data?.isBinary).to.be.true;
      expect(result.data?.isImage).to.be.true;
    });

    it('handles file not found error', async () => {
      mockInvoke = () => Promise.reject({ code: 'FILE_NOT_FOUND', message: 'File not found' });

      const result = await getFileDiff('/test/repo', 'nonexistent.ts');
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('FILE_NOT_FOUND');
    });
  });

  describe('getCommitFiles', () => {
    it('invokes get_commit_files with correct arguments', async () => {
      const mockFiles = [
        { path: 'file1.ts', status: 'modified', additions: 10, deletions: 5 },
        { path: 'file2.ts', status: 'new', additions: 20, deletions: 0 },
      ];
      mockInvoke = () => Promise.resolve(mockFiles);

      const result = await getCommitFiles('/test/repo', 'abc123');
      expect(lastInvokedCommand).to.equal('get_commit_files');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.commitOid).to.equal('abc123');
      expect(result.success).to.be.true;
      expect(result.data?.length).to.equal(2);
    });

    it('returns empty array for commit with no file changes', async () => {
      mockInvoke = () => Promise.resolve([]);

      const result = await getCommitFiles('/test/repo', 'emptycommit');
      expect(result.success).to.be.true;
      expect(result.data).to.deep.equal([]);
    });

    it('handles invalid commit OID', async () => {
      mockInvoke = () => Promise.reject({ code: 'COMMIT_NOT_FOUND', message: 'Commit not found' });

      const result = await getCommitFiles('/test/repo', 'invalidoid');
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('COMMIT_NOT_FOUND');
    });
  });

  describe('getCommitFileDiff', () => {
    it('invokes get_commit_file_diff with correct arguments', async () => {
      const mockDiff = {
        path: 'src/main.ts',
        oldPath: null,
        status: 'modified',
        hunks: [
          {
            header: '@@ -1,10 +1,15 @@',
            oldStart: 1,
            oldLines: 10,
            newStart: 1,
            newLines: 15,
            lines: [],
          },
        ],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 5,
        deletions: 0,
      };
      mockInvoke = () => Promise.resolve(mockDiff);

      const result = await getCommitFileDiff('/test/repo', 'abc123', 'src/main.ts');
      expect(lastInvokedCommand).to.equal('get_commit_file_diff');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.commitOid).to.equal('abc123');
      expect(args.filePath).to.equal('src/main.ts');
      expect(result.success).to.be.true;
    });

    it('forwards the render options in camelCase', async () => {
      mockInvoke = () => Promise.resolve({ path: 'src/main.ts', hunks: [] });

      await getCommitFileDiff('/test/repo', 'abc123', 'src/main.ts', undefined, {
        contextLines: 12,
        ignoreWhitespace: 'all',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.contextLines).to.equal(12);
      expect(args.ignoreWhitespace).to.equal('all');
      expect(Object.keys(args)).to.not.include('ignore_whitespace');
      expect(Object.keys(args)).to.not.include('context_lines');
    });

    it('returns file diff for specific commit', async () => {
      const mockDiff = {
        path: 'component.tsx',
        oldPath: 'old-component.tsx',
        status: 'renamed',
        hunks: [],
        isBinary: false,
        isImage: false,
        imageType: null,
        additions: 0,
        deletions: 0,
      };
      mockInvoke = () => Promise.resolve(mockDiff);

      const result = await getCommitFileDiff('/test/repo', 'def456', 'component.tsx');
      expect(result.success).to.be.true;
      expect(result.data?.status).to.equal('renamed');
      expect(result.data?.oldPath).to.equal('old-component.tsx');
    });

    it('handles file not in commit error', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'FILE_NOT_IN_COMMIT', message: 'File not in commit' });

      const result = await getCommitFileDiff('/test/repo', 'abc123', 'nonexistent.ts');
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('FILE_NOT_IN_COMMIT');
    });
  });

  describe('getCommitsStats', () => {
    it('invokes get_commits_stats with correct arguments', async () => {
      const mockStats = [
        { oid: 'abc123', additions: 50, deletions: 20 },
        { oid: 'def456', additions: 100, deletions: 30 },
      ];
      mockInvoke = () => Promise.resolve(mockStats);

      const result = await getCommitsStats('/test/repo', ['abc123', 'def456']);
      expect(lastInvokedCommand).to.equal('get_commits_stats');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.commitOids).to.deep.equal(['abc123', 'def456']);
      expect(result.success).to.be.true;
      expect(result.data?.length).to.equal(2);
    });

    it('returns stats for single commit', async () => {
      const mockStats = [{ oid: 'abc123', additions: 10, deletions: 5 }];
      mockInvoke = () => Promise.resolve(mockStats);

      const result = await getCommitsStats('/test/repo', ['abc123']);
      expect(result.success).to.be.true;
      expect(result.data?.[0].additions).to.equal(10);
      expect(result.data?.[0].deletions).to.equal(5);
    });

    it('returns empty array for empty commit list', async () => {
      mockInvoke = () => Promise.resolve([]);

      const result = await getCommitsStats('/test/repo', []);
      expect(result.success).to.be.true;
      expect(result.data).to.deep.equal([]);
    });

    it('handles errors for invalid commits', async () => {
      mockInvoke = () => Promise.reject({ code: 'COMMIT_NOT_FOUND', message: 'Commit not found' });

      const result = await getCommitsStats('/test/repo', ['invalidoid']);
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('COMMIT_NOT_FOUND');
    });
  });

  describe('getDiffWithOptions', () => {
    it('invokes get_diff_with_options with minimal options', async () => {
      mockInvoke = () => Promise.resolve([]);

      const result = await getDiffWithOptions({ path: '/test/repo' });
      expect(lastInvokedCommand).to.equal('get_diff_with_options');
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(result.success).to.be.true;
    });

    it('invokes get_diff_with_options with ignore whitespace all', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        ignoreWhitespace: 'all',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.ignoreWhitespace).to.equal('all');
    });

    it('invokes get_diff_with_options with ignore whitespace change', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        ignoreWhitespace: 'change',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.ignoreWhitespace).to.equal('change');
    });

    it('invokes get_diff_with_options with ignore whitespace eol', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        ignoreWhitespace: 'eol',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.ignoreWhitespace).to.equal('eol');
    });

    it('invokes get_diff_with_options with context lines', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        contextLines: 10,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.contextLines).to.equal(10);
    });

    it('invokes get_diff_with_options with patience algorithm', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        patience: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.patience).to.be.true;
    });

    it('invokes get_diff_with_options with histogram algorithm', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        histogram: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.histogram).to.be.true;
    });

    it('invokes get_diff_with_options with file path filter', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        filePath: 'src/index.ts',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.filePath).to.equal('src/index.ts');
    });

    it('invokes get_diff_with_options with staged flag', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        staged: true,
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.staged).to.be.true;
    });

    it('invokes get_diff_with_options with commit and compareWith', async () => {
      mockInvoke = () => Promise.resolve([]);

      await getDiffWithOptions({
        path: '/test/repo',
        commit: 'abc123',
        compareWith: 'def456',
      });
      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.commit).to.equal('abc123');
      expect(args.compareWith).to.equal('def456');
    });

    it('invokes get_diff_with_options with all options combined', async () => {
      const mockDiff = [
        {
          path: 'file.ts',
          oldPath: null,
          status: 'modified',
          hunks: [],
          isBinary: false,
          isImage: false,
          imageType: null,
          additions: 5,
          deletions: 2,
        },
      ];
      mockInvoke = () => Promise.resolve(mockDiff);

      const result = await getDiffWithOptions({
        path: '/test/repo',
        filePath: 'file.ts',
        staged: false,
        contextLines: 5,
        ignoreWhitespace: 'all',
        patience: true,
      });
      expect(result.success).to.be.true;
      expect(result.data?.[0].path).to.equal('file.ts');

      const args = lastInvokedArgs as Record<string, unknown>;
      expect(args.path).to.equal('/test/repo');
      expect(args.filePath).to.equal('file.ts');
      expect(args.staged).to.be.false;
      expect(args.contextLines).to.equal(5);
      expect(args.ignoreWhitespace).to.equal('all');
      expect(args.patience).to.be.true;
    });

    it('handles errors gracefully', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'REPOSITORY_NOT_FOUND', message: 'Repository not found' });

      const result = await getDiffWithOptions({ path: '/invalid/repo' });
      expect(result.success).to.be.false;
      expect(result.error?.code).to.equal('REPOSITORY_NOT_FOUND');
    });
  });
});
