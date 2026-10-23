/**
 * The ONE tab-close sweep shared by app-shell and gn-branch-list.
 *
 * Two properties matter and both have been broken here before:
 *  1. Discovery is from the DOM, not a hand-written list of tag names. Every
 *     previous version was a list, and every list went stale the next time a
 *     dialog was added — eight destructive dialogs were missed that way.
 *  2. It never announces a dismissal that did not happen. A dialog with work
 *     in flight refuses its own close(); forcing it shut hides a running
 *     destructive operation behind a "cancelled" toast.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import {
  collectRepoScopedDialogs,
  sweepRepoScopedDialogs,
} from '../repo-scoped-dialogs.ts';
import { uiStore } from '../../stores/ui.store.ts';

class FakeDialog extends HTMLElement {
  pinned: string | null = null;
  running = false;
  closeCalls = 0;
  closeWhenIdleCalls = 0;
  /** Set when the element supports deferring its close (repository health). */
  deferrable = false;

  get pinnedRepositoryPathIfOpen(): string | null {
    return this.pinned;
  }

  get operationInFlight(): boolean {
    return this.running;
  }

  close(): void {
    this.closeCalls++;
  }
}

class DeferrableDialog extends FakeDialog {
  closeWhenIdle(): void {
    this.closeWhenIdleCalls++;
  }
}

customElements.define('fake-sweep-dialog', FakeDialog);
customElements.define('fake-deferrable-dialog', DeferrableDialog);
/** Exposes the contract but is deliberately absent from every entries table. */
customElements.define('fake-unlisted-dialog', class extends FakeDialog {});

const ENTRIES = {
  'fake-sweep-dialog': { dismissed: 'clean cancelled', running: 'clean' },
  'fake-deferrable-dialog': {
    dismissed: 'repository health closed',
    running: 'maintenance operation',
  },
};

let root: HTMLElement;

function mount<T extends FakeDialog>(tag: string, pinned: string | null, running = false): T {
  const el = document.createElement(tag) as T;
  el.pinned = pinned;
  el.running = running;
  root.appendChild(el);
  return el;
}

function sweep(openPaths: string[]): void {
  sweepRepoScopedDialogs({
    root,
    isRepoOpen: (path) => openPaths.includes(path),
    hostHasRepositories: openPaths.length > 0,
    entries: ENTRIES,
  });
}

function messages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

describe('sweepRepoScopedDialogs', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it('finds dialogs by the contract they implement, not by tag name', () => {
    mount('fake-sweep-dialog', '/repo/a');
    mount('fake-unlisted-dialog', '/repo/a');
    root.appendChild(document.createElement('div'));

    const found = collectRepoScopedDialogs(root);
    expect(found.map((e) => e.tagName.toLowerCase())).to.deep.equal([
      'fake-sweep-dialog',
      'fake-unlisted-dialog',
    ]);
  });

  it('dismisses an idle dialog pinned to a closed repo and says so', () => {
    const dialog = mount<FakeDialog>('fake-sweep-dialog', '/repo/a');

    sweep(['/repo/b']);

    expect(dialog.closeCalls, 'idle dialog is dismissed').to.equal(1);
    expect(messages()).to.deep.equal(['The repository tab was closed — clean cancelled']);
  });

  it('leaves a dialog pinned to a STILL-OPEN repo alone', () => {
    const dialog = mount<FakeDialog>('fake-sweep-dialog', '/repo/a');

    sweep(['/repo/a', '/repo/b']);

    expect(dialog.closeCalls).to.equal(0);
    expect(messages()).to.deep.equal([]);
  });

  it('leaves a closed dialog (no pinned path) alone', () => {
    const dialog = mount<FakeDialog>('fake-sweep-dialog', null);

    sweep(['/repo/b']);

    expect(dialog.closeCalls).to.equal(0);
    expect(messages()).to.deep.equal([]);
  });

  it('refuses to dismiss — or claim to cancel — a dialog with work in flight', () => {
    const dialog = mount<FakeDialog>('fake-sweep-dialog', '/repo/a', true);
    let flagCleared = false;

    sweepRepoScopedDialogs({
      root,
      isRepoOpen: (path) => path === '/repo/b',
      hostHasRepositories: true,
      entries: {
        'fake-sweep-dialog': {
          dismissed: 'clean cancelled',
          running: 'clean',
          clearFlag: () => { flagCleared = true; },
        },
      },
    });

    expect(dialog.closeCalls, 'the in-flight guard is honoured').to.equal(0);
    expect(flagCleared, 'clearing the flag would unmount the dialog mid-delete').to.be.false;
    expect(messages()).to.deep.equal([
      'The repository tab was closed — the clean is still running against the closed repository and cannot be stopped',
    ]);
  });

  it('reports background completion (not a dismissal) when the LAST tab closes', () => {
    const dialog = mount<FakeDialog>('fake-sweep-dialog', '/repo/a', true);
    let flagCleared = false;

    sweepRepoScopedDialogs({
      root,
      isRepoOpen: () => false,
      hostHasRepositories: false,
      entries: {
        'fake-sweep-dialog': {
          dismissed: 'clean cancelled',
          running: 'clean',
          clearFlag: () => { flagCleared = true; },
        },
      },
    });

    expect(dialog.closeCalls, 'no forced close').to.equal(0);
    expect(
      flagCleared,
      'the host unmounts it anyway — a stale flag springs the dialog open over the NEXT repo',
    ).to.be.true;
    expect(messages()).to.deep.equal([
      'The repository tab was closed — the clean will finish in the background',
    ]);
  });

  it('hands the close to a deferrable dialog rather than orphaning its operation', () => {
    const dialog = mount<DeferrableDialog>('fake-deferrable-dialog', '/repo/a', true);

    sweep(['/repo/b']);

    expect(dialog.closeWhenIdleCalls, 'close is deferred, not refused').to.equal(1);
    expect(dialog.closeCalls, 'and not forced').to.equal(0);
    expect(messages()).to.deep.equal([
      'The repository tab was closed — the maintenance operation is still running; the dialog will close when it finishes',
    ]);
  });

  it('sweeps a dialog missing from the entries table, with generic wording', () => {
    // The safety property: forgetting a table row costs wording, never the
    // sweep itself. Forgetting a LIST ENTRY used to cost the whole guard.
    const dialog = mount<FakeDialog>('fake-unlisted-dialog', '/repo/a');

    sweep(['/repo/b']);

    expect(dialog.closeCalls, 'an unlisted dialog is still dismissed').to.equal(1);
    expect(messages()).to.deep.equal(['The repository tab was closed — the dialog was closed']);
  });

  it('does not force-dismiss an unlisted dialog that has work in flight', () => {
    const dialog = mount<FakeDialog>('fake-unlisted-dialog', '/repo/a', true);

    sweep(['/repo/b']);

    expect(dialog.closeCalls).to.equal(0);
    expect(messages()).to.deep.equal([
      'The repository tab was closed — the operation is still running against the closed repository and cannot be stopped',
    ]);
  });
});
