/**
 * Tests for gn-left-panel component
 *
 * Tests section rendering, expand/collapse, event forwarding,
 * stash/tag count tracking, store subscription, and event dispatching.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { repositoryStore } from '../../../stores/repository.store.ts';
import '../gn-left-panel.ts';
import type { GnLeftPanel } from '../gn-left-panel.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function setupDefaultMocks(): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_branches':
        return [{ name: 'main', shorthand: 'main', isHead: true, isRemote: false, upstream: null, targetOid: 'abc', isStale: false }];
      case 'get_stashes':
        return [];
      case 'get_tags':
        return [];
      case 'get_remotes':
        return [];
      case 'get_status':
        return [];
      default:
        return null;
    }
  };
}

function setupStore(): void {
  repositoryStore.getState().addRepository({
    path: REPO_PATH,
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: null,
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  });
}

async function renderPanel(): Promise<GnLeftPanel> {
  const el = await fixture<GnLeftPanel>(html`
    <gn-left-panel></gn-left-panel>
  `);
  await new Promise(r => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-left-panel', () => {
  beforeEach(() => {
    setupDefaultMocks();
    setupStore();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders without errors', async () => {
      const el = await renderPanel();
      expect(el).to.exist;
      expect(el.tagName.toLowerCase()).to.equal('gn-left-panel');
    });

    it('shows placeholder when no repository is open', async () => {
      repositoryStore.getState().reset();
      const el = await renderPanel();

      const placeholder = el.shadowRoot!.querySelector('.placeholder');
      expect(placeholder).to.exist;
      expect(placeholder!.textContent).to.include('No repository open');
    });

    it('shows branches section when repository is open', async () => {
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const headerTexts = Array.from(sectionHeaders).map(h => h.textContent!.trim());
      expect(headerTexts.some(t => t.includes('Branches'))).to.be.true;
    });

    it('shows tags section header', async () => {
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const headerTexts = Array.from(sectionHeaders).map(h => h.textContent!.trim());
      expect(headerTexts.some(t => t.includes('Tags'))).to.be.true;
    });

    it('renders gn-branch-list component', async () => {
      const el = await renderPanel();

      const branchList = el.shadowRoot!.querySelector('gn-branch-list');
      expect(branchList).to.exist;
    });

    it('renders gn-stash-list component (hidden when no stashes)', async () => {
      const el = await renderPanel();

      const stashList = el.shadowRoot!.querySelector('gn-stash-list');
      expect(stashList).to.exist;
    });

    it('renders gn-tag-list component', async () => {
      const el = await renderPanel();

      const tagList = el.shadowRoot!.querySelector('gn-tag-list');
      expect(tagList).to.exist;
    });

    it('shows Git Flow section header', async () => {
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const headerTexts = Array.from(sectionHeaders).map(h => h.textContent!.trim());
      expect(headerTexts.some(t => t.includes('Git Flow'))).to.be.true;
    });

    it('renders gn-gitflow-panel component with the repository path', async () => {
      const el = await renderPanel();

      const gitflowPanel = el.shadowRoot!.querySelector('gn-gitflow-panel') as HTMLElement & { repositoryPath: string };
      expect(gitflowPanel).to.exist;
      expect(gitflowPanel.repositoryPath).to.equal(REPO_PATH);
    });
  });

  // ── Section expand/collapse ────────────────────────────────────────────
  describe('section expand/collapse', () => {
    it('branches section is expanded by default', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { expandedSections: Set<string> };
      expect(internal.expandedSections.has('branches')).to.be.true;
    });

    it('stashes section is collapsed by default', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { expandedSections: Set<string> };
      expect(internal.expandedSections.has('stashes')).to.be.false;
    });

    it('tags section is collapsed by default', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { expandedSections: Set<string> };
      expect(internal.expandedSections.has('tags')).to.be.false;
    });

    it('toggles section on header click', async () => {
      const el = await renderPanel();

      // Click the branches header to collapse it
      const branchesHeader = el.shadowRoot!.querySelectorAll('.section-header')[0] as HTMLElement;
      branchesHeader.click();
      await el.updateComplete;

      const internal = el as unknown as { expandedSections: Set<string> };
      expect(internal.expandedSections.has('branches')).to.be.false;

      // Click again to expand
      branchesHeader.click();
      await el.updateComplete;
      expect(internal.expandedSections.has('branches')).to.be.true;
    });

    it('toggleSection adds and removes from expanded set', async () => {
      const el = await renderPanel();
      const toggleSection = (el as unknown as {
        toggleSection: (section: string) => void;
      }).toggleSection.bind(el);

      const internal = el as unknown as { expandedSections: Set<string> };

      // Initially not expanded
      expect(internal.expandedSections.has('stashes')).to.be.false;

      // Toggle on
      toggleSection('stashes');
      expect(internal.expandedSections.has('stashes')).to.be.true;

      // Toggle off
      toggleSection('stashes');
      expect(internal.expandedSections.has('stashes')).to.be.false;
    });

    it('collapsed section has collapsed class', async () => {
      const el = await renderPanel();

      // Tags section should be collapsed by default (not in expandedSections)
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const collapsedSections = Array.from(sections).filter(s => s.classList.contains('collapsed'));
      expect(collapsedSections.length).to.be.greaterThan(0);
    });
  });

  // ── Stash count tracking ───────────────────────────────────────────────
  describe('stash count tracking', () => {
    it('updates stash count on stash-count-changed event', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { stashCount: number };

      const handleStashCountChanged = (el as unknown as {
        handleStashCountChanged: (e: CustomEvent<{ count: number }>) => void;
      }).handleStashCountChanged.bind(el);

      handleStashCountChanged(
        new CustomEvent('stash-count-changed', { detail: { count: 3 } })
      );

      expect(internal.stashCount).to.equal(3);
    });

    it('shows stash section when stash count > 0', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { stashCount: number };
      internal.stashCount = 2;
      await el.updateComplete;

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const stashHeader = Array.from(sectionHeaders).find(h =>
        h.textContent!.includes('Stashes')
      );
      expect(stashHeader).to.exist;

      // Should show count badge
      const countBadge = stashHeader!.querySelector('.count');
      expect(countBadge).to.exist;
      expect(countBadge!.textContent!.trim()).to.equal('2');
    });
  });

  // ── Tag count tracking ─────────────────────────────────────────────────
  describe('tag count tracking', () => {
    it('updates tag count on tag-count-changed event', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { tagCount: number };

      const handleTagCountChanged = (el as unknown as {
        handleTagCountChanged: (e: CustomEvent<{ count: number }>) => void;
      }).handleTagCountChanged.bind(el);

      handleTagCountChanged(
        new CustomEvent('tag-count-changed', { detail: { count: 5 } })
      );

      expect(internal.tagCount).to.equal(5);
    });

    it('shows tag count badge when tags exist', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { tagCount: number };
      internal.tagCount = 7;
      await el.updateComplete;

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const tagHeader = Array.from(sectionHeaders).find(h =>
        h.textContent!.includes('Tags')
      );
      const countBadge = tagHeader!.querySelector('.count');
      expect(countBadge).to.exist;
      expect(countBadge!.textContent!.trim()).to.equal('7');
    });
  });

  // ── Event forwarding ──────────────────────────────────────────────────
  describe('event forwarding', () => {
    it('dispatches repository-changed on branch checkout', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleBranchCheckout = (el as unknown as {
        handleBranchCheckout: () => void;
      }).handleBranchCheckout.bind(el);

      handleBranchCheckout();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on branches changed', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleBranchesChanged = (el as unknown as {
        handleBranchesChanged: () => void;
      }).handleBranchesChanged.bind(el);

      handleBranchesChanged();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on stash applied', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleStashApplied = (el as unknown as {
        handleStashApplied: () => void;
      }).handleStashApplied.bind(el);

      handleStashApplied();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on stash created', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleStashCreated = (el as unknown as {
        handleStashCreated: () => void;
      }).handleStashCreated.bind(el);

      handleStashCreated();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on stash dropped', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleStashDropped = (el as unknown as {
        handleStashDropped: () => void;
      }).handleStashDropped.bind(el);

      handleStashDropped();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on tags changed', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleTagsChanged = (el as unknown as {
        handleTagsChanged: () => void;
      }).handleTagsChanged.bind(el);

      handleTagsChanged();
      expect(repoChangedFired).to.be.true;
    });

    it('dispatches repository-changed on tag checkout', async () => {
      const el = await renderPanel();

      let repoChangedFired = false;
      el.addEventListener('repository-changed', () => { repoChangedFired = true; });

      const handleTagCheckout = (el as unknown as {
        handleTagCheckout: () => void;
      }).handleTagCheckout.bind(el);

      handleTagCheckout();
      expect(repoChangedFired).to.be.true;
    });
  });

  // ── Create tag ─────────────────────────────────────────────────────────
  describe('create tag', () => {
    it('dispatches create-tag event', async () => {
      const el = await renderPanel();

      let createTagFired = false;
      el.addEventListener('create-tag', () => { createTagFired = true; });

      const handleCreateTag = (el as unknown as {
        handleCreateTag: (e: Event) => void;
      }).handleCreateTag.bind(el);

      // Create a fake event with stopPropagation
      const fakeEvent = new Event('click');
      handleCreateTag(fakeEvent);

      expect(createTagFired).to.be.true;
    });

    it('renders create tag button in tags header', async () => {
      const el = await renderPanel();

      const sectionAction = el.shadowRoot!.querySelector('.section-action');
      expect(sectionAction).to.exist;
    });
  });

  // ── Store subscription ─────────────────────────────────────────────────
  describe('store subscription', () => {
    it('updates repositoryPath from store', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { repositoryPath: string | null };
      expect(internal.repositoryPath).to.equal(REPO_PATH);
    });

    it('shows placeholder after repository is removed from store', async () => {
      const el = await renderPanel();

      // Remove the repository
      repositoryStore.getState().reset();
      await new Promise(r => setTimeout(r, 50));
      await el.updateComplete;

      const internal = el as unknown as { repositoryPath: string | null };
      expect(internal.repositoryPath).to.be.null;
    });

    it('cleans up store subscription on disconnect', async () => {
      const el = await renderPanel();
      const internal = el as unknown as { unsubscribe?: () => void };
      expect(internal.unsubscribe).to.exist;

      // Disconnect
      el.disconnectedCallback();

      // Subscription should be cleaned up (we can't easily verify it was called,
      // but at least verify the method exists and doesn't throw)
    });
  });

  // ── Chevron rendering ──────────────────────────────────────────────────
  describe('chevron rendering', () => {
    it('renders expanded chevron for expanded sections', async () => {
      const el = await renderPanel();

      // Branches is expanded by default
      const expandedChevrons = el.shadowRoot!.querySelectorAll('.chevron.expanded');
      expect(expandedChevrons.length).to.be.greaterThan(0);
    });

    it('renders non-expanded chevron for collapsed sections', async () => {
      const el = await renderPanel();

      const allChevrons = el.shadowRoot!.querySelectorAll('.chevron');
      const collapsedChevrons = Array.from(allChevrons).filter(c => !c.classList.contains('expanded'));
      expect(collapsedChevrons.length).to.be.greaterThan(0);
    });
  });

  // The Stashes SECTION was `display: none` at count 0 — hidden in exactly the
  // state where a user goes looking for it: a dirty tree with nothing stashed
  // yet. That also made gn-stash-list's "Stash Changes" button and its "No
  // stashes" empty state unreachable, so stashing was keyboard-only for anyone
  // who had never stashed before.
  it('keeps the Stashes section reachable with no stashes', async () => {
    setupDefaultMocks();
    const el = await fixture<GnLeftPanel>(
      html`<gn-left-panel .repositoryPath=${REPO_PATH}></gn-left-panel>`
    );
    await el.updateComplete;

    expect((el as unknown as { stashCount: number }).stashCount).to.equal(0);

    const headers = Array.from(el.shadowRoot!.querySelectorAll('.section-header'));
    const stashHeader = headers.find((h) => /Stashes/.test(h.textContent ?? ''));
    expect(stashHeader, 'the Stashes header must exist').to.not.be.undefined;

    const section = stashHeader!.closest('section') as HTMLElement;
    expect(
      section.style.display,
      'the section must not be hidden when the repo has no stashes'
    ).to.not.equal('none');
  });
});
