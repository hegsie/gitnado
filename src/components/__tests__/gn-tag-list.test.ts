/**
 * Comprehensive tests for gn-tag-list component.
 *
 * These render the REAL gn-tag-list component, mock only the Tauri invoke
 * layer, and verify the actual component code calls the right commands in the
 * right order.
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
import type { GnTagList } from '../sidebar/gn-tag-list.ts';
import '../sidebar/gn-tag-list.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';
const now = Math.floor(Date.now() / 1000);

const mockTags = [
  { name: 'v2.1.0', targetOid: 'aaa', message: 'Release 2.1', tagger: { name: 'Dev', email: 'dev@test.com', timestamp: now - 86400 }, isAnnotated: true },
  { name: 'v2.0.0', targetOid: 'bbb', message: 'Release 2.0', tagger: { name: 'Dev', email: 'dev@test.com', timestamp: now - 172800 }, isAnnotated: true },
  { name: 'v1.0.0', targetOid: 'ccc', message: 'Release 1.0', tagger: { name: 'Dev', email: 'dev@test.com', timestamp: now - 259200 }, isAnnotated: true },
  { name: 'beta', targetOid: 'ddd', message: null, tagger: null, isAnnotated: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(tags = mockTags): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_tags':
        return tags;
      case 'delete_tag':
        return null;
      case 'push_tag':
        return null;
      case 'checkout_with_autostash':
        return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'ok' };
      // plugin-dialog 2.7 routes confirm() through `message` and returns the
      // clicked button label; 'Ok' means the user confirmed.
      case 'plugin:dialog|message':
        return 'Ok';
      default:
        return null;
    }
  };
}

async function renderTagList(): Promise<GnTagList> {
  const el = await fixture<GnTagList>(
    html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-tag-list', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
  });

  // ── 1. Rendering ──────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders tags as .tag-item elements with correct count', async () => {
      const el = await renderTagList();

      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      expect(tagItems.length).to.equal(mockTags.length);
    });

    it('each tag shows .tag-name with tag name text', async () => {
      const el = await renderTagList();

      const tagNames = el.shadowRoot!.querySelectorAll('.tag-name');
      const names = Array.from(tagNames).map((n) => n.textContent?.trim());
      // Default sort is by name, so: beta, v1.0.0, v2.0.0, v2.1.0
      // But grouping may reorder; check all names are present
      for (const tag of mockTags) {
        expect(names).to.include(tag.name);
      }
    });

    it('annotated tags show .tag-type as "annotated"', async () => {
      const el = await renderTagList();

      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      const annotatedItem = Array.from(tagItems).find(
        (item) => item.querySelector('.tag-name')?.textContent?.trim() === 'v2.1.0'
      );
      expect(annotatedItem).to.not.be.null;
      const tagType = annotatedItem!.querySelector('.tag-type');
      expect(tagType?.textContent?.trim()).to.equal('annotated');
    });

    it('lightweight tags show .tag-type as "lightweight"', async () => {
      const el = await renderTagList();

      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      const lightweightItem = Array.from(tagItems).find(
        (item) => item.querySelector('.tag-name')?.textContent?.trim() === 'beta'
      );
      expect(lightweightItem).to.not.be.null;
      const tagType = lightweightItem!.querySelector('.tag-type');
      expect(tagType?.textContent?.trim()).to.equal('lightweight');
    });
  });

  // ── 2. Filter UI ─────────────────────────────────────────────────────
  describe('filter UI', () => {
    it('click filter button shows .filter-bar', async () => {
      const el = await renderTagList();

      // Initially no filter bar
      expect(el.shadowRoot!.querySelector('.filter-bar')).to.be.null;

      // Click the filter controls-btn
      const filterBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[0] as HTMLButtonElement;
      filterBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.filter-bar')).to.not.be.null;
    });

    it('type in .filter-input filters to only matching tags', async () => {
      const el = await renderTagList();

      // Open filter
      const filterBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[0] as HTMLButtonElement;
      filterBtn.click();
      await el.updateComplete;

      // Type in filter input
      const input = el.shadowRoot!.querySelector('.filter-input') as HTMLInputElement;
      input.value = 'v2';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      expect(tagItems.length).to.equal(2);
      const names = Array.from(tagItems).map((t) => t.querySelector('.tag-name')?.textContent?.trim());
      expect(names).to.include('v2.1.0');
      expect(names).to.include('v2.0.0');
    });

    it('click .filter-clear shows all tags again', async () => {
      const el = await renderTagList();

      // Open filter and type
      const filterBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[0] as HTMLButtonElement;
      filterBtn.click();
      await el.updateComplete;

      const input = el.shadowRoot!.querySelector('.filter-input') as HTMLInputElement;
      input.value = 'v2';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Click clear
      const clearBtn = el.shadowRoot!.querySelector('.filter-clear') as HTMLButtonElement;
      expect(clearBtn).to.not.be.null;
      clearBtn.click();
      await el.updateComplete;

      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      expect(tagItems.length).to.equal(mockTags.length);
    });
  });

  // ── 3. Sort UI ────────────────────────────────────────────────────────
  describe('sort UI', () => {
    it('click sort button shows .sort-menu', async () => {
      const el = await renderTagList();

      expect(el.shadowRoot!.querySelector('.sort-menu')).to.be.null;

      // Sort button is the second controls-btn
      const sortBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[1] as HTMLButtonElement;
      sortBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.sort-menu')).to.not.be.null;
    });

    it('click "Date (Newest)" sorts by date descending', async () => {
      const el = await renderTagList();

      // Open sort menu
      const sortBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[1] as HTMLButtonElement;
      sortBtn.click();
      await el.updateComplete;

      // Click "Date (Newest)"
      const sortOptions = el.shadowRoot!.querySelectorAll('.sort-option');
      const dateNewest = Array.from(sortOptions).find(
        (opt) => opt.textContent?.trim().includes('Date (Newest)')
      ) as HTMLButtonElement;
      expect(dateNewest).to.not.be.undefined;
      dateNewest.click();
      await el.updateComplete;

      // After sorting by date newest, v2.1.0 should come first (most recent timestamp)
      // Lightweight tags (beta) sort to end when sorting by date
      const tagNames = el.shadowRoot!.querySelectorAll('.tag-name');
      const names = Array.from(tagNames).map((n) => n.textContent?.trim());
      expect(names[0]).to.equal('v2.1.0');
      expect(names[names.length - 1]).to.equal('beta');
    });

    it('active sort has .active class on .sort-option', async () => {
      const el = await renderTagList();

      // Open sort menu
      const sortBtn = el.shadowRoot!.querySelectorAll('.controls-btn')[1] as HTMLButtonElement;
      sortBtn.click();
      await el.updateComplete;

      // Default sort is "name", so "Name (A-Z)" should be active
      const activeOption = el.shadowRoot!.querySelector('.sort-option.active');
      expect(activeOption).to.not.be.null;
      expect(activeOption!.textContent?.trim()).to.include('Name (A-Z)');
    });
  });

  // ── 4. Version grouping ──────────────────────────────────────────────
  describe('version grouping', () => {
    it('tags with version prefixes show .group-header with group name', async () => {
      const el = await renderTagList();

      const groupHeaders = el.shadowRoot!.querySelectorAll('.group-header');
      // Should have groups: v2.x, v1.x, Other (for "beta")
      expect(groupHeaders.length).to.be.greaterThanOrEqual(2);

      const groupNames = Array.from(groupHeaders).map(
        (h) => h.querySelector('.group-name')?.textContent?.trim()
      );
      expect(groupNames).to.include('v2.x');
      expect(groupNames).to.include('v1.x');
    });

    it('click .group-header collapses group (.chevron loses .expanded)', async () => {
      const el = await renderTagList();

      const groupHeaders = el.shadowRoot!.querySelectorAll('.group-header');
      const firstHeader = groupHeaders[0] as HTMLElement;

      // Initially expanded
      const chevronBefore = firstHeader.querySelector('.chevron');
      expect(chevronBefore!.classList.contains('expanded')).to.be.true;

      // Click to collapse
      firstHeader.click();
      await el.updateComplete;

      const chevronAfter = el.shadowRoot!.querySelectorAll('.group-header')[0].querySelector('.chevron');
      expect(chevronAfter!.classList.contains('expanded')).to.be.false;
    });

    it('group shows correct count in .group-count', async () => {
      const el = await renderTagList();

      const groupHeaders = el.shadowRoot!.querySelectorAll('.group-header');
      // Find the v2.x group
      const v2Header = Array.from(groupHeaders).find(
        (h) => h.querySelector('.group-name')?.textContent?.trim() === 'v2.x'
      );
      expect(v2Header).to.not.be.undefined;
      const count = v2Header!.querySelector('.group-count')?.textContent?.trim();
      expect(count).to.equal('2');
    });
  });

  // ── 5. Context menu ──────────────────────────────────────────────────
  describe('context menu', () => {
    it('right-click tag shows .context-menu', async () => {
      const el = await renderTagList();

      expect(el.shadowRoot!.querySelector('.context-menu')).to.be.null;

      const tagItem = el.shadowRoot!.querySelector('.tag-item') as HTMLElement;
      tagItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.context-menu')).to.not.be.null;
    });

    it('menu has "Checkout", "Push to Remote", "Delete" items', async () => {
      const el = await renderTagList();

      const tagItem = el.shadowRoot!.querySelector('.tag-item') as HTMLElement;
      tagItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const labels = Array.from(menuItems).map((item) => item.textContent?.trim());
      expect(labels).to.include('Checkout');
      expect(labels).to.include('Push to Remote');
      expect(labels).to.include('Delete');
    });

    it('Delete has .danger class', async () => {
      const el = await renderTagList();

      const tagItem = el.shadowRoot!.querySelector('.tag-item') as HTMLElement;
      tagItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const deleteBtn = Array.from(menuItems).find(
        (item) => item.textContent?.trim() === 'Delete'
      );
      expect(deleteBtn).to.not.be.undefined;
      expect(deleteBtn!.classList.contains('danger')).to.be.true;
    });

    it('click "Delete" calls delete_tag with correct tag name', async () => {
      const el = await renderTagList();

      // Find the tag item for v2.1.0
      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      const targetItem = Array.from(tagItems).find(
        (item) => item.querySelector('.tag-name')?.textContent?.trim() === 'v2.1.0'
      ) as HTMLElement;
      expect(targetItem).to.not.be.undefined;

      targetItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      clearHistory();

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const deleteBtn = Array.from(menuItems).find(
        (item) => item.textContent?.trim() === 'Delete'
      ) as HTMLElement;
      deleteBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const deleteCalls = findCommands('delete_tag');
      expect(deleteCalls.length).to.equal(1);
      expect(deleteCalls[0].args).to.deep.include({ name: 'v2.1.0', path: REPO_PATH });
    });
  });

  // ── 6. Tag operations ────────────────────────────────────────────────
  describe('tag operations', () => {
    it('delete tag calls delete_tag command then reloads tags', async () => {
      const el = await renderTagList();

      const tagItem = el.shadowRoot!.querySelector('.tag-item') as HTMLElement;
      tagItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      clearHistory();

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const deleteBtn = Array.from(menuItems).find(
        (item) => item.textContent?.trim() === 'Delete'
      ) as HTMLElement;
      deleteBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Should have called delete_tag then get_tags to reload
      const deleteCalls = findCommands('delete_tag');
      expect(deleteCalls.length).to.equal(1);

      const getTagsCalls = findCommands('get_tags');
      expect(getTagsCalls.length).to.be.greaterThan(0);
    });

    it('push tag calls push_tag command and dispatches tags-changed', async () => {
      // This repo HAS a remote, so the menu names it and pushes there. The
      // default mock reports none at all, and a repo with nowhere to push is
      // told to add a remote instead of pushing.
      const withoutRemotes = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_remotes') {
          return [{ name: 'origin', url: 'https://example.test/origin.git', pushUrl: null }];
        }
        return withoutRemotes(command, args);
      };
      const el = await renderTagList();

      // Find the tag item for v2.1.0
      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      const targetItem = Array.from(tagItems).find(
        (item) => item.querySelector('.tag-name')?.textContent?.trim() === 'v2.1.0'
      ) as HTMLElement;
      targetItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      clearHistory();

      // Listen for the tags-changed event (not tag-pushed)
      let tagsChangedFired = false;
      el.addEventListener('tags-changed', () => { tagsChangedFired = true; });

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      // Prefix, not an exact label: the item reads "Push to Remote" until the
      // menu's remote read lands, then names the destination.
      const pushBtn = Array.from(menuItems).find(
        (item) => item.textContent?.trim().startsWith('Push to ')
      ) as HTMLElement;
      pushBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const pushCalls = findCommands('push_tag');
      expect(pushCalls.length).to.equal(1);
      expect(pushCalls[0].args).to.deep.include({
        name: 'v2.1.0',
        path: REPO_PATH,
        remote: 'origin',
      });

      // Verify it reloads tags and fires tags-changed (consistent with handleDeleteTag)
      const getTagsCalls = findCommands('get_tags');
      expect(getTagsCalls.length).to.be.greaterThan(0);
      expect(tagsChangedFired).to.be.true;
    });

    it('checkout tag calls checkout_with_autostash with the qualified tag ref', async () => {
      const el = await renderTagList();

      // Find the tag item for v2.1.0
      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      const targetItem = Array.from(tagItems).find(
        (item) => item.querySelector('.tag-name')?.textContent?.trim() === 'v2.1.0'
      ) as HTMLElement;
      targetItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await el.updateComplete;

      clearHistory();

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const checkoutBtn = Array.from(menuItems).find(
        (item) => item.textContent?.trim() === 'Checkout'
      ) as HTMLElement;
      checkoutBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const checkoutCalls = findCommands('checkout_with_autostash');
      expect(checkoutCalls.length).to.equal(1);
      // Fully qualified, not the bare name: the backend resolvers try
      // find_branch() before revparse_single(), so a bare name checks out a
      // same-named BRANCH when one exists — at a potentially different commit,
      // right after the user confirmed a "detached HEAD" warning.
      expect(checkoutCalls[0].args).to.deep.include({
        path: REPO_PATH,
        refName: 'refs/tags/v2.1.0',
      });
    });
  });

  // ── 7. Event dispatching ─────────────────────────────────────────────
  describe('event dispatching', () => {
    it('click tag dispatches tag-selected event', async () => {
      const el = await renderTagList();

      let selectedTag: unknown = null;
      el.addEventListener('tag-selected', ((e: CustomEvent) => {
        selectedTag = e.detail.tag;
      }) as EventListener);

      const tagItem = el.shadowRoot!.querySelector('.tag-item') as HTMLElement;
      tagItem.click();
      await el.updateComplete;

      expect(selectedTag).to.not.be.null;
    });

    it('tag-count-changed dispatched after loading with correct count', async () => {
      let receivedCount: number | null = null;

      // We need to listen before the element loads
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.addEventListener('tag-count-changed', ((e: CustomEvent) => {
        receivedCount = e.detail.count;
      }) as EventListener);

      const el = document.createElement('gn-tag-list') as GnTagList;
      container.appendChild(el);
      el.repositoryPath = REPO_PATH;

      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(receivedCount).to.equal(mockTags.length);

      // Clean up
      container.remove();
    });
  });

  // ── 8. Error handling ────────────────────────────────────────────────
  describe('error handling', () => {
    it('get_tags throws shows error state gracefully', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_tags') {
          throw new Error('Network error');
        }
        return null;
      };

      const el = await renderTagList();

      // Component should not be in loading state
      expect(el.shadowRoot!.querySelector('.loading')).to.be.null;
      // Tags should be empty since load failed
      const tagItems = el.shadowRoot!.querySelectorAll('.tag-item');
      expect(tagItems.length).to.equal(0);
    });
  });

  // ── 9. Empty state ──────────────────────────────────────────────────
  describe('empty state', () => {
    it('no tags shows .empty element', async () => {
      setupDefaultMocks([]);
      const el = await renderTagList();

      const empty = el.shadowRoot!.querySelector('.empty');
      expect(empty).to.not.be.null;
      expect(empty!.textContent?.trim()).to.equal('No tags');
    });
  });

  // ── 10. Loading state ────────────────────────────────────────────────
  describe('loading state', () => {
    it('shows .loading during initial fetch', async () => {
      // Make get_tags take a long time to respond
      mockInvoke = async (command: string) => {
        if (command === 'get_tags') {
          await new Promise((r) => setTimeout(r, 500));
          return mockTags;
        }
        return null;
      };

      const el = await fixture<GnTagList>(
        html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`
      );
      // Check immediately before the async loadTags completes
      await el.updateComplete;

      const loading = el.shadowRoot!.querySelector('.loading');
      expect(loading).to.not.be.null;
      expect(loading!.textContent?.trim()).to.include('Loading');
    });
  });
});
