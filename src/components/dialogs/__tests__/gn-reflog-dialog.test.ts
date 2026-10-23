/**
 * Unit tests for gn-reflog-dialog.
 *
 * Verifies that a failed clipboard copy of a reflog entry hash shows an error
 * toast instead of failing silently.
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
import { uiStore } from '../../../stores/ui.store.ts';
import type { ReflogEntry } from '../../../types/git.types.ts';
import type { GnReflogDialog } from '../gn-reflog-dialog.ts';
import '../gn-reflog-dialog.ts';
import { tryAcquireRefOp, releaseRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';

const mockEntry: ReflogEntry = {
  oid: 'deadbeef1234',
  shortId: 'deadbee',
  refName: 'HEAD',
  message: 'commit: something',
  operation: 'commit',
  committer: { name: 'T', email: 't@example.com', timestamp: Math.floor(Date.now() / 1000) },
  timestamp: Math.floor(Date.now() / 1000),
  index: 0,
} as unknown as ReflogEntry;


/** A "checkout: moving from X to Y" reflog entry. */
function checkoutEntry(from: string, to: string): ReflogEntry {
  return {
    oid: 'feed0000beef',
    shortId: 'feed000',
    index: 1,
    action: 'checkout',
    message: `checkout: moving from ${from} to ${to}`,
    timestamp: Math.floor(Date.now() / 1000),
    author: 'T',
  } as unknown as ReflogEntry;
}

/** `count` sequential reflog entries, newest first. */
function pageEntries(count: number): ReflogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    oid: `oid${i}`.padEnd(12, '0'),
    shortId: `oid${i}`.padEnd(7, '0').slice(0, 7),
    index: i,
    action: 'commit',
    message: `commit: entry ${i}`,
    timestamp: Math.floor(Date.now() / 1000),
    author: 'T',
  })) as unknown as ReflogEntry[];
}

/**
 * A repo whose reflog holds `total` entries; get_reflog honours `limit` the
 * way the backend does (it stops once `limit` entries have been collected).
 * Every requested limit is recorded in `calls`.
 */
function mockReflogOfSize(total: number, calls: Array<{ limit?: number }>): void {
  const all = pageEntries(total);
  mockInvoke = async (command, args) => {
    if (command === 'get_reflog') {
      const limit = (args as { limit?: number }).limit;
      calls.push({ limit });
      return all.slice(0, limit ?? total);
    }
    if (command === 'plugin:dialog|message') return 'Ok';
    return null;
  };
}

/** An ordinary commit entry, which SHOULD still offer a reset. */
function commitEntry(): ReflogEntry {
  return {
    oid: 'cafe0000babe',
    shortId: 'cafe000',
    index: 2,
    action: 'commit',
    message: 'commit: work',
    timestamp: Math.floor(Date.now() / 1000),
    author: 'T',
  } as unknown as ReflogEntry;
}

