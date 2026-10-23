/**
 * Load-staleness guards for gn-stash-list and gn-tag-list.
 *
 * gn-left-panel keeps ONE instance of each of these across tabs and only
 * rebinds `.repositoryPath`; Lit does not await an async `updated()`. So
 * Ctrl+Tab twice quickly (A→B→A) starts overlapping loads with nothing
 * sequencing them, and whichever resolved last won — repo B's rows rendering
 * under repo A's tab.
 *
 * That is not cosmetic. The rows ARE the operands: handleDeleteTag /
 * handleCheckoutTag pass the clicked row's `tag.name` straight to the ACTIVE
 * repo, and names like `v1.0.0` collide across repositories routinely.
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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { GnStashList } from '../gn-stash-list.ts';
import type { GnTagList } from '../gn-tag-list.ts';
import '../gn-stash-list.ts';
import '../gn-tag-list.ts';

/** A queued load, resolvable out of order to reproduce the overlap. */
interface Pending {
  path: string;
  resolve: (rows: unknown[]) => void;
  reject: (err: unknown) => void;
}

let pending: Pending[] = [];

/** Settle every queued load for `path` (a repo bind can start more than one). */
function settle(path: string, rows: unknown[]): number {
  const mine = pending.filter((p) => p.path === path);
  pending = pending.filter((p) => p.path !== path);
  for (const p of mine) p.resolve(rows);
  return mine.length;
}

function failAll(path: string, message: string): number {
  const mine = pending.filter((p) => p.path === path);
  pending = pending.filter((p) => p.path !== path);
  for (const p of mine) p.reject({ code: 'COMMAND_ERROR', message });
  return mine.length;
}

function installMock(loadCommand: string): void {
  mockInvoke = (command, args) => {
    if (command === loadCommand) {
      return new Promise<unknown>((resolve, reject) => {
        pending.push({
          path: String((args as { path?: string })?.path ?? ''),
          resolve: resolve as (rows: unknown[]) => void,
          reject,
        });
      });
    }
    if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
      return Promise.resolve('Cancel');
    }
    return Promise.resolve(null);
  };
}

function makeTag(name: string, targetOid: string) {
  return { name, targetOid, message: null, tagger: null, isAnnotated: false };
}

function makeStash(index: number, message: string) {
  return { index, message, oid: `oid-${index}-${message}`, branch: 'main', timestamp: 0 };
}

/** Wait for the element to settle after an un-awaited async load. */
async function flush(el: HTMLElement & { updateComplete: Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
  await el.updateComplete;
}

function texts(el: HTMLElement, selector: string): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll(selector)).map((n) =>
    (n.textContent ?? '').trim()
  );
}

describe('gn-tag-list load staleness', () => {
  beforeEach(() => {
    pending = [];
    installMock('get_tags');
  });

  it('a superseded load never overwrites the tab the user is now looking at', async () => {
    const counts: number[] = [];
    const el = await fixture<GnTagList>(
      html`<gn-tag-list
        .repositoryPath=${'/repo/a'}
        @tag-count-changed=${(e: CustomEvent<{ count: number }>) => counts.push(e.detail.count)}
      ></gn-tag-list>`
    );
    expect(pending.length, 'repo A load is in flight').to.be.greaterThan(0);

    // Ctrl+Tab to B while A's load is still out.
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    // B resolves first...
    expect(settle('/repo/b', [makeTag('v9.9.9', 'bbb')]), 'B load queued').to.be.greaterThan(0);
    await flush(el);
    expect(texts(el, '.tag-name')).to.deep.equal(['v9.9.9']);

    // ...then A's stale load lands. It must change nothing.
    settle('/repo/a', [makeTag('v1.0.0', 'aaa'), makeTag('v2.0.0', 'aaa2')]);
    await flush(el);

    expect(
      texts(el, '.tag-name'),
      "repo A's late result must not render under repo B's tab",
    ).to.deep.equal(['v9.9.9']);
    expect(
      counts[counts.length - 1],
      `the count badge must not follow the stale load: ${JSON.stringify(counts)}`,
    ).to.equal(1);
    expect(counts, 'the stale load emits no count at all').to.not.include(2);
  });

  it('a failed load clears the rows instead of leaving the previous repo\'s tags on screen', async () => {
    const counts: number[] = [];
    const el = await fixture<GnTagList>(
      html`<gn-tag-list
        .repositoryPath=${'/repo/a'}
        @tag-count-changed=${(e: CustomEvent<{ count: number }>) => counts.push(e.detail.count)}
      ></gn-tag-list>`
    );
    settle('/repo/a', [makeTag('v1.0.0', 'aaa')]);
    await flush(el);
    expect(texts(el, '.tag-name')).to.deep.equal(['v1.0.0']);

    el.repositoryPath = '/repo/b';
    await el.updateComplete;
    failAll('/repo/b', 'repository is locked');
    await flush(el);

    expect(
      texts(el, '.tag-name'),
      "repo A's tags must not stand in for repo B's — v1.0.0 exists in both and deletes the wrong commit",
    ).to.deep.equal([]);
    const error = el.shadowRoot!.querySelector('.error');
    expect(error, 'the failure is rendered, not silent').to.exist;
    expect(error!.textContent).to.contain('repository is locked');
    expect(counts[counts.length - 1], 'the badge drops to zero too').to.equal(0);
  });

  it('recovers on the next successful load', async () => {
    const el = await fixture<GnTagList>(
      html`<gn-tag-list .repositoryPath=${'/repo/a'}></gn-tag-list>`
    );
    failAll('/repo/a', 'boom');
    await flush(el);
    expect(el.shadowRoot!.querySelector('.error'), 'error shown').to.exist;

    // Not awaited: refresh() awaits the load, which this test settles below.
    void el.refresh();
    await el.updateComplete;
    settle('/repo/a', [makeTag('v3.0.0', 'ccc')]);
    await flush(el);

    expect(el.shadowRoot!.querySelector('.error'), 'error cleared').to.not.exist;
    expect(texts(el, '.tag-name')).to.deep.equal(['v3.0.0']);
  });
});

