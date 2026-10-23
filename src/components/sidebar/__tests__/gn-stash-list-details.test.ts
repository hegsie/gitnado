/**
 * Tests for the inline stash contents preview in gn-stash-list.
 *
 * Apply/Pop/Drop all act on content the user could not see — Drop
 * irreversibly. These cover clicking a row to reveal `git stash show`'s
 * diffstat, the context-menu and keyboard routes to it, and the staleness
 * guards that stop the WRONG stash being previewed.
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
import type { GnStashList } from '../gn-stash-list.ts';

// Import the actual component
import '../gn-stash-list.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeStash(overrides: Partial<{
  index: number;
  message: string;
  oid: string;
}> = {}) {
  return {
    index: overrides.index ?? 0,
    message: overrides.message ?? 'WIP on main',
    oid: overrides.oid ?? 'abc123',
  };
}

/**
 * Stash list returned by `get_stashes`. handleToggleDetails re-resolves the
 * clicked stash by oid against this list before calling stash_show, so a test
 * that expects a preview must seed it with that stash.
 */
let mockStashes: unknown[] = [];

/** Result returned by `stash_show`. */
let stashShowResult: unknown = null;

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_stashes') {
    return Promise.resolve(mockStashes);
  }
  if (command === 'stash_show') {
    return Promise.resolve(stashShowResult);
  }
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnStashList> {
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnStashList>(
    html`<gn-stash-list .repositoryPath=${REPO_PATH}></gn-stash-list>`
  );
  await el.updateComplete;
  return el;
}