describe('gn-reflog-dialog', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
    mockInvoke = async () => null;
  });

  it('shows an error toast when copying an entry hash fails', async () => {
    const el = await fixture<GnReflogDialog>(
      html`<gn-reflog-dialog .repositoryPath=${'/test/repo'}></gn-reflog-dialog>`
    );
    await el.updateComplete;

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).contextMenu = { visible: true, x: 0, y: 0, entry: mockEntry };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleContextCopyHash();

    const toasts = uiStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && /copy hash/i.test(t.message))).to.be.true;
  });

  // `repositoryPath` is live-bound to the ACTIVE repository and rebinds on a
  // Ctrl+Tab this dialog's overlay does not block. The entries on screen (and
  // the oid named in the confirm) belong to the repo active at OPEN, so the
  // reset must target that repo — not whichever tab the user switched to.
  it('resets the repository the entries were read from, not the newly active one', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    mockInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === 'get_reflog') return [mockEntry];
      if (command === 'plugin:dialog|message') return 'Ok';
      return null;
    };

    const el = await fixture<GnReflogDialog>(
      html`<gn-reflog-dialog ?open=${true} .repositoryPath=${'/repo/a'}></gn-reflog-dialog>`
    );
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    // The reflog was read from repo A.
    const load = calls.find((c) => c.command === 'get_reflog');
    expect((load?.args as { path?: string })?.path).to.equal('/repo/a');

    // User Ctrl+Tabs; the dialog stays open still showing A's entries.
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleReset(mockEntry, 'hard');

    const reset = calls.find((c) => c.command === 'reset_to_reflog');
    expect(reset, 'reset_to_reflog issued').to.not.be.undefined;
    expect((reset!.args as { path: string }).path).to.equal('/repo/a');
  });

  // Only handleDocumentClick cleared this, and Escape is not a click — so the
  // menu was repainted over the next session's list still holding the OLD
  // entry, and clicking it ran a reset the user never re-selected.
  it('clears the context menu when the dialog closes', async () => {
    const el = await fixture<GnReflogDialog>(
      html`<gn-reflog-dialog ?open=${true} .repositoryPath=${'/test/repo'}></gn-reflog-dialog>`
    );
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).contextMenu = { visible: true, x: 10, y: 10, entry: mockEntry };
    el.close();
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).contextMenu.visible).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).contextMenu.entry).to.be.null;
  });

  // handleReset already CLAIMED the shared lock and refused when another
  // surface held it — but the buttons were bound to `resetting` alone, a flag
  // that only ever tracked this dialog. So while a checkout ran elsewhere,
  // "Hard reset (discard all changes)" stayed fully clickable and did nothing
  // but raise a refusal toast. Asserted on rendered DOM: the getter calls
  // isRefOpRunning on every access and so reports the truth even with the
  // subscription deleted.
  it('greys out Undo and Hard while another surface holds the working tree', async () => {
    const REPO = '/test/repo';
    resetRefOpLocks();
    mockInvoke = async (command: string) =>
      command === 'get_reflog'
        ? [mockEntry, { ...mockEntry, oid: 'cafe5678', shortId: 'cafe567', index: 1 }]
        : null;

    const el = await fixture<GnReflogDialog>(
      html`<gn-reflog-dialog ?open=${true} .repositoryPath=${REPO}></gn-reflog-dialog>`
    );

    let buttons: HTMLButtonElement[] = [];
    for (let i = 0; i < 100 && buttons.length === 0; i++) {
      await el.updateComplete;
      buttons = Array.from(el.shadowRoot!.querySelectorAll('.reset-btn'));
      if (buttons.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(buttons.length, 'reset buttons must be rendered').to.be.greaterThan(0);
    expect(
      buttons.every((b) => !b.disabled),
      'clickable while the repo is idle'
    ).to.be.true;

    tryAcquireRefOp(REPO);
    await el.updateComplete;
    expect(
      buttons.every((b) => b.disabled),
      'a claim from another surface must grey them out'
    ).to.be.true;

    releaseRefOp(REPO);
    await el.updateComplete;
    expect(
      buttons.every((b) => !b.disabled),
      'and the release must revive them'
    ).to.be.true;

    resetRefOpLocks();
  });

  // ── Checkout entries must switch, not reset ──────────────────────────────
  describe('checkout entries', () => {
    /**
     * Opens the dialog for real, so the repo it pins is the one under test.
     * Poking `entries` on a closed dialog left `pinnedRepoPath` empty, which no
     * longer resembles anything a user can produce.
     */
    async function dialogWith(
      entries: ReflogEntry[],
      repositoryPath = '/test/repo'
    ): Promise<GnReflogDialog> {
      const inner = mockInvoke;
      mockInvoke = async (command, args) => {
        if (command === 'get_reflog') return entries;
        return inner(command, args);
      };

      const el = await fixture<GnReflogDialog>(
        html`<gn-reflog-dialog ?open=${true} .repositoryPath=${repositoryPath}></gn-reflog-dialog>`
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
      return el;
    }

    /** A successful `checkout_with_autostash` payload, with overrides. */
    function stashResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        success: true,
        stashed: false,
        stashApplied: false,
        stashConflict: false,
        stashOid: null,
        message: 'Switched',
        ...overrides,
      };
    }

    it('offers Switch instead of a reset on a checkout entry', async () => {
      // A "checkout: moving from main to feature" entry records ANOTHER
      // branch's tip. Resetting onto it repoints the current branch there and
      // orphans its commits — the opposite of "go back to that state".
      const el = await dialogWith([checkoutEntry('main', 'feature')]);

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.entry-actions button')).map(
        (b) => b.textContent!.trim()
      );

      expect(labels.join(' | ')).to.contain('Switch to feature');
      expect(labels, 'a checkout entry must not offer a hard reset').to.not.include('Hard');
      expect(labels, 'a checkout entry must not offer an "Undo" reset').to.not.include('Undo');
    });

    it('still offers Undo and Hard on an ordinary commit entry', async () => {
      const el = await dialogWith([commitEntry()]);

      const labels = Array.from(el.shadowRoot!.querySelectorAll('.entry-actions button')).map(
        (b) => b.textContent!.trim()
      );

      expect(labels).to.include('Undo');
      expect(labels).to.include('Hard');
    });

    it('checks out the target branch rather than resetting', async () => {
      const calls: string[] = [];
      mockInvoke = async (command: string) => {
        calls.push(command);
        if (command === 'checkout_with_autostash') return stashResult();
        return null;
      };

      const el = await dialogWith([checkoutEntry('main', 'feature')]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSwitchTo(checkoutEntry('main', 'feature'));

      expect(calls).to.include('checkout_with_autostash');
      expect(calls, 'a switch must never reset the branch').to.not.include('reset_to_reflog');
    });

    // The same live-prop trap the reset path already guards against: the
    // overlay does not block Ctrl+Tab, so reading `repositoryPath` at call time
    // ran the checkout against whichever repo the user had switched to — where
    // the branch name means something else, or nothing at all.
    it('switches the repository the entries were read from, not the newly active one', async () => {
      const calls: Array<{ command: string; args?: unknown }> = [];
      mockInvoke = async (command, args) => {
        calls.push({ command, args });
        if (command === 'checkout_with_autostash') return stashResult();
        return null;
      };

      const el = await dialogWith([checkoutEntry('main', 'feature')], '/repo/a');
      el.repositoryPath = '/repo/b';
      await el.updateComplete;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSwitchTo(checkoutEntry('main', 'feature'));

      const checkout = calls.find((c) => c.command === 'checkout_with_autostash');
      expect(checkout, 'checkout_with_autostash issued').to.not.be.undefined;
      expect((checkout!.args as { path: string }).path).to.equal('/repo/a');
    });

    // The switch auto-stashes, so it can land with the user's changes still
    // shelved or conflicted. A bare "Switched to feature" hid that entirely.
    it('reports a conflicting auto-stash instead of a bare success', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'checkout_with_autostash') {
          return stashResult({
            stashed: true,
            stashApplied: false,
            stashConflict: true,
            stashOid: 'stash0id',
            message: 'Stash conflicts',
          });
        }
        return null;
      };

      const el = await dialogWith([checkoutEntry('main', 'feature')]);
      let conflictDetail: Record<string, unknown> | null = null;
      el.addEventListener('open-conflict-dialog', (e) => {
        conflictDetail = (e as CustomEvent).detail;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSwitchTo(checkoutEntry('main', 'feature'));

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'warning' && /stash conflicts/i.test(t.message)),
        'the user must be told the stash needs resolving'
      ).to.be.true;
      expect(conflictDetail, 'the conflict dialog must be opened').to.not.be.null;
      expect(conflictDetail!).to.include({
        operationType: 'stash',
        stashOid: 'stash0id',
        dropStashOnComplete: true,
        repositoryPath: '/test/repo',
      });
    });

    it('warns when the auto-stash could not be re-applied', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'checkout_with_autostash') {
          return stashResult({
            stashed: true,
            stashApplied: false,
            stashConflict: false,
            message: 'Changes are kept in the stash',
          });
        }
        return null;
      };

      const el = await dialogWith([checkoutEntry('main', 'feature')]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleSwitchTo(checkoutEntry('main', 'feature'));

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'warning' && /kept in the stash/i.test(t.message)),
        'work left in the stash must not be reported as a clean switch'
      ).to.be.true;
    });

    it('parses the target only from checkout entries', async () => {
      const el = await dialogWith([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = (e: ReflogEntry) => (el as any).checkoutTarget(e);

      expect(target(checkoutEntry('main', 'feature'))).to.equal('feature');
      expect(target(checkoutEntry('feature', 'release/2.0'))).to.equal('release/2.0');
      expect(target(commitEntry()), 'a commit entry is not a checkout').to.be.null;
    });
  });

  // ── Reaching entries past the first page ─────────────────────────────────
  //
  // This dialog is the app's recovery surface, and it asked for exactly 50
  // entries and rendered nothing else: a user whose lost commit sat at
  // HEAD@{51} scrolled to the bottom, found nothing, and had no way to learn
  // that older states existed — while git could still recover them.
  describe('pagination', () => {
    /** Open a real session so the dialog pins a repo and loads its first page. */
    async function openDialog(repositoryPath = '/test/repo'): Promise<GnReflogDialog> {
      const el = await fixture<GnReflogDialog>(
        html`<gn-reflog-dialog ?open=${true} .repositoryPath=${repositoryPath}></gn-reflog-dialog>`
      );
      await settle(el);
      return el;
    }

    async function settle(el: GnReflogDialog): Promise<void> {
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }

    function showMore(el: GnReflogDialog): HTMLButtonElement | null {
      return el.shadowRoot!.querySelector<HTMLButtonElement>('.show-more-btn');
    }

    function note(el: GnReflogDialog): string {
      return el.shadowRoot!.querySelector('.list-note')?.textContent ?? '';
    }

    it('flags the list as truncated and offers a way to see older entries', async () => {
      const calls: Array<{ limit?: number }> = [];
      mockReflogOfSize(120, calls);

      const el = await openDialog();

      expect(calls[0].limit, 'the first page asks for 50').to.equal(50);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);
      expect(showMore(el), 'a truncated list must offer more').to.not.be.null;
      expect(note(el)).to.match(/first 50/);
    });

    it('Show more pulls the next page and stops once the whole reflog is listed', async () => {
      const calls: Array<{ limit?: number }> = [];
      mockReflogOfSize(120, calls);

      const el = await openDialog();

      showMore(el)!.click();
      await settle(el);

      // get_reflog has no skip parameter, so the next page is a re-read from
      // HEAD@{0} with a bigger limit — replacing the list, not appending.
      expect(calls[1].limit).to.equal(100);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(100);
      expect(showMore(el), 'still more to come').to.not.be.null;

      showMore(el)!.click();
      await settle(el);

      expect(calls[2].limit).to.equal(150);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(120);
      expect(showMore(el), 'a complete list must not offer a dead control').to.be.null;
      expect(note(el)).to.match(/Showing all 120/);
    });

    it('keeps the list and the control when a page fails to load, and says so', async () => {
      let loads = 0;
      mockInvoke = async (command) => {
        if (command === 'get_reflog') {
          loads++;
          if (loads > 1) throw new Error('reflog read failed');
          return pageEntries(50);
        }
        return null;
      };

      const el = await openDialog();
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);

      showMore(el)!.click();
      await settle(el);

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'error' && /load more/i.test(t.message)),
        'a failed page must be reported'
      ).to.be.true;
      expect(
        el.shadowRoot!.querySelectorAll('.entry').length,
        'the failure must not wipe the list the user was reading'
      ).to.equal(50);
      expect(showMore(el), 'retry must stay available').to.not.be.null;
    });

    it('a short reflog says the list is complete instead of offering a dead control', async () => {
      const calls: Array<{ limit?: number }> = [];
      mockReflogOfSize(3, calls);

      const el = await openDialog();

      expect(showMore(el)).to.be.null;
      expect(note(el)).to.match(/Showing all 3/);
    });

    // loadReflog doubles as the post-failed-reset refresh (the backend's
    // "refresh and try again" advice), so it must NOT collapse the expansion
    // at exactly the moment the user is hunting for a deep entry.
    it('keeps the expanded listing when a failed reset reloads the entries', async () => {
      const calls: Array<{ limit?: number }> = [];
      const all = pageEntries(120);
      resetRefOpLocks();
      mockInvoke = async (command, args) => {
        if (command === 'get_reflog') {
          const limit = (args as { limit?: number }).limit;
          calls.push({ limit });
          return all.slice(0, limit ?? 120);
        }
        if (command === 'plugin:dialog|message') return 'Ok';
        if (command === 'reset_to_reflog') throw new Error('reflog moved');
        return null;
      };

      const el = await openDialog();
      showMore(el)!.click();
      await settle(el);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(100);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleReset(all[5], 'mixed');
      await settle(el);

      expect(calls[calls.length - 1].limit, 'the refresh keeps the expansion').to.equal(100);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(100);
      resetRefOpLocks();
    });

    it('starts a reopened dialog back at the first page', async () => {
      const calls: Array<{ limit?: number }> = [];
      mockReflogOfSize(120, calls);

      const el = await openDialog();
      showMore(el)!.click();
      await settle(el);
      expect(calls[calls.length - 1].limit, 'expanded before closing').to.equal(100);

      el.open = false;
      await el.updateComplete;
      el.open = true;
      await settle(el);

      expect(calls[calls.length - 1].limit, 'a new session starts fresh').to.equal(50);
      expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);
    });

    // Two reads of the SAME repo can be in flight at once, because every read
    // here re-fetches from HEAD@{0} at the current limit. If the superseded one
    // lands last, `entries` and `entryLimit` end up describing different reads
    // and hasMoreEntries goes false on a list that is still truncated — the
    // recovery surface then tells the user there is nothing older when there is.
    describe('superseded reads', () => {
      /** get_reflog reads that are held open until the test releases them. */
      function deferredReflog(total: number): {
        pending: Array<{ limit: number; release: () => void; fail: () => void }>;
        defer: () => void;
      } {
        const all = pageEntries(total);
        const pending: Array<{ limit: number; release: () => void; fail: () => void }> = [];
        let deferring = false;
        mockInvoke = async (command, args) => {
          if (command === 'get_reflog') {
            const limit = (args as { limit?: number }).limit ?? total;
            const page = all.slice(0, limit);
            if (!deferring) return page;
            return new Promise((resolve, reject) => {
              pending.push({
                limit,
                release: () => resolve(page),
                fail: () => reject(new Error('reflog read failed')),
              });
            });
          }
          if (command === 'plugin:dialog|message') return 'Ok';
          if (command === 'reset_to_reflog') throw new Error('reflog moved');
          return null;
        };
        return { pending, defer: () => { deferring = true; } };
      }

      /** Let queued microtasks reach the mock before inspecting it. */
      async function flush(): Promise<void> {
        await new Promise((r) => setTimeout(r, 0));
      }

      it('discards a page belonging to a session the user already closed', async () => {
        const { pending, defer } = deferredReflog(120);
        const el = await openDialog();
        expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);

        defer();
        showMore(el)!.click();
        await flush();
        expect(pending.map((p) => p.limit), 'the 100-entry page is in flight').to.deep.equal([100]);

        // Escape, then reopen on the SAME repo: `open` and the pinned repo both
        // match again, so the old guards no longer reject the stale page.
        el.open = false;
        await el.updateComplete;
        el.open = true;
        await el.updateComplete;
        await flush();
        expect(pending.map((p) => p.limit), 'the new session re-reads page one').to.deep.equal([100, 50]);

        pending[0].release(); // the abandoned page lands first...
        await settle(el);
        pending[1].release(); // ...and the live one last.
        await settle(el);

        expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);
        expect(showMore(el), 'a truncated list must keep offering older entries').to.not.be.null;
        expect(note(el)).to.match(/first 50/);
      });

      it('keeps the footer honest when a failed reset refreshes over a page in flight', async () => {
        resetRefOpLocks();
        const all = pageEntries(120);
        const { pending, defer } = deferredReflog(120);
        const el = await openDialog();
        expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);

        defer();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (el as any).loadMoreEntries();
        await flush();
        expect(pending.map((p) => p.limit)).to.deep.equal([100]);

        // The reset fails, and its "refresh and try again" reload reads at the
        // limit the in-flight page has not advanced yet.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reset = (el as any).handleReset(all[5], 'mixed') as Promise<void>;
        await flush();
        expect(pending.map((p) => p.limit), 'the refresh re-reads page one').to.deep.equal([100, 50]);

        pending[0].release();
        await settle(el);
        pending[1].release();
        await reset;
        await settle(el);

        expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);
        expect(showMore(el), 'a truncated list must keep offering older entries').to.not.be.null;
        expect(note(el)).to.match(/first 50/);
        resetRefOpLocks();
      });

      // Closing the trigger as well as the race: a click here starts a read the
      // reset's own refresh will supersede, so the page the user asked for is
      // thrown away and the control does nothing they can see.
      it('does not offer Show more while a reset is running', async () => {
        const calls: Array<{ limit?: number }> = [];
        mockReflogOfSize(120, calls);
        const el = await openDialog();

        expect(showMore(el)!.disabled, 'available while the dialog is idle').to.be.false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el as any).resetting = true;
        await el.updateComplete;

        expect(showMore(el)!.disabled, 'a read racing the reset is not a live option').to.be.true;
      });

      // `loadingMore` is per-request state, so a session that never sees its
      // page land must not hand the flag to the next one: the reopened dialog
      // came up with its only paging control stuck on a disabled "Loading..."
      // for a request nobody was waiting on — on the app's recovery surface.
      it('offers a usable Show more in a session reopened over an abandoned page', async () => {
        const { pending, defer } = deferredReflog(120);
        const el = await openDialog();

        defer();
        showMore(el)!.click();
        await flush();
        expect(pending.map((p) => p.limit), 'the 100-entry page is in flight').to.deep.equal([100]);

        // The host closes this dialog by clearing `open` ("Show in graph"),
        // then the user reopens it — the abandoned page is still out there.
        el.open = false;
        await el.updateComplete;
        el.open = true;
        await el.updateComplete;
        await flush();
        pending[1].release();
        await settle(el);

        expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(50);
        expect(showMore(el)!.disabled, 'the new session can page').to.be.false;
        expect(showMore(el)!.textContent?.trim()).to.equal('Show more');
      });

      it('keeps Show more busy when an abandoned page settles under a live one', async () => {
        const { pending, defer } = deferredReflog(120);
        const el = await openDialog();

        defer();
        showMore(el)!.click();
        await flush();

        el.open = false;
        await el.updateComplete;
        el.open = true;
        await el.updateComplete;
        await flush();
        pending[1].release();
        await settle(el);

        // A page the user asked for in the NEW session.
        showMore(el)!.click();
        await flush();
        expect(pending.map((p) => p.limit)).to.deep.equal([100, 50, 100]);

        pending[0].release(); // the abandoned page finally settles
        await settle(el);

        expect(showMore(el)!.disabled, 'the live page is still loading').to.be.true;
        expect(showMore(el)!.textContent?.trim()).to.equal('Loading...');
      });

      // The failure half of the same abandonment. invokeCommand turns every
      // rejection into `{ success: false }`, so a failed page reports through
      // the SAME branch that publishes a good one — behind the `open` check —
      // and a session the host has already closed stays quiet.
      it('does not report a failed page for a session the host already closed', async () => {
        const { pending, defer } = deferredReflog(120);
        const el = await openDialog();

        defer();
        showMore(el)!.click();
        await flush();
        expect(pending.map((p) => p.limit)).to.deep.equal([100]);

        // "Show in graph" clears `open` without calling close(), so the fetch
        // generation is untouched and only `open` marks the session as gone.
        el.open = false;
        await el.updateComplete;
        uiStore.setState({ toasts: [] });

        pending[0].fail();
        await settle(el);

        expect(
          uiStore.getState().toasts.some((t) => /load more/i.test(t.message)),
          'a page nobody is watching must not raise a toast'
        ).to.be.false;
      });
    });
  });
});
