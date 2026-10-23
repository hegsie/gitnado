/**
 * Unit tests for the gn-graph-canvas empty / loading / error states.
 *
 * A freshly initialised repository walks to zero commits: the canvas paints
 * nothing, so the component must say "No commits yet" instead of leaving a
 * blank pane announcing "Loading commit graph..." forever. A failed load must
 * offer a Retry that actually re-runs the walk.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { Commit } from '../../../types/git.types.ts';

import '../gn-graph-canvas.ts';
import type { GnGraphCanvas } from '../gn-graph-canvas.ts';
import { clearGraphCacheForTests } from '../gn-graph-canvas.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const EMPTY_REPO = '/test/empty-repo';

function makeCommit(index: number): Commit {
  const oid = index.toString(16).padStart(40, '0');
  return {
    oid,
    shortId: oid.slice(0, 7),
    message: `Commit ${index}`,
    summary: `Commit ${index}`,
    body: null,
    author: { name: 'Test User', email: 'test@example.com', timestamp: 1700000000 - index },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: 1700000000 - index },
    parentIds: index > 0 ? [(index - 1).toString(16).padStart(40, '0')] : [],
    timestamp: 1700000000 - index,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
interface CanvasInternals {
  isLoading: boolean;
  loadError: string | null;
  hasCompletedLoad: boolean;
  totalLoadedCommits: number;
  loadCommits: (options?: { background?: boolean }) => Promise<void>;
}

function internals(el: GnGraphCanvas): CanvasInternals {
  return el as unknown as CanvasInternals;
}

/** Mock invoke that answers every command the graph load touches */
function setMocks(opts: { commits?: Commit[]; historyError?: string } = {}): void {
  const commits = opts.commits ?? [];
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_commit_history':
        if (opts.historyError) throw new Error(opts.historyError);
        return commits;
      case 'get_commit_total':
        return commits.length;
      case 'get_refs_by_commit':
        return {};
      case 'detect_github_repo':
        return null;
      case 'get_commits_stats':
      case 'get_commits_signatures':
      case 'search_commits':
        return [];
      default:
        return null;
    }
  };
}