/** Two microtask hops: resolveStashIndex, then stashShow. */
async function settle(el: GnStashList): Promise<void> {
  await el.updateComplete;
  await new Promise(r => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise(r => setTimeout(r, 0));
  await el.updateComplete;
}

/** The oid whose preview is open. Private state, but see the drop test. */
function expandedOid(el: GnStashList): string | null {
  return (el as unknown as { expandedOid: string | null }).expandedOid;
}

function row(el: GnStashList): HTMLElement {
  return el.shadowRoot!.querySelector('li.stash-item') as HTMLElement;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-stash-list contents preview', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    mockStashes = [makeStash({ index: 0, message: 'WIP', oid: 'abc123' })];
    stashShowResult = {
      index: 0,
      oid: 'abc123',
      message: 'WIP',
      files: [{ path: 'src/a.ts', additions: 3, deletions: 1, status: 'modified' }],
      totalAdditions: 3,
      totalDeletions: 1,
      patch: null,
    };
  });

  it('clicking a stash row shows what is in it', async () => {
    const el = await createComponent();
    invokeCalls.length = 0;

    row(el).click();
    await settle(el);

    expect(invokeCalls.filter(c => c.command === 'stash_show')).to.have.length(1);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;
    expect(el.shadowRoot!.textContent).to.include('src/a.ts');
    expect(el.shadowRoot!.textContent).to.include('+3');
  });

  it('a second click collapses it', async () => {
    const el = await createComponent();

    row(el).click();
    await settle(el);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;

    row(el).click();
    await settle(el);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.be.null;
  });

  it('reports a failed read in the row instead of swallowing it', async () => {
    const el = await createComponent();
    mockInvoke = (c: string) =>
      c === 'stash_show'
        ? Promise.reject({ code: 'COMMAND_ERROR', message: 'could not read stash entry' })
        : defaultMockInvoke(c);

    row(el).click();
    await settle(el);

    const errEl = el.shadowRoot!.querySelector('.stash-details-error');
    expect(errEl).to.not.be.null;
    expect(errEl!.textContent).to.include('could not read stash entry');
    // The loading flag must clear, or the row is stuck on a spinner forever.
    expect(el.shadowRoot!.textContent).to.not.include('Loading contents');
  });

  it('says so when the stash has no file changes', async () => {
    const el = await createComponent();
    stashShowResult = {
      index: 0,
      oid: 'abc123',
      message: 'WIP',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      patch: null,
    };

    row(el).click();
    await settle(el);

    expect(el.shadowRoot!.querySelector('.stash-details')!.textContent!.trim())
      .to.equal('No file changes');
  });

  it('previews the stash the user clicked after the list shifts', async () => {
    const target = makeStash({ index: 1, message: 'refactor WIP', oid: 'target-oid' });
    mockStashes = [target];
    const el = await createComponent();

    // Two stashes pushed since render: the clicked row still carries index 1,
    // but its live position is now 2.
    mockStashes = [
      makeStash({ index: 0, oid: 'new-oid' }),
      makeStash({ index: 1, oid: 'other-oid' }),
      { ...target, index: 2 },
    ];
    invokeCalls.length = 0;

    row(el).click();
    await settle(el);

    const call = invokeCalls.find(c => c.command === 'stash_show');
    expect(call, 'stash_show must be called').to.not.be.undefined;
    expect(
      (call!.args as { index: number }).index,
      'must preview the CURRENT position of the clicked stash'
    ).to.equal(2);
  });

  it('does not preview a stash that has vanished', async () => {
    const el = await createComponent();
    uiStore.setState({ toasts: [] });

    mockStashes = [makeStash({ oid: 'someone-else' })];
    invokeCalls.length = 0;

    row(el).click();
    await settle(el);

    expect(invokeCalls.filter(c => c.command === 'stash_show')).to.have.length(0);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.be.null;
    expect(
      uiStore.getState().toasts.some(t => /no longer in the stash list/i.test(t.message))
    ).to.be.true;
  });

  it('does not render another repo\'s stash contents after a tab switch', async () => {
    const el = await createComponent();

    let resolveShow: (v: unknown) => void = () => {};
    mockInvoke = (c: string) =>
      c === 'stash_show'
        ? new Promise(resolve => { resolveShow = resolve; })
        : defaultMockInvoke(c);

    row(el).click();
    // Let the oid resolution settle so the pending call is stash_show.
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 0));
    await el.updateComplete;

    // The read really did go out — otherwise "nothing rendered" would prove
    // nothing about discarding its result.
    expect(invokeCalls.filter(c => c.command === 'stash_show')).to.have.length(1);

    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';
    resolveShow(stashShowResult);
    await settle(el);

    expect(el.shadowRoot!.querySelector('.stash-details')).to.be.null;
  });

  it('opens the preview from the Show Contents context-menu item', async () => {
    const el = await createComponent();

    row(el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await el.updateComplete;

    const items = Array.from(
      el.shadowRoot!.querySelectorAll('.context-menu-item')
    ) as HTMLElement[];
    const labels = items.map(i => i.textContent!.trim());
    expect(labels).to.include('Show Contents');

    items[labels.indexOf('Show Contents')].click();
    await settle(el);

    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;
  });

  it('opens the preview when Enter is pressed on a row', async () => {
    const el = await createComponent();

    row(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(el);

    expect(row(el).getAttribute('aria-expanded')).to.equal('true');
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;
  });

  it('still reaches the actions menu with Shift+F10', async () => {
    const el = await createComponent();

    row(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })
    );
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.context-menu')).to.not.be.null;
  });

  it('closes the preview when its stash is dropped', async () => {
    // A SURVIVING stash is the point: if the refresh emptied the list, the
    // preview would vanish along with the rows that host it, and the assertion
    // would still pass with the expandedOid guard deleted. Dropping only the
    // expanded entry leaves a row rendered, so only the guard can satisfy it.
    mockStashes = [
      makeStash({ index: 0, message: 'WIP one', oid: 'abc123' }),
      makeStash({ index: 1, message: 'WIP two', oid: 'def456' }),
    ];
    const el = await createComponent();

    row(el).click();
    await settle(el);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;

    mockStashes = [makeStash({ index: 0, message: 'WIP two', oid: 'def456' })];
    await (el as unknown as { refresh: () => Promise<void> }).refresh();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelectorAll('li.stash-item')).to.have.length(1);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.be.null;
    // The DOM assertion above cannot fail on its own: the preview is rendered
    // inside the map over `stashes`, so it disappears with the dropped row
    // whether or not anything reset the state. What the guard actually owns is
    // that state — left set, it keeps a dropped stash's diff in `stashDetails`
    // and its oid marked expanded. So assert the state.
    expect(expandedOid(el)).to.be.null;
  });

  it('keeps the preview open when a DIFFERENT stash is dropped', async () => {
    // The mirror of the case above: the guard must key on the expanded oid and
    // not collapse on any list change at all.
    mockStashes = [
      makeStash({ index: 0, message: 'WIP one', oid: 'abc123' }),
      makeStash({ index: 1, message: 'WIP two', oid: 'def456' }),
    ];
    const el = await createComponent();

    row(el).click();
    await settle(el);
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;

    mockStashes = [makeStash({ index: 0, message: 'WIP one', oid: 'abc123' })];
    await (el as unknown as { refresh: () => Promise<void> }).refresh();
    await el.updateComplete;

    expect(expandedOid(el)).to.equal('abc123');
    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;
  });

  it('refuses a preview that came back for a different stash', async () => {
    // resolveStashIndex reads a live index, but stash_show is a SECOND round
    // trip. A create or drop in between renumbers the list, so that index can
    // name another entry — and rendering its diff as this row's contents is how
    // someone Drops the wrong stash. The echoed oid is the only proof.
    const el = await createComponent();
    stashShowResult = {
      index: 0,
      oid: 'someoneelse999',
      message: 'WIP two',
      files: [{ path: 'src/other.ts', additions: 9, deletions: 9, status: 'modified' }],
      totalAdditions: 9,
      totalDeletions: 9,
      patch: null,
    };

    uiStore.setState({ toasts: [] });

    row(el).click();
    await settle(el);

    // The other stash's diff must not be shown as this row's contents...
    expect(el.shadowRoot!.textContent).to.not.include('src/other.ts');
    expect(el.shadowRoot!.querySelector('.stash-details')).to.be.null;
    // ...and the row must not just silently close.
    expect(
      uiStore.getState().toasts.some(t => /moved in the stash list/i.test(t.message))
    ).to.be.true;
  });

  it('shows the full stash message on hover', async () => {
    // .stash-message is ellipsized and stashes can be named, so the tooltip is
    // the only way to read a truncated name before an irreversible Drop.
    const long = 'WIP on main: a stash name far too long for the sidebar column';
    mockStashes = [makeStash({ index: 0, message: long, oid: 'abc123' })];
    const el = await createComponent();

    expect(row(el).getAttribute('title')).to.equal(long);
  });

  it('does not add a phantom list entry when a stash is expanded', async () => {
    // The preview is a sibling <li>. If it is exposed as a listitem, a screen
    // reader announces "list, 4 items" for 3 stashes the moment one is
    // expanded — and in the transient state before the preview has any content
    // it announces an entirely empty entry.
    mockStashes = [
      makeStash({ index: 0, message: 'WIP one', oid: 'aaa111' }),
      makeStash({ index: 1, message: 'WIP two', oid: 'bbb222' }),
      makeStash({ index: 2, message: 'WIP three', oid: 'ccc333' }),
    ];
    // stash_show echoes the entry it describes, and the panel checks it.
    stashShowResult = { ...(stashShowResult as object), oid: 'aaa111' };
    const el = await createComponent();

    const listItems = () =>
      el.shadowRoot!.querySelectorAll('.stash-list [role="listitem"]').length;
    expect(listItems()).to.equal(3);

    row(el).click();
    await settle(el);

    expect(el.shadowRoot!.querySelector('.stash-details')).to.not.be.null;
    expect(listItems()).to.equal(3);
  });
});
