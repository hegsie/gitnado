/**
 * Tests for gn-gitflow-panel config-load failure handling.
 *
 * `invokeCommand` turns every backend rejection into `success === false`, so a
 * failed `get_gitflow_config` used to null the config and render the
 * "Git Flow is not initialized" prompt — offering an Initialize button that
 * rewrites an already-initialized repo's gitflow config with the defaults.
 * A failed load must be reported as a failure, and must never carry another
 * repo's active items across.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnGitflowPanel } from '../gn-gitflow-panel.ts';
import '../gn-gitflow-panel.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_A = '/test/repo-a';

function initializedConfig(): Record<string, unknown> {
  return {
    initialized: true,
    masterBranch: 'main',
    developBranch: 'develop',
    featurePrefix: 'feature/',
    releasePrefix: 'release/',
    hotfixPrefix: 'hotfix/',
    supportPrefix: 'support/',
    versionTagPrefix: 'v',
  };
}

function featureBranch(name: string): Record<string, unknown> {
  return {
    name,
    shorthand: name,
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: 'a1',
    isStale: false,
  };
}

/** Flush the component's async config load. */
async function flush(el: GnGitflowPanel): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 20));
  await el.updateComplete;
}

async function createPanel(path: string): Promise<GnGitflowPanel> {
  const el = await fixture<GnGitflowPanel>(
    html`<gn-gitflow-panel .repositoryPath=${path}></gn-gitflow-panel>`
  );
  await flush(el);
  return el;
}

describe('gn-gitflow-panel config load failure', () => {
  afterEach(() => {
    mockInvoke = () => Promise.resolve(null);
  });

  it('shows the error instead of the init section when the config load fails', async () => {
    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') {
        return Promise.reject(new Error('failed to open repository'));
      }
      if (command === 'get_branches') return Promise.resolve([]);
      return Promise.resolve(null);
    };

    const el = await createPanel(REPO_A);

    // The Initialize button would overwrite the repo's gitflow config.
    expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(0);
    expect(el.shadowRoot!.querySelector('.load-error-message')?.textContent ?? '').to.contain(
      'failed to open repository'
    );
  });

  it('keeps the initialized panel and surfaces the error when a reload fails', async () => {
    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') return Promise.resolve(initializedConfig());
      if (command === 'get_branches') return Promise.resolve([featureBranch('feature/x')]);
      return Promise.resolve(null);
    };

    const el = await createPanel(REPO_A);
    expect(el.shadowRoot!.querySelector('.item-name')?.textContent ?? '').to.contain('x');

    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') {
        return Promise.reject(new Error('index.lock exists'));
      }
      if (command === 'get_branches') return Promise.resolve([featureBranch('feature/x')]);
      return Promise.resolve(null);
    };
    await el.refresh();
    await flush(el);

    expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(0);
    expect(el.shadowRoot!.querySelector('.error-banner-message')?.textContent ?? '').to.contain(
      'index.lock'
    );
    // The panel itself survives a transient failure.
    expect(el.shadowRoot!.querySelector('.item-name')?.textContent ?? '').to.contain('x');
  });

  it('never shows the previous repo items when a new repo fails to load', async () => {
    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') return Promise.resolve(initializedConfig());
      if (command === 'get_branches') return Promise.resolve([featureBranch('feature/x')]);
      return Promise.resolve(null);
    };

    const el = await createPanel(REPO_A);
    expect(el.shadowRoot!.querySelector('.item-name')?.textContent ?? '').to.contain('x');

    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') {
        return Promise.reject(new Error('failed to open repository'));
      }
      if (command === 'get_branches') return Promise.resolve([]);
      return Promise.resolve(null);
    };
    el.repositoryPath = '/test/repo-b';
    await flush(el);

    expect(el.shadowRoot!.querySelectorAll('.load-error-message').length).to.equal(1);
    expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(0);
    // Repo A's Finish buttons run against `repositoryPath` — showing them
    // under repo B would finish a branch in the wrong repository.
    expect(el.shadowRoot!.querySelectorAll('.item-name').length).to.equal(0);
    expect(el.shadowRoot!.querySelectorAll('.section').length).to.equal(0);
  });

  // Regression guard for the untouched happy path: passes before and after the fix.
  it('still shows the init section for a genuinely uninitialized repo', async () => {
    mockInvoke = (command) => {
      if (command === 'get_gitflow_config') {
        return Promise.resolve({ ...initializedConfig(), initialized: false });
      }
      if (command === 'get_branches') return Promise.resolve([]);
      return Promise.resolve(null);
    };

    const el = await createPanel(REPO_A);

    expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(1);
    expect(el.shadowRoot!.querySelector('.init-description')?.textContent ?? '').to.contain(
      'not initialized'
    );
    expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(0);
  });
});
