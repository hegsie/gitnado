import { expect } from '@open-wc/testing';

// Track invoke calls
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  invokeCalls.push({ command, args: (args || {}) as Record<string, unknown> });
  switch (command) {
    case 'get_merge_tool_config':
      return { toolName: 'kdiff3', toolCmd: null };
    case 'get_diff_tool':
      return { tool: 'meld', cmd: null, prompt: false };
    case 'get_available_merge_tools':
      return [
        { name: 'kdiff3', displayName: 'KDiff3' },
        { name: 'meld', displayName: 'Meld' },
        { name: 'vscode', displayName: 'Visual Studio Code' },
      ];
    case 'list_diff_tools':
      return [
        { name: 'meld', command: 'meld', available: true },
        { name: 'kdiff3', command: 'kdiff3', available: false },
      ];
    case 'set_merge_tool_config':
    case 'set_diff_tool':
      return null;
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => 0,
  convertFileSrc: (path: string) => path,
};

import * as gitService from '../../services/git.service.ts';

describe('Settings - External Tools', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  describe('getMergeToolConfig', () => {
    it('returns the configured merge tool', async () => {
      const result = await gitService.getMergeToolConfig('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data?.toolName).to.equal('kdiff3');
    });
  });

  describe('getAvailableMergeTools', () => {
    it('returns list of known merge tools', async () => {
      const result = await gitService.getAvailableMergeTools();
      expect(result.success).to.be.true;
      expect(result.data).to.have.length(3);
      expect(result.data?.[0].name).to.equal('kdiff3');
      expect(result.data?.[0].displayName).to.equal('KDiff3');
    });
  });

  describe('setMergeToolConfig', () => {
    it('calls set_merge_tool_config with correct parameters', async () => {
      await gitService.setMergeToolConfig('/test/repo', 'meld');
      const call = invokeCalls.find(c => c.command === 'set_merge_tool_config');
      expect(call).to.exist;
      expect(call!.args.path).to.equal('/test/repo');
      expect(call!.args.toolName).to.equal('meld');
    });

    it('passes custom command when provided', async () => {
      await gitService.setMergeToolConfig('/test/repo', 'custom', '/usr/bin/my-merge');
      const call = invokeCalls.find(c => c.command === 'set_merge_tool_config');
      expect(call!.args.toolCmd).to.equal('/usr/bin/my-merge');
    });
  });

  describe('getDiffToolConfig', () => {
    it('returns the configured diff tool', async () => {
      const result = await gitService.getDiffToolConfig('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data?.tool).to.equal('meld');
    });
  });

  describe('listDiffTools', () => {
    it('returns diff tools with availability status', async () => {
      const result = await gitService.listDiffTools('/test/repo');
      expect(result.success).to.be.true;
      expect(result.data).to.have.length(2);
      expect(result.data?.[0].available).to.be.true;
      expect(result.data?.[1].available).to.be.false;
    });
  });

  describe('setDiffTool', () => {
    it('calls set_diff_tool with correct parameters', async () => {
      await gitService.setDiffTool('/test/repo', 'meld');
      const call = invokeCalls.find(c => c.command === 'set_diff_tool');
      expect(call).to.exist;
      expect(call!.args.path).to.equal('/test/repo');
      expect(call!.args.tool).to.equal('meld');
    });
  });
});
