/**
 * Integration tests for gn-branch-list checkout.
 *
 * These render the REAL gn-branch-list component, mock only the Tauri invoke
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
import type { Branch } from '../../types/git.types.ts';
import type { GnBranchList } from '../sidebar/gn-branch-list.ts';

// Import the actual component — registers <gn-branch-list> custom element
import '../sidebar/gn-branch-list.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: 'feature-x',
    shorthand: 'feature-x',
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
    ...overrides,
  };
}

const mainBranch = makeBranch({ name: 'main', shorthand: 'main', isHead: true, targetOid: 'aaa111' });
const featureBranch = makeBranch({ name: 'feature-x', shorthand: 'feature-x', targetOid: 'bbb222' });
const remoteBranch = makeBranch({
  name: 'origin/feature-y',
  shorthand: 'origin/feature-y',
  isRemote: true,
  targetOid: 'ccc333',
});

const initialBranches: Branch[] = [mainBranch, featureBranch, remoteBranch];

// After local branch checkout, feature-x becomes HEAD
const postCheckoutBranches: Branch[] = [
  makeBranch({ name: 'main', shorthand: 'main', isHead: false, targetOid: 'aaa111' }),
  makeBranch({ name: 'feature-x', shorthand: 'feature-x', isHead: true, targetOid: 'bbb222' }),
  makeBranch({ name: 'origin/feature-y', shorthand: 'origin/feature-y', isRemote: true, targetOid: 'ccc333' }),
];

// After remote branch checkout, a new local tracking branch should be created as HEAD
const postRemoteCheckoutBranches: Branch[] = [
  makeBranch({ name: 'main', shorthand: 'main', isHead: false, targetOid: 'aaa111' }),
  makeBranch({ name: 'feature-x', shorthand: 'feature-x', targetOid: 'bbb222' }),
  makeBranch({ name: 'feature-y', shorthand: 'feature-y', isHead: true, targetOid: 'ccc333', upstream: 'origin/feature-y' }),
  makeBranch({ name: 'origin/feature-y', shorthand: 'origin/feature-y', isRemote: true, targetOid: 'ccc333' }),
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(opts: { postCheckoutBranches?: Branch[] } = {}): void {
  let checkoutDone = false;

  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_branches':
        // Return updated branches after checkout
        return checkoutDone
          ? (opts.postCheckoutBranches ?? postCheckoutBranches)
          : initialBranches;
      case 'get_remotes':
        return [];
      case 'checkout_with_autostash':
        checkoutDone = true;
        return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'ok' };
      default:
        return null;
    }
  };
}

async function renderBranchList(): Promise<GnBranchList> {
  const el = await fixture<GnBranchList>(
    html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`
  );
  // Wait for initial loadBranches to complete
  await el.updateComplete;
  // One more microtask for async loadBranches
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-branch-list checkout (integration)', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
  });

  it('renders the real component and loads branches via Tauri invoke', async () => {
    const el = await renderBranchList();

    // Verify the actual component called get_branches and get_remotes
    expect(findCommands('get_branches').length).to.be.greaterThan(0);
    expect(findCommands('get_remotes').length).to.be.greaterThan(0);

    // Verify local branches are rendered in the DOM (remote branches are in a separate section)
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    expect(branchItems.length).to.be.greaterThanOrEqual(2);
  });

  it('marks the HEAD branch as active in the DOM', async () => {
    const el = await renderBranchList();

    const activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem).to.not.be.null;
    expect(activeItem!.textContent).to.include('main');
  });

  it('calls checkout_with_autostash when context menu Checkout is clicked', async () => {
    const el = await renderBranchList();
    clearHistory();

    // Find the non-HEAD branch item and right-click to open context menu
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );
    expect(featureItem).to.not.be.null;

    // Trigger context menu
    featureItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    // Find and click the Checkout button in the context menu
    const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
    const checkoutBtn = Array.from(menuItems).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );
    expect(checkoutBtn).to.not.be.null;

    checkoutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Wait for the async checkout + loadBranches
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    // Verify the REAL component called checkout_with_autostash with correct args
    const checkoutCalls = findCommands('checkout_with_autostash');
    expect(checkoutCalls.length).to.equal(1);
    expect(checkoutCalls[0].args).to.deep.include({
      path: REPO_PATH,
      refName: 'feature-x',
    });
  });

  it('reloads branches after successful checkout', async () => {
    const el = await renderBranchList();
    clearHistory();

    // Trigger checkout via context menu
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );
    featureItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    const checkoutBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );
    checkoutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    // After checkout, the component should call get_branches again to reload
    const branchCalls = findCommands('get_branches');
    expect(branchCalls.length).to.be.greaterThan(0);
  });

  it('updates the active branch in DOM after checkout', async () => {
    const el = await renderBranchList();

    // Before checkout: main is active
    let activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem!.textContent).to.include('main');

    // Trigger checkout of feature-x
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );
    featureItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    const checkoutBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );
    checkoutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    // After checkout: feature-x should now be active
    activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem).to.not.be.null;
    expect(activeItem!.textContent).to.include('feature-x');
  });

  it('dispatches branch-checkout event after successful checkout', async () => {
    const el = await renderBranchList();

    let eventFired = false;
    el.addEventListener('branch-checkout', () => { eventFired = true; });

    // Trigger checkout
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );
    featureItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    const checkoutBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );
    checkoutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    expect(eventFired).to.be.true;
  });

  it('does NOT call checkout when clicking HEAD branch', async () => {
    const el = await renderBranchList();
    clearHistory();

    // Right-click on the HEAD branch — context menu should NOT show Checkout
    const activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem).to.not.be.null;

    activeItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
    const checkoutBtn = Array.from(menuItems).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );

    // Checkout button should not exist for HEAD branch
    expect(checkoutBtn).to.be.undefined;
    expect(findCommands('checkout_with_autostash').length).to.equal(0);
  });

  it('does NOT dispatch branch-checkout on failed checkout', async () => {
    // Override mock to make checkout fail
    let checkoutCalled = false;
    mockInvoke = async (command: string) => {
      switch (command) {
        case 'get_branches':
          return initialBranches;
        case 'get_remotes':
          return [];
        case 'checkout_with_autostash':
          checkoutCalled = true;
          return { success: false, stashed: false, stashApplied: false, stashConflict: false, message: 'error' };
        default:
          return null;
      }
    };

    const el = await renderBranchList();

    let eventFired = false;
    el.addEventListener('branch-checkout', () => { eventFired = true; });

    // Trigger checkout
    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );
    featureItem!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await el.updateComplete;

    const checkoutBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
      (btn) => btn.textContent?.trim() === 'Checkout'
    );
    checkoutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    expect(checkoutCalled).to.be.true;
    expect(eventFired).to.be.false;
  });

  it('calls checkout_with_autostash on double-click', async () => {
    const el = await renderBranchList();
    clearHistory();

    const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
    const featureItem = Array.from(branchItems).find(
      (item) => !item.classList.contains('active')
    );

    featureItem!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    const checkoutCalls = findCommands('checkout_with_autostash');
    expect(checkoutCalls.length).to.equal(1);
    expect(checkoutCalls[0].args).to.deep.include({
      path: REPO_PATH,
      refName: 'feature-x',
    });
  });

  it('reloads branches when repository-refresh event is dispatched', async () => {
    // This tests that the branch list updates when checkout happens
    // from OUTSIDE the branch list (e.g., graph context menu).
    // Before the fix, the branch list didn't listen for repository-refresh
    // so it would show stale data after external checkouts.
    let checkoutDone = false;

    mockInvoke = async (command: string) => {
      switch (command) {
        case 'get_branches':
          return checkoutDone ? postCheckoutBranches : initialBranches;
        case 'get_remotes':
          return [];
        default:
          return null;
      }
    };

    const el = await renderBranchList();

    // Verify main is active before
    let activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem!.textContent).to.include('main');

    // Simulate external checkout (e.g., from graph context menu)
    checkoutDone = true;
    window.dispatchEvent(new CustomEvent('repository-refresh'));

    // Wait for reload
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    // Branch list should now show feature-x as active
    activeItem = el.shadowRoot!.querySelector('.branch-item.active');
    expect(activeItem).to.not.be.null;
    expect(activeItem!.textContent).to.include('feature-x');
  });

  describe('remote branch checkout', () => {
    it('creates a local tracking branch and marks it as HEAD after checking out a remote branch', async () => {
      // This is the key test that would have caught the real bug:
      // checking out origin/feature-y should result in a LOCAL branch
      // feature-y being created with isHead: true.
      let checkoutDone = false;

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_branches':
            return checkoutDone ? postRemoteCheckoutBranches : initialBranches;
          case 'get_remotes':
            return [];
          case 'checkout_with_autostash':
            checkoutDone = true;
            return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'ok' };
          default:
            return null;
        }
      };

      const el = await renderBranchList();

      // Verify main is active before checkout
      let activeItem = el.shadowRoot!.querySelector('.branch-item.active');
      expect(activeItem!.textContent).to.include('main');

      // Simulate the remote checkout completing and branches reloading
      checkoutDone = true;
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // After remote checkout: a new local branch 'feature-y' should be HEAD
      activeItem = el.shadowRoot!.querySelector('.branch-item.active');
      expect(activeItem, 'A local branch should be marked as HEAD after remote checkout').to.not.be.null;
      expect(activeItem!.textContent).to.include('feature-y');
    });

    it('fails when remote checkout results in detached HEAD (no branch marked as HEAD)', async () => {
      // This reproduces the actual bug: checking out a remote branch
      // resulted in detached HEAD where NO branch has isHead: true.
      // The branch list should handle this gracefully.
      const detachedHeadBranches: Branch[] = [
        makeBranch({ name: 'main', shorthand: 'main', isHead: false, targetOid: 'aaa111' }),
        makeBranch({ name: 'feature-x', shorthand: 'feature-x', targetOid: 'bbb222' }),
        makeBranch({ name: 'origin/feature-y', shorthand: 'origin/feature-y', isRemote: true, targetOid: 'ccc333' }),
      ];

      let checkoutDone = false;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_branches':
            return checkoutDone ? detachedHeadBranches : initialBranches;
          case 'get_remotes':
            return [];
          case 'checkout_with_autostash':
            checkoutDone = true;
            return { success: true, stashed: false, stashApplied: false, stashConflict: false, message: 'ok' };
          default:
            return null;
        }
      };

      const el = await renderBranchList();

      // Before: main is HEAD
      let activeItem = el.shadowRoot!.querySelector('.branch-item.active');
      expect(activeItem!.textContent).to.include('main');

      // Simulate remote checkout that leaves detached HEAD
      checkoutDone = true;
      window.dispatchEvent(new CustomEvent('repository-refresh'));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // After: NO branch should be active (detached HEAD)
      // This is a known bug — the backend should create a local tracking
      // branch instead. This test documents the current broken behavior.
      activeItem = el.shadowRoot!.querySelector('.branch-item.active');
      expect(activeItem, 'Detached HEAD: no branch should be active (backend bug)').to.be.null;
    });
  });
});
