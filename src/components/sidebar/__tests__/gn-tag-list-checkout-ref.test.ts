/**
 * Checking out a tag must check out the TAG.
 *
 * The backend resolvers try find_branch(ref_name, Local) first and only fall
 * back to revparse_single. Passing the bare tag name therefore checked out a
 * same-named BRANCH when one existed — routine with names like "release" or
 * "v2" — attaching HEAD at the branch tip, which can be a completely different
 * commit. The user had just confirmed a "detached HEAD" warning, and the app
 * reported success with no hint it had checked out something else.
 *
 * Passing refs/tags/<name> misses the find_branch lookups, so revparse_single
 * resolves the tag and HEAD detaches at the tagged commit — and it restores
 * git's own disambiguation, which prefers refs/tags/<name> over
 * refs/heads/<name>.
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

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-tag-list.ts';
import type { GnTagList } from '../gn-tag-list.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

function makeTag(name: string) {
  return {
    name,
    targetOid: 'abc123',
    message: null,
    tagger: null,
    isAnnotated: false,
  };
}

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_tags') return Promise.resolve([]);
  if (command === 'get_tag_sort_mode') return Promise.resolve('name');
  // The "detached HEAD" confirm goes through the Tauri dialog plugin, which
  // returns the clicked button label; 'Ok' means confirmed.
  if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
  if (command === 'checkout_with_autostash') {
    return Promise.resolve({
      success: true,
      stashed: false,
      stashApplied: false,
      stashConflict: false,
      stashOid: null,
      message: 'Switched',
    });
  }
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnTagList> {
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnTagList>(
    html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`,
  );
  await el.updateComplete;
  return el;
}

/** Drive the context-menu handler the way the other tag-list tests do. */
async function checkoutTag(el: GnTagList, name: string): Promise<void> {
  const tag = makeTag(name);
  (
    el as unknown as {
      contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null };
    }
  ).contextMenu = { visible: true, x: 0, y: 0, tag };
  await el.updateComplete;
  await (el as unknown as { handleCheckoutTag: () => Promise<void> }).handleCheckoutTag();
}

describe('gn-tag-list checkout targets the tag ref', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
  });

  it('passes a fully-qualified refs/tags/<name> to the backend', async () => {
    const el = await createComponent();
    await checkoutTag(el, 'v2');

    const call = invokeCalls.find((c) => c.command === 'checkout_with_autostash');
    expect(call, 'checkout should have been invoked').to.exist;

    const args = call!.args as Record<string, unknown>;
    const payload = (args?.args ?? args) as Record<string, unknown>;
    expect(
      payload.refName,
      'a bare name would resolve to a same-named branch instead of the tag',
    ).to.equal('refs/tags/v2');
  });

  it('qualifies names that collide with common branch names', async () => {
    const el = await createComponent();
    await checkoutTag(el, 'release');

    const call = invokeCalls.find((c) => c.command === 'checkout_with_autostash');
    const args = call!.args as Record<string, unknown>;
    const payload = (args?.args ?? args) as Record<string, unknown>;
    expect(payload.refName).to.equal('refs/tags/release');
  });

  // A tag name may carry its own slashes (`release/2.0`, `nightly/2026-01-01`).
  // Those are part of the name, so the prefix goes in front of the whole thing
  // rather than being spliced into it.
  it('qualifies a nested tag name in one piece', async () => {
    const el = await createComponent();
    await checkoutTag(el, 'release/2.0');

    const call = invokeCalls.find((c) => c.command === 'checkout_with_autostash');
    const args = call!.args as Record<string, unknown>;
    const payload = (args?.args ?? args) as Record<string, unknown>;
    expect(payload.refName).to.equal('refs/tags/release/2.0');
  });
});
