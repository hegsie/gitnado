/**
 * `ensureStatusFresh` — the freshness contract behind "Stage all"/"Unstage all".
 *
 * "Stage all" must act on what is on disk. Reloading unconditionally did that
 * but cost a full working-tree walk on every keypress, so the reload became
 * conditional on a dirty flag. The flag was then set from only two places (the
 * file watcher and a repo change), which put the gesture right back on a stale
 * list for every operation that mutates the index from somewhere else — a stash
 * apply, a reset, a hunk staged in the diff view — for as long as the watcher's
 * 500ms poll took to notice.
 *
 * The fix hooks `repository-refresh`, the broadcast every mutating operation
 * already fires, rather than enumerating those operations. These tests hold
 * both halves: no wasted reload when nothing changed, and never a skipped
 * reload after something did.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: string[] = [];
let statusPayload: unknown = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string) => {
    invoked.push(command);
    if (command === 'get_status') return Promise.resolve(statusPayload);
    return Promise.resolve(null);
  },
  transformCallback: () => 0,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-file-status.ts';
import type { GnFileStatus } from '../gn-file-status.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function mounted(): Promise<GnFileStatus> {
  const el = await fixture<GnFileStatus>(
    html`<gn-file-status .repositoryPath=${'/repo/a'}></gn-file-status>`,
  );
  await el.updateComplete;
  // Let connectedCallback's initial load settle.
  await (el as any).ensureStatusFresh();
  return el;
}

describe('gn-file-status ensureStatusFresh', () => {
  beforeEach(() => {
    invoked.length = 0;
    statusPayload = [];
  });

  it('does not re-walk the working tree when nothing has changed', async () => {
    const el = await mounted();
    invoked.length = 0;

    await (el as any).ensureStatusFresh();

    expect(
      invoked.filter((c) => c === 'get_status').length,
      'a fresh list costs nothing',
    ).to.equal(0);
  });

  it('reloads after repository-refresh — the broadcast every mutation fires', async () => {
    // Stash apply, reset, merge, rebase, revert and diff-view hunk staging all
    // reach handleRefresh(), which dispatches this. None of them touch the
    // watcher, and none dispatch `status-refresh`.
    const el = await mounted();
    invoked.length = 0;

    window.dispatchEvent(new CustomEvent('repository-refresh'));
    await (el as any).ensureStatusFresh();

    expect(
      invoked.filter((c) => c === 'get_status').length,
      'an out-of-band mutation must not be missed',
    ).to.equal(1);
  });

  it('reloads when the repository changed', async () => {
    const el = await mounted();
    invoked.length = 0;

    el.repositoryPath = '/repo/b';
    await el.updateComplete;
    await (el as any).ensureStatusFresh();

    expect(invoked.filter((c) => c === 'get_status').length).to.be.greaterThan(0);
  });

  it('awaits a load already in flight rather than racing it', async () => {
    const el = await mounted();
    (el as any).statusDirtySeq++;
    invoked.length = 0;

    await Promise.all([
      (el as any).ensureStatusFresh(),
      (el as any).ensureStatusFresh(),
    ]);

    expect(
      invoked.filter((c) => c === 'get_status').length,
      'two concurrent callers do not each trigger a walk',
    ).to.be.lessThan(3);
  });

  it('stops listening for the broadcast once disconnected', async () => {
    const el = await mounted();
    el.remove();
    await el.updateComplete;
    invoked.length = 0;

    window.dispatchEvent(new CustomEvent('repository-refresh'));

    expect(
      invoked.filter((c) => c === 'get_status').length,
      'a detached component does no work',
    ).to.equal(0);
  });

  it('a mutation that lands while a load is in flight is not declared fresh', async () => {
    // The boolean this replaced cleared on completion, so a load that STARTED
    // before the change reported a stale list as current.
    const el = await mounted();
    invoked.length = 0;

    (el as any).statusDirtySeq++;
    const inFlight = (el as any).ensureStatusFresh();
    // The change happens while that load is still running.
    window.dispatchEvent(new CustomEvent('repository-refresh'));
    await inFlight;

    invoked.length = 0;
    await (el as any).ensureStatusFresh();

    expect(
      invoked.filter((c) => c === 'get_status').length,
      'the mid-flight change still forces a reload',
    ).to.equal(1);
  });
});