/**
 * Tests for the welcome screen's workspace-open flow: batch open without
 * per-repo activation, and user-visible feedback when repos fail to open.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    try {
      return Promise.resolve(handler ? handler(args || {}) : null);
    } catch (err) {
      return Promise.reject(err);
    }
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import '../gn-welcome.ts';
import { repositoryStore, uiStore } from '../../../stores/index.ts';

function mockRepoPayload(path: string) {
  return {
    path,
    name: path.split('/').pop(),
    isValid: true,
    isBare: false,
    headRef: 'main',
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

function makeWorkspace(paths: string[]) {
  return {
    id: 'ws-1',
    name: 'client-a',
    repositories: paths.map((path) => ({ path, name: path.split('/').pop() ?? path })),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('gn-welcome workspace open', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  it('opens every repo, activates the last one, and toasts success', async () => {
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);
    const el = document.createElement('gn-welcome') as HTMLElement;

    await (el as any).handleWorkspaceClick(makeWorkspace(['/ws/one', '/ws/two', '/ws/three']));

    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(3);
    expect(state.openRepositories[state.activeIndex].repository.path).to.equal('/ws/three');

    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('success');
  });

  it('reports partially failed workspace opens instead of toasting plain success', async () => {
    mockResponses['open_repository'] = (args) => {
      if (args.path === '/ws/gone') {
        throw new Error('repository not found');
      }
      return mockRepoPayload(args.path as string);
    };
    const el = document.createElement('gn-welcome') as HTMLElement;

    await (el as any).handleWorkspaceClick(makeWorkspace(['/ws/one', '/ws/gone']));

    expect(repositoryStore.getState().openRepositories.length).to.equal(1);
    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('warning');
    expect(toasts[0].message).to.contain('1 of 2');
  });

  it('toasts an error when NO repository in the workspace could be opened', async () => {
    mockResponses['open_repository'] = () => {
      throw new Error('repository not found');
    };
    const el = document.createElement('gn-welcome') as HTMLElement;

    await (el as any).handleWorkspaceClick(makeWorkspace(['/ws/gone-1', '/ws/gone-2']));

    expect(repositoryStore.getState().openRepositories.length).to.equal(0);
    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('error');
  });
});
