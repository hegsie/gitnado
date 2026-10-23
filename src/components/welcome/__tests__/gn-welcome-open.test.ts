/**
 * Tests for the welcome screen's single-repository open flow: a repository
 * that can no longer be opened (moved, deleted) must tell the user, since
 * repositoryStore.error is never rendered anywhere.
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
import { expect, fixture, html } from '@open-wc/testing';
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

/** Polls until `predicate` holds, so async work started by Lit can settle. */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('gn-welcome repository open', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  it('toasts when the repository cannot be opened', async () => {
    mockResponses['open_repository'] = () => {
      throw new Error('failed to open repository: /gone');
    };
    const el = document.createElement('gn-welcome') as HTMLElement;

    await (el as any).openRepoByPath('/gone');

    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('error');
    expect(toasts[0].message).to.contain('failed to open repository');

    // The store write is retained alongside the toast
    expect(repositoryStore.getState().error).to.not.equal(null);
    expect(repositoryStore.getState().openRepositories.length).to.equal(0);
  });

  it('toasts when the open throws after the command succeeds', async () => {
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);
    const el = document.createElement('gn-welcome') as HTMLElement;

    // reset() restores data fields only, so this stub would leak into later
    // tests — restore it explicitly.
    const originalAdd = repositoryStore.getState().addRepository;
    repositoryStore.setState({
      addRepository: () => {
        throw new Error('store rejected the repository');
      },
    } as any);
    try {
      await (el as any).openRepoByPath('/ws/one');
    } finally {
      repositoryStore.setState({ addRepository: originalAdd } as any);
    }

    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('error');
    expect(toasts[0].message).to.equal('store rejected the repository');
    expect(repositoryStore.getState().isLoading).to.equal(false);
  });

  it('opens the repository without an error toast on success', async () => {
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);
    const el = document.createElement('gn-welcome') as HTMLElement;

    await (el as any).openRepoByPath('/ws/one');

    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(1);
    expect(state.openRepositories[0].repository.path).to.equal('/ws/one');
    expect(uiStore.getState().toasts.filter((t) => t.type === 'error').length).to.equal(0);
  });

  it('surfaces the failure when a recent repository is clicked', async () => {
    repositoryStore.setState({
      recentRepositories: [{ path: '/gone', name: 'gone', lastOpened: Date.now() }],
    } as any);
    mockResponses['open_repository'] = () => {
      throw new Error('failed to open repository: /gone');
    };

    const el = await fixture<any>(html`<gn-welcome></gn-welcome>`);
    await el.updateComplete;

    const item = el.shadowRoot!.querySelector('.recent-item') as HTMLButtonElement;
    item.click();

    await waitUntil(() => uiStore.getState().toasts.length > 0, 'the failed recent-open toast');

    const toasts = uiStore.getState().toasts;
    expect(toasts[0].type).to.equal('error');
    expect(toasts[0].message).to.contain('/gone');
    expect(repositoryStore.getState().isLoading).to.equal(false);
  });
});
