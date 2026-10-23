/**
 * Tests for the welcome screen's recent-repository rows: the per-row remove
 * control must be a real descendant of its row (a nested <button> inside a
 * <button> is hoisted out by the HTML parser), and the row must stay
 * activatable by mouse and keyboard.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    try {
      return Promise.resolve(handler ? handler(args || {}) : null);
    } catch (err) {
      return Promise.reject(err);
    }
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-welcome.ts';
import type { GnWelcome } from '../gn-welcome.ts';
import { repositoryStore } from '../../../stores/index.ts';

function mockRepoPayload(path: string) {
  return {
    path,
    name: path.split('/').pop(),
    isValid: true,
    isBare: false,
    headRef: 'main',
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/** Let the click handler's promise chain settle. */
async function flush(el: GnWelcome): Promise<void> {
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

function openCalls() {
  return invokeCallArgs.filter((c) => c.command === 'open_repository');
}

describe('gn-welcome recent repository rows', () => {
  let el: GnWelcome;

  beforeEach(async () => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    repositoryStore.getState().reset();
    // Most recent first ⇒ rendered order is alpha, beta.
    repositoryStore.getState().addRecentRepository('/repos/beta', 'beta');
    repositoryStore.getState().addRecentRepository('/repos/alpha', 'alpha');
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);

    el = await fixture<GnWelcome>(html`<gn-welcome></gn-welcome>`);
    await el.updateComplete;
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  it('nests each remove control inside its own recent row', () => {
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('.recent-item').length).to.equal(2);
    expect(root.querySelectorAll('.recent-item .recent-remove').length).to.equal(2);
    // A nested <button> would be hoisted out and become a stray sibling row.
    expect(root.querySelectorAll('.recent-list > .recent-remove').length).to.equal(0);

    const row = root.querySelector('.recent-item') as HTMLElement;
    expect(row.tagName).to.equal('DIV');
    expect(row.getAttribute('role')).to.equal('button');
    expect(row.getAttribute('tabindex')).to.equal('0');
  });

  it('opens the repository when a recent row is clicked', async () => {
    const row = el.shadowRoot!.querySelector('.recent-item') as HTMLElement;
    row.click();
    await flush(el);

    expect(openCalls().length).to.equal(1);
    expect(openCalls()[0].args.path).to.equal('/repos/alpha');
    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(1);
    expect(state.openRepositories[0].repository.path).to.equal('/repos/alpha');
  });

  it('opens the repository when Enter is pressed on a focused recent row', async () => {
    const row = el.shadowRoot!.querySelector('.recent-item') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await flush(el);

    expect(openCalls().length).to.equal(1);
    expect(openCalls()[0].args.path).to.equal('/repos/alpha');
  });

  it('removes only that entry when its remove button is clicked, without opening the repository', async () => {
    const remove = el.shadowRoot!.querySelector('.recent-item .recent-remove') as HTMLButtonElement;
    expect(remove, 'remove button must be a descendant of its row').to.exist;
    remove.click();
    await flush(el);

    expect(repositoryStore.getState().recentRepositories.map((r) => r.path)).to.deep.equal([
      '/repos/beta',
    ]);
    expect(el.shadowRoot!.querySelectorAll('.recent-item').length).to.equal(1);
    expect(openCalls().length).to.equal(0);
  });

  it('removes the entry — and does not open it — when Enter is pressed on the remove button', async () => {
    const remove = el.shadowRoot!.querySelector('.recent-item .recent-remove') as HTMLButtonElement;
    expect(remove, 'remove button must be a descendant of its row').to.exist;
    remove.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
    );
    await flush(el);

    expect(repositoryStore.getState().recentRepositories.map((r) => r.path)).to.deep.equal([
      '/repos/beta',
    ]);
    expect(openCalls().length).to.equal(0);
  });

  it('ignores unrelated keys on a recent row and on its remove button', async () => {
    const row = el.shadowRoot!.querySelector('.recent-item') as HTMLElement;
    const remove = el.shadowRoot!.querySelector('.recent-item .recent-remove') as HTMLButtonElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await flush(el);

    expect(openCalls().length).to.equal(0);
    expect(repositoryStore.getState().recentRepositories.length).to.equal(2);
  });

  it('surfaces an error and opens nothing when a recent repository can no longer be opened', async () => {
    mockResponses['open_repository'] = () => {
      throw new Error('repository not found');
    };
    const row = el.shadowRoot!.querySelector('.recent-item') as HTMLElement;
    row.click();
    await flush(el);

    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(0);
    expect(state.error ?? '').to.contain('repository not found');
  });
});
