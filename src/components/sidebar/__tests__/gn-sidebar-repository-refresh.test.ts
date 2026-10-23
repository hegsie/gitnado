/**
 * Sidebar components must reload when the app-level `repository-refresh`
 * window event fires: conflicted gitflow finishes and stash applies/pops
 * complete inside the shared conflict dialog, so the owning sidebar list
 * never sees the completion — without this subscription it shows stale
 * state (finished feature still "active", dropped stash still listed).
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-stash-list.ts';
import '../gn-tag-list.ts';
import '../gn-gitflow-panel.ts';

const REPO_PATH = '/test/repo';

function countCalls(command: string): number {
  return invokeCalls.filter((c) => c.command === command).length;
}

async function fireRefreshAndSettle(): Promise<void> {
  window.dispatchEvent(new CustomEvent('repository-refresh'));
  // Let the async load handlers run
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('sidebar repository-refresh subscriptions', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    mockInvoke = async (command: string) => {
      switch (command) {
        case 'get_stashes':
          return [];
        case 'get_tags':
          return [];
        case 'get_gitflow_config':
          return {
            initialized: false,
            masterBranch: 'main',
            developBranch: 'develop',
            featurePrefix: 'feature/',
            releasePrefix: 'release/',
            hotfixPrefix: 'hotfix/',
            supportPrefix: 'support/',
            versionTagPrefix: 'v',
          };
        default:
          return null;
      }
    };
  });

  it('gn-stash-list reloads stashes on repository-refresh', async () => {
    const el = await fixture(
      html`<gn-stash-list .repositoryPath=${REPO_PATH}></gn-stash-list>`,
    );
    const before = countCalls('get_stashes');

    await fireRefreshAndSettle();
    expect(countCalls('get_stashes')).to.be.greaterThan(before);

    // Unsubscribes on disconnect
    el.remove();
    const after = countCalls('get_stashes');
    await fireRefreshAndSettle();
    expect(countCalls('get_stashes')).to.equal(after);
  });

  it('gn-tag-list reloads tags on repository-refresh', async () => {
    const el = await fixture(
      html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`,
    );
    const before = countCalls('get_tags');

    await fireRefreshAndSettle();
    expect(countCalls('get_tags')).to.be.greaterThan(before);

    el.remove();
    const after = countCalls('get_tags');
    await fireRefreshAndSettle();
    expect(countCalls('get_tags')).to.equal(after);
  });

  it('gn-gitflow-panel reloads config/actives on repository-refresh', async () => {
    const el = await fixture(
      html`<gn-gitflow-panel .repositoryPath=${REPO_PATH}></gn-gitflow-panel>`,
    );
    const before = countCalls('get_gitflow_config');

    await fireRefreshAndSettle();
    expect(countCalls('get_gitflow_config')).to.be.greaterThan(before);

    el.remove();
    const after = countCalls('get_gitflow_config');
    await fireRefreshAndSettle();
    expect(countCalls('get_gitflow_config')).to.equal(after);
  });
});