async function renderCanvas(path = EMPTY_REPO): Promise<GnGraphCanvas> {
  const el = await fixture<GnGraphCanvas>(
    html`<gn-graph-canvas .repositoryPath=${path}></gn-graph-canvas>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 200));
  await el.updateComplete;
  return el;
}

function emptyPanel(el: GnGraphCanvas): Element | null {
  return el.shadowRoot!.querySelector('.graph-overlay.empty-state');
}

function loadingPanel(el: GnGraphCanvas): Element | null {
  return el.shadowRoot!.querySelector('.graph-overlay.loading-state');
}

function errorPanel(el: GnGraphCanvas): Element | null {
  return el.shadowRoot!.querySelector('.info-panel.error-panel');
}

function retryButton(el: GnGraphCanvas): HTMLButtonElement | null {
  return el.shadowRoot!.querySelector('.error-panel .retry-btn');
}

function ariaLabel(el: GnGraphCanvas): string | null {
  return el.shadowRoot!.querySelector('canvas[role="img"]')!.getAttribute('aria-label');
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-graph-canvas empty state and load retry', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    clearGraphCacheForTests();
    setMocks();
  });

  describe('empty state', () => {
    it('shows "No commits yet" when the walk returns zero commits', async () => {
      const el = await renderCanvas();

      expect(internals(el).totalLoadedCommits).to.equal(0);
      const panel = emptyPanel(el);
      expect(panel).to.not.be.null;
      expect(panel!.textContent).to.include('No commits yet');
    });

    it('points the user at the commit panel', async () => {
      const el = await renderCanvas();

      const hint = el.shadowRoot!.querySelector('.graph-overlay .overlay-hint');
      expect(hint).to.not.be.null;
      const text = hint!.textContent!.replace(/\s+/g, ' ').trim();
      expect(text).to.include('Stage a file');
      expect(text).to.include('Commit panel');
    });

    it('is NOT shown while the first load is still in flight', async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockInvoke = async (command: string) => {
        if (command === 'get_commit_history') {
          await gate;
          return [];
        }
        if (command === 'get_refs_by_commit') return {};
        return null;
      };

      const el = await fixture<GnGraphCanvas>(
        html`<gn-graph-canvas .repositoryPath=${EMPTY_REPO}></gn-graph-canvas>`
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(internals(el).isLoading).to.be.true;
      expect(emptyPanel(el)).to.be.null;
      expect(loadingPanel(el)).to.not.be.null;

      release!();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(loadingPanel(el)).to.be.null;
      expect(emptyPanel(el)).to.not.be.null;
    });

    it('is not shown when the repository has commits', async () => {
      setMocks({ commits: [makeCommit(2), makeCommit(1), makeCommit(0)] });
      const el = await renderCanvas('/test/repo-with-commits');

      expect(internals(el).totalLoadedCommits).to.equal(3);
      expect(emptyPanel(el)).to.be.null;
    });

    it('is not shown when the load failed (the error panel owns that state)', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      expect(internals(el).loadError).to.contain('walk exploded');
      expect(emptyPanel(el)).to.be.null;
      expect(errorPanel(el)).to.not.be.null;
    });

    it('is not shown when no repository path is set', async () => {
      const el = await fixture<GnGraphCanvas>(
        html`<gn-graph-canvas .repositoryPath=${''}></gn-graph-canvas>`
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(emptyPanel(el)).to.be.null;
      expect(errorPanel(el)).to.not.be.null;
    });

    it('disappears once commits arrive on a later load', async () => {
      const el = await renderCanvas();
      expect(emptyPanel(el)).to.not.be.null;

      setMocks({ commits: [makeCommit(0)] });
      await internals(el).loadCommits();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(emptyPanel(el)).to.be.null;
      expect(internals(el).totalLoadedCommits).to.equal(1);
    });
  });

  describe('canvas aria-label', () => {
    it('announces "No commits" for an empty repository', async () => {
      const el = await renderCanvas();

      expect(ariaLabel(el)).to.equal('No commits');
    });

    it('announces the loading state only while a load is in flight', async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockInvoke = async (command: string) => {
        if (command === 'get_commit_history') {
          await gate;
          return [];
        }
        if (command === 'get_refs_by_commit') return {};
        return null;
      };

      const el = await fixture<GnGraphCanvas>(
        html`<gn-graph-canvas .repositoryPath=${EMPTY_REPO}></gn-graph-canvas>`
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(ariaLabel(el)).to.equal('Loading commit graph...');

      release!();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(ariaLabel(el)).to.equal('No commits');
    });

    it('announces the commit count when commits are loaded', async () => {
      setMocks({ commits: [makeCommit(2), makeCommit(1), makeCommit(0)] });
      const el = await renderCanvas('/test/repo-with-commits');

      expect(ariaLabel(el)).to.contain('3');
      expect(ariaLabel(el)).to.contain('commits');
    });

    it('announces a failed load instead of a permanent loading state', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      expect(ariaLabel(el)).to.equal('Commit graph failed to load');
    });
  });

  describe('retry after a failed load', () => {
    it('renders a Retry button in the error panel', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      const button = retryButton(el);
      expect(button).to.not.be.null;
      expect(button!.textContent!.trim()).to.equal('Retry');
      expect(button!.disabled).to.be.false;
    });

    it('re-invokes the commit walk and clears the error on success', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');
      expect(internals(el).loadError).to.contain('walk exploded');

      // The repository becomes reachable again
      setMocks({ commits: [makeCommit(1), makeCommit(0)] });
      invokeHistory.length = 0;

      retryButton(el)!.click();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(invokeHistory.filter((h) => h.command === 'get_commit_history').length).to.be.greaterThan(0);
      expect(internals(el).loadError).to.be.null;
      expect(errorPanel(el)).to.be.null;
      expect(internals(el).totalLoadedCommits).to.equal(2);
    });

    it('keeps the error panel when the retry fails again', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      setMocks({ historyError: 'still broken' });
      invokeHistory.length = 0;

      retryButton(el)!.click();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(invokeHistory.filter((h) => h.command === 'get_commit_history').length).to.be.greaterThan(0);
      expect(internals(el).loadError).to.contain('still broken');
      const panel = errorPanel(el);
      expect(panel).to.not.be.null;
      expect(panel!.textContent).to.include('still broken');
      // Still retryable
      expect(retryButton(el)).to.not.be.null;
      expect(retryButton(el)!.disabled).to.be.false;
    });

    it('shows a loading state while the retry is in flight', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockInvoke = async (command: string) => {
        if (command === 'get_commit_history') {
          await gate;
          return [];
        }
        if (command === 'get_refs_by_commit') return {};
        return null;
      };

      retryButton(el)!.click();
      await el.updateComplete;

      expect(internals(el).isLoading).to.be.true;
      expect(loadingPanel(el)).to.not.be.null;
      expect(ariaLabel(el)).to.equal('Loading commit graph...');
      // The error banner is cleared for the duration of the retry
      expect(errorPanel(el)).to.be.null;

      release!();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(loadingPanel(el)).to.be.null;
      expect(emptyPanel(el)).to.not.be.null;
    });

    it('a failed load that recovers on retry leaves no empty-state panel behind', async () => {
      setMocks({ historyError: 'walk exploded' });
      const el = await renderCanvas('/test/failing-repo');

      setMocks({ commits: [makeCommit(0)] });
      retryButton(el)!.click();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(emptyPanel(el)).to.be.null;
      expect(errorPanel(el)).to.be.null;
      expect(ariaLabel(el)).to.contain('1');
    });
  });
});
