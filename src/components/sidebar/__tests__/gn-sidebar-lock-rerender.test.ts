/**
 * The sidebar lists must RE-RENDER when the shared working-tree lock changes.
 *
 * `isRefOpRunning` is plain module state Lit cannot observe. Three of these
 * components carried the whole machinery — a `refOpsVersion` state field, a
 * getter that reads it, an unsubscribe handle, teardown in
 * `disconnectedCallback` — but never called `subscribeRefOps`, so the counter
 * never moved. A context menu opened before an operation started stayed fully
 * enabled through it, and one opened during an operation stayed disabled after
 * it finished: a dead control with no explanation until the menu was reopened.
 *
 * Every assertion below is on RENDERED DOM, deliberately. The private
 * `operationInProgress` getter calls `isRefOpRunning` on every access, so it
 * reports the truth whether or not the component ever subscribed — a test that
 * reads the getter passes with the subscription deleted, which is exactly how
 * the first version of this file managed to guard nothing.
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
import '../gn-branch-list.ts';
import '../gn-tag-list.ts';
import '../gn-stash-list.ts';
import '../gn-gitflow-panel.ts';
import { tryAcquireRefOp, releaseRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

interface Updatable extends HTMLElement {
  updateComplete: Promise<unknown>;
}

function defaultMockInvoke(command: string): Promise<unknown> {
  switch (command) {
    case 'get_branches':
      return Promise.resolve([
        {
          name: 'feature/test',
          shorthand: 'feature/test',
          isHead: false,
          isRemote: false,
          upstream: null,
          targetOid: 'abc123',
          isStale: false,
        },
      ]);
    case 'get_tags':
      return Promise.resolve([
        {
          name: 'v1.0.0',
          targetOid: 'abc123',
          message: null,
          tagger: null,
          isAnnotated: false,
        },
      ]);
    case 'get_stashes':
      return Promise.resolve([{ index: 0, message: 'WIP on main', oid: 'abc123' }]);
    case 'get_remotes':
    case 'get_hidden_branches':
    case 'get_cleanup_candidates':
      return Promise.resolve([]);
    case 'get_branch_sort_mode':
    case 'get_tag_sort_mode':
      return Promise.resolve('name');
    case 'get_gitflow_config':
      // A repo where git flow is genuinely not initialized — that, not a
      // failed load, is what renders the Initialize button this test drives.
      return Promise.resolve({
        initialized: false,
        masterBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        supportPrefix: 'support/',
        versionTagPrefix: 'v',
      });
    default:
      return Promise.resolve(null);
  }
}

/** Wait for an async load to put `selector` in the shadow root. */
async function waitForRendered(el: Updatable, selector: string): Promise<Element> {
  for (let i = 0; i < 100; i++) {
    await el.updateComplete;
    const found = el.shadowRoot!.querySelector(selector);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${selector} never rendered`);
}

/** Right-click a row to open the context menu, as the user does. */
async function openContextMenu(el: Updatable, rowSelector: string): Promise<void> {
  const row = await waitForRendered(el, rowSelector);
  row.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true }),
  );
  await el.updateComplete;
}

/**
 * Assert `read()` tracks the lock across a claim taken by ANOTHER surface,
 * with no further gesture in between — no reopening the menu, no re-render
 * triggered by the test itself.
 */
async function expectTracksLock(
  el: Updatable,
  read: () => boolean,
  what: string,
): Promise<void> {
  expect(read(), `${what}: enabled while the repo is idle`).to.equal(false);

  tryAcquireRefOp(REPO_PATH);
  await el.updateComplete;
  expect(read(), `${what}: a claim from another surface must disable it`).to.equal(true);

  releaseRefOp(REPO_PATH);
  await el.updateComplete;
  expect(read(), `${what}: the release must revive it, or the control stays dead`).to.equal(
    false,
  );
}

describe('sidebar lists re-render on a working-tree lock transition', () => {
  beforeEach(() => {
    resetRefOpLocks();
    mockInvoke = defaultMockInvoke;
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  it('gn-branch-list stops branch rows being draggable', async () => {
    const el = await fixture<Updatable>(
      html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`,
    );
    await el.updateComplete;

    const row = await waitForRendered(el, 'li.branch-item');

    await expectTracksLock(
      el,
      () => row.getAttribute('draggable') === 'false',
      'branch row draggable',
    );
  });

  it('gn-tag-list disables an already-open context menu', async () => {
    const el = await fixture<Updatable>(
      html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`,
    );
    await el.updateComplete;
    await openContextMenu(el, 'li.tag-item');

    const del = (await waitForRendered(el, '.context-menu-item.danger')) as HTMLButtonElement;

    await expectTracksLock(el, () => del.disabled, 'tag Delete');
  });

  it('gn-stash-list disables an already-open context menu', async () => {
    const el = await fixture<Updatable>(
      html`<gn-stash-list .repositoryPath=${REPO_PATH}></gn-stash-list>`,
    );
    await el.updateComplete;
    await openContextMenu(el, 'li.stash-item');

    const drop = (await waitForRendered(el, '.context-menu-item.danger')) as HTMLButtonElement;

    await expectTracksLock(el, () => drop.disabled, 'stash Drop');
  });

  it('gn-gitflow-panel disables Initialize Git Flow', async () => {
    const el = await fixture<Updatable>(
      html`<gn-gitflow-panel .repositoryPath=${REPO_PATH}></gn-gitflow-panel>`,
    );
    await el.updateComplete;

    const btn = (await waitForRendered(el, '.init-section button')) as HTMLButtonElement;

    await expectTracksLock(el, () => btn.disabled, 'Initialize Git Flow');
  });
});
