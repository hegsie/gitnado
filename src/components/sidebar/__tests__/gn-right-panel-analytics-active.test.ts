/**
 * The right panel keeps <gn-analytics-panel> mounted inside a CSS-hidden tab,
 * so the panel cannot tell on its own whether it is on screen. It must be told,
 * otherwise a `repository-refresh` arriving while another tab is up either
 * pays for a full statistics walk nobody is looking at, or is dropped and the
 * numbers go stale forever.
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
import type { GnAnalyticsPanel } from '../../panels/gn-analytics-panel.ts';
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

describe('gn-right-panel analytics visibility', () => {
  beforeEach(() => {
    repositoryStore.getState().reset();
    repositoryStore.getState().addRepository(mockRepo('/test/repo'));
  });

  it('tells the analytics panel whether its tab is showing', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);
    await el.updateComplete;

    const panel = el.shadowRoot!.querySelector('gn-analytics-panel') as GnAnalyticsPanel;
    expect(panel).to.not.be.null;

    // Default tab is Changes — the analytics panel is mounted but hidden.
    expect(panel.active).to.equal(false);

    el.showAnalytics();
    await el.updateComplete;
    expect(panel.active).to.equal(true);

    el.showChanges();
    await el.updateComplete;
    expect(panel.active).to.equal(false);
  });
});