describe('gn-stash-list load staleness', () => {
  beforeEach(() => {
    pending = [];
    installMock('get_stashes');
  });

  it('a superseded load never overwrites the tab the user is now looking at', async () => {
    const counts: number[] = [];
    const el = await fixture<GnStashList>(
      html`<gn-stash-list
        .repositoryPath=${'/repo/a'}
        @stash-count-changed=${(e: CustomEvent<{ count: number }>) => counts.push(e.detail.count)}
      ></gn-stash-list>`
    );
    expect(pending.length, 'repo A load is in flight').to.be.greaterThan(0);

    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    settle('/repo/b', [makeStash(0, 'B work')]);
    await flush(el);
    expect(texts(el, '.stash-message')).to.deep.equal(['B work']);

    settle('/repo/a', [makeStash(0, 'A work'), makeStash(1, 'A more')]);
    await flush(el);

    expect(
      texts(el, '.stash-message'),
      "repo A's late result must not render under repo B's tab",
    ).to.deep.equal(['B work']);
    expect(
      counts[counts.length - 1],
      `the count badge must not follow the stale load: ${JSON.stringify(counts)}`,
    ).to.equal(1);
    expect(counts, 'the stale load emits no count at all').to.not.include(2);
  });

  it('a failed load clears the rows instead of leaving the previous repo\'s stashes on screen', async () => {
    const counts: number[] = [];
    const el = await fixture<GnStashList>(
      html`<gn-stash-list
        .repositoryPath=${'/repo/a'}
        @stash-count-changed=${(e: CustomEvent<{ count: number }>) => counts.push(e.detail.count)}
      ></gn-stash-list>`
    );
    settle('/repo/a', [makeStash(0, 'A work')]);
    await flush(el);
    expect(texts(el, '.stash-message')).to.deep.equal(['A work']);

    el.repositoryPath = '/repo/b';
    await el.updateComplete;
    failAll('/repo/b', 'index.lock exists');
    await flush(el);

    expect(
      texts(el, '.stash-message'),
      "repo A's stashes must not stand in for repo B's",
    ).to.deep.equal([]);
    const error = el.shadowRoot!.querySelector('.error');
    expect(error, 'the failure is rendered, not silent').to.exist;
    expect(error!.textContent).to.contain('index.lock exists');
    expect(counts[counts.length - 1], 'the badge drops to zero too').to.equal(0);
  });

  it('leaves the loading flag to the load that owns it', async () => {
    // A stale load clearing `loading` would un-blank the panel while the live
    // load is still out, briefly showing "No stashes" for a repo that has some.
    const el = await fixture<GnStashList>(
      html`<gn-stash-list .repositoryPath=${'/repo/a'}></gn-stash-list>`
    );
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    // A's stale load lands while B's is still in flight.
    settle('/repo/a', [makeStash(0, 'A work')]);
    await flush(el);

    expect(
      (el as unknown as { loading: boolean }).loading,
      'the live load still owns the loading state',
    ).to.be.true;
    expect(el.shadowRoot!.querySelector('.empty'), 'no premature "No stashes"').to.not.exist;

    settle('/repo/b', [makeStash(0, 'B work')]);
    await waitUntil(() => !(el as unknown as { loading: boolean }).loading);
    await flush(el);
    expect(texts(el, '.stash-message')).to.deep.equal(['B work']);
  });
});
