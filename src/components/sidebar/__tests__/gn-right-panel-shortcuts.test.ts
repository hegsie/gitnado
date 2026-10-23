/**
 * Tests for the right panel's tab-switching shortcuts.
 *
 * The panel uses Ctrl+Shift+1/2/3 — plain Ctrl+digit belongs to the GLOBAL
 * repository-tab shortcuts, so the panel must not react to it (one chord,
 * one meaning).
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnRightPanel } from '../gn-right-panel.ts';
import '../gn-right-panel.ts';
import { repositoryStore } from '../../../stores/index.ts';
import type { Repository } from '../../../types/git.types.ts';

function mockRepo(path: string): Repository {
  return {
    path,
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

function pressKey(el: GnRightPanel, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('gn-right-panel tab shortcuts', () => {
  beforeEach(() => {
    repositoryStore.getState().reset();
    repositoryStore.getState().addRepository(mockRepo('/test/repo'));
  });

  it('Ctrl+Shift+2 switches to the Details tab', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);

    pressKey(el, { code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true });
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).activeTab).to.equal('details');
  });

  it('Ctrl+Shift+3 switches to Analytics, Ctrl+Shift+1 back to Changes', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);

    pressKey(el, { code: 'Digit3', key: '#', ctrlKey: true, shiftKey: true });
    await el.updateComplete;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).activeTab).to.equal('analytics');

    pressKey(el, { code: 'Digit1', key: '!', ctrlKey: true, shiftKey: true });
    await el.updateComplete;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).activeTab).to.equal('changes');
  });

  it('plain Ctrl+digit is ignored (reserved for repository tabs)', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);

    pressKey(el, { code: 'Digit2', key: '2', ctrlKey: true });
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).activeTab).to.equal('changes');
  });

  it('advertises the shifted chord in its tooltips', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);

    const tabs = Array.from(el.shadowRoot!.querySelectorAll('.tab-bar .tab'));
    expect(tabs.map((t) => t.getAttribute('title'))).to.deep.equal([
      'Working Changes (Ctrl+Shift+1)',
      'Commit Details (Ctrl+Shift+2)',
      'Repository Analytics (Ctrl+Shift+3)',
    ]);
  });
});
