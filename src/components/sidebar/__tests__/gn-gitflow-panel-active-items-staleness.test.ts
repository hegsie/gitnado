/**
 * gn-gitflow-panel: a failed branch listing must not leave the PREVIOUS repo's
 * active items on screen.
 *
 * loadActiveItems collapsed three conditions into one early return — a stale
 * response, an unsuccessful listing, and an empty payload — and its catch only
 * wrote to the console. Only the stale case is a reason to leave state alone.
 * On a repo switch A→B where B's config loads but its branch listing fails, the
 * panel kept repo A's feature/release/hotfix rows under repo B's config, with
 * no error shown.
 *
 * The rows ARE the operands: each Finish button closes over its ActiveItem and
 * passes item.name to gitFlowFinishFeature(this.repositoryPath, ...) — repo B.
 * With a colliding name (feature/login is routine) that merges and deletes the
 * WRONG repo's branch.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnGitflowPanel } from '../gn-gitflow-panel.ts';
import '../gn-gitflow-panel.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_A = '/repo/a';
const REPO_B = '/repo/b';

const CONFIG = {
  initialized: true,
  masterBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  supportPrefix: 'support/',
  versionTagPrefix: '',
};

function branch(name: string) {
  return {
    name,
    shorthand: name,
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: `oid-${name}`,
    isStale: false,
  };
}

/** Per-path `get_branches` behaviour, swapped between binds by each test. */
let branchHandlers = new Map<string, () => Promise<unknown>>();
/** Extra command handlers (e.g. gitflow_finish_feature) for a single test. */
let commandHandlers = new Map<string, () => Promise<unknown>>();

function installMock(): void {
  branchHandlers = new Map();
  commandHandlers = new Map();
  mockInvoke = (command, args) => {
    const extra = commandHandlers.get(command);
    if (extra) return extra();
    if (command === 'get_gitflow_config') return Promise.resolve({ ...CONFIG });
    if (command === 'get_branches') {
      const path = String((args as { path?: string })?.path ?? '');
      const handler = branchHandlers.get(path);
      return handler ? handler() : Promise.resolve([]);
    }
    if (command === 'plugin:dialog|message' || command === 'plugin:dialog|confirm') {
      return Promise.resolve('Ok');
    }
    return Promise.resolve(null);
  };
}

/** Settle the element after loads that Lit does not await. */
async function flush(el: GnGitflowPanel): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 20));
  await el.updateComplete;
}

function itemNames(el: GnGitflowPanel): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.item .item-name')).map((n) =>
    (n.textContent ?? '').trim(),
  );
}

function bannerText(el: GnGitflowPanel): string | null {
  const banner = el.shadowRoot!.querySelector('.error-banner-message');
  return banner ? (banner.textContent ?? '').trim() : null;
}

/** Mount bound to repo A showing a single active feature, `feature/login`. */
async function mountWithLogin(): Promise<GnGitflowPanel> {
  installMock();
  branchHandlers.set(REPO_A, () => Promise.resolve([branch('feature/login')]));
  const el = await fixture<GnGitflowPanel>(
    html`<gn-gitflow-panel .repositoryPath=${REPO_A}></gn-gitflow-panel>`,
  );
  await flush(el);
  expect(itemNames(el), 'repo A renders its active feature').to.deep.equal(['login']);
  return el;
}

async function switchTo(el: GnGitflowPanel, path: string): Promise<void> {
  el.repositoryPath = path;
  await flush(el);
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-gitflow-panel active-item staleness on a failed branch listing', () => {
  it("clears the previous repo's items when the branch listing fails", async () => {
    const el = await mountWithLogin();

    // Repo B's config loads fine; only its branch listing fails.
    branchHandlers.set(REPO_B, () =>
      Promise.reject({ code: 'COMMAND_ERROR', message: 'could not open repository' }),
    );
    await switchTo(el, REPO_B);

    expect(
      itemNames(el),
      "repo A's items must not be listed under repo B — Finish binds to them",
    ).to.deep.equal([]);
    expect(bannerText(el), 'the failure must be reported').to.contain(
      'could not open repository',
    );
  });

  it('clears the items when the branch listing returns no data', async () => {
    const el = await mountWithLogin();

    // success === true but data === null: no listing, so nothing is known.
    branchHandlers.set(REPO_B, () => Promise.resolve(null));
    await switchTo(el, REPO_B);

    expect(itemNames(el)).to.deep.equal([]);
    expect(bannerText(el)).to.equal('Failed to load Git Flow branches');
  });

  it('clears the items when the branch listing payload is malformed', async () => {
    const el = await mountWithLogin();

    // Not an array — `.filter` throws, landing in loadActiveItems' catch.
    branchHandlers.set(REPO_B, () => Promise.resolve({}));
    await switchTo(el, REPO_B);

    expect(itemNames(el)).to.deep.equal([]);
    expect(bannerText(el)).to.equal('Failed to load Git Flow branches');
  });

  it("keeps the current repo's items when a previous repo's failed listing lands late", async () => {
    // Regression fence for the staleness guard: the clear/report must stay
    // behind `latest()`. A fix that clears unconditionally would wipe repo A's
    // rows and raise a banner about repo B, which is no longer displayed.
    const el = await mountWithLogin();

    let failB: ((err: unknown) => void) | null = null;
    branchHandlers.set(REPO_B, () => new Promise((_resolve, reject) => { failB = reject; }));

    await switchTo(el, REPO_B);
    expect(failB, "repo B's listing is in flight").to.not.be.null;

    // Back to A before B ever answers.
    await switchTo(el, REPO_A);
    expect(itemNames(el)).to.deep.equal(['login']);

    // B's listing now fails — for a repo the user already navigated away from.
    failB!({ code: 'COMMAND_ERROR', message: 'could not open repository' });
    await flush(el);

    expect(itemNames(el), "repo A's items survive a stale failure").to.deep.equal(['login']);
    expect(
      el.shadowRoot!.querySelector('.error-banner'),
      'no banner about a repo that is not shown',
    ).to.be.null;
  });

  it('keeps the items and shows no error when the listing succeeds', async () => {
    const el = await mountWithLogin();

    branchHandlers.set(REPO_B, () => Promise.resolve([branch('feature/deploy')]));
    await switchTo(el, REPO_B);

    expect(itemNames(el)).to.deep.equal(['deploy']);
    expect(el.shadowRoot!.querySelector('.error-banner')).to.be.null;
  });

  it('drops the finished feature and reports the failure when the post-finish reload fails', async () => {
    const el = await mountWithLogin();

    commandHandlers.set('gitflow_finish_feature', () => Promise.resolve(null));
    // The finish lands, but the reload that should remove the row does not.
    branchHandlers.set(REPO_A, () =>
      Promise.reject({ code: 'COMMAND_ERROR', message: 'index has conflicts' }),
    );

    const finishBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      '.item-finish-btn:not(.item-squash-btn)',
    );
    expect(finishBtn, 'finish button rendered').to.exist;
    finishBtn!.click();
    await flush(el);

    expect(
      itemNames(el),
      'a finished feature must not stay listed with a live Finish button',
    ).to.deep.equal([]);
    expect(bannerText(el)).to.contain('index has conflicts');
  });
});
