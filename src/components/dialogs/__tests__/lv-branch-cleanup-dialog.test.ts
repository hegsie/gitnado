/**
 * Branch Cleanup Dialog Tests (fixture-based)
 *
 * Renders the REAL lv-branch-cleanup-dialog component, mocks only the Tauri
 * invoke layer, and verifies actual DOM output for rendering, tabs, risk
 * badges, protection, selection, delete flow, prune option, and footer.
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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import type { CleanupCandidate } from '../../../types/git.types.ts';

// Import the actual component — registers <lv-branch-cleanup-dialog>
import '../lv-branch-cleanup-dialog.ts';
import type { LvBranchCleanupDialog } from '../lv-branch-cleanup-dialog.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function createCandidate(
  name: string,
  category: 'merged' | 'stale' | 'gone',
  overrides: Partial<CleanupCandidate> = {},
): CleanupCandidate {
  return {
    name,
    shorthand: name,
    category,
    lastCommitTimestamp: null,
    isProtected: false,
    upstream: null,
    aheadBehind: null,
    ...overrides,
  };
}

/**
 * The prune step lists the repo's remotes so it can route per-remote
 * credentials, so every mock that reaches a delete/prune run must answer
 * `get_remotes` — otherwise the prune fails before it is ever invoked.
 *
 * Two of them on purpose: the dialog prunes ALL remotes (it names none), so a
 * single-remote fixture would not notice the enumeration dropping every remote
 * but the first.
 */
const REMOTES = [
  { name: 'origin', url: 'https://github.com/acme/repo.git', pushUrl: null },
  { name: 'upstream', url: 'https://github.com/upstream/repo.git', pushUrl: null },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

/**
 * plugin-dialog 2.7 implements confirm() as a `plugin:dialog|message` call with
 * buttons: 'OkCancel', and compares the RETURNED BUTTON LABEL to 'Ok' — there
 * is no `plugin:dialog|confirm` command. So these mocks answer a confirm with
 * the string 'Ok'/'Cancel', not a boolean.
 */
function isConfirmCommand(command: string): boolean {
  return command === 'plugin:dialog|message';
}

function confirmResult(accepted: boolean): string {
  return accepted ? 'Ok' : 'Cancel';
}

/** Messages passed to showConfirm(), in order. */
function confirmMessages(): string[] {
  return invokeHistory
    .filter((h) => isConfirmCommand(h.command))
    .map((h) => (h.args as { message?: string })?.message ?? '');
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

/** Wait for the dialog's async load to complete after open(). */
async function settle(el: LvBranchCleanupDialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
}

async function renderAndOpen(
  candidates: CleanupCandidate[],
): Promise<LvBranchCleanupDialog> {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_cleanup_candidates':
        return candidates;
      case 'get_remotes':
        return REMOTES;
      case 'delete_branch':
        return undefined;
      case 'prune_remote_tracking_branches':
        return { success: true, branchesPruned: ['origin/gone'] };
      case 'plugin:notification|is_permission_granted':
        return false;
      case 'plugin:dialog|message':
        return confirmResult(true);
      default:
        return null;
    }
  };

  const el = await fixture<LvBranchCleanupDialog>(
    html`<lv-branch-cleanup-dialog .repositoryPath=${REPO_PATH}></lv-branch-cleanup-dialog>`,
  );
  await el.updateComplete;
  el.open();
  await settle(el);
  return el;
}

// ── Standard candidate sets ────────────────────────────────────────────────
const mergedSafe = createCandidate('feature/done', 'merged', {
  aheadBehind: { ahead: 0, behind: 2 },
});

const mergedWarning = createCandidate('feature/wip', 'merged', {
  aheadBehind: { ahead: 5, behind: 0 },
});

const staleSafe = createCandidate('feature/old', 'stale', {
  aheadBehind: { ahead: 0, behind: 0 },
  lastCommitTimestamp: 1600000000,
});

const staleWarning = createCandidate('feature/stale-wip', 'stale', {
  aheadBehind: { ahead: 3, behind: 0 },
  lastCommitTimestamp: 1600000000,
});

const goneSafe = createCandidate('feature/gone-safe', 'gone', {
  aheadBehind: { ahead: 0, behind: 0 },
  upstream: 'origin/feature/gone-safe',
});

const goneDanger = createCandidate('feature/gone-danger', 'gone', {
  aheadBehind: { ahead: 3, behind: 0 },
  upstream: 'origin/feature/gone-danger',
});

const protectedMainStale = createCandidate('main', 'stale', {
  aheadBehind: { ahead: 0, behind: 0 },
  lastCommitTimestamp: 1600000000,
});

const protectedMain = createCandidate('main', 'merged', {
  aheadBehind: { ahead: 0, behind: 0 },
});

const protectedMaster = createCandidate('master', 'merged', {
  aheadBehind: { ahead: 0, behind: 0 },
});

const allCandidates: CleanupCandidate[] = [
  mergedSafe,
  mergedWarning,
  protectedMain,
  protectedMaster,
  staleSafe,
  staleWarning,
  goneSafe,
  goneDanger,
];

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-branch-cleanup-dialog (fixture)', () => {
  beforeEach(() => {
    clearHistory();
    uiStore.setState({ toasts: [] });
    // Ensure settings store has staleBranchDays set
    settingsStore.setState({ staleBranchDays: 90 });
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('Rendering', () => {
    it('open() renders the dialog with tabs (Merged, Stale, Gone Upstream)', async () => {
      const el = await renderAndOpen(allCandidates);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      expect(tabs.length).to.equal(3);

      const tabTexts = Array.from(tabs).map((t) => t.textContent!.trim());
      expect(tabTexts.some((t) => t.includes('Merged'))).to.be.true;
      expect(tabTexts.some((t) => t.includes('Stale'))).to.be.true;
      expect(tabTexts.some((t) => t.includes('Gone Upstream'))).to.be.true;
    });

    it('tab badges show correct counts', async () => {
      const el = await renderAndOpen(allCandidates);

      const badges = el.shadowRoot!.querySelectorAll('.tab-badge');
      expect(badges.length).to.equal(3);

      // Merged: mergedSafe, mergedWarning, protectedMain, protectedMaster = 4
      expect(badges[0].textContent!.trim()).to.equal('4');
      // Stale: staleSafe, staleWarning = 2
      expect(badges[1].textContent!.trim()).to.equal('2');
      // Gone: goneSafe, goneDanger = 2
      expect(badges[2].textContent!.trim()).to.equal('2');
    });

    it('branch items render with .branch-name showing branch name', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const branchName = el.shadowRoot!.querySelector('.branch-name');
      expect(branchName).to.not.be.null;
      expect(branchName!.textContent!.trim()).to.equal('feature/done');
    });

    it('risk badges render with correct class (.risk-badge.safe, .risk-badge.warning, .risk-badge.danger)', async () => {
      // A merged branch is always safe (the backend proved HEAD descends from
      // it), so 'warning' is only reachable outside that category — use stale.
      const el = await renderAndOpen([staleSafe, staleWarning]);

      const safeBadge = el.shadowRoot!.querySelector('.risk-badge.safe');
      const warningBadge = el.shadowRoot!.querySelector('.risk-badge.warning');

      expect(safeBadge).to.not.be.null;
      expect(safeBadge!.textContent).to.include('Safe');
      expect(warningBadge).to.not.be.null;
      expect(warningBadge!.textContent).to.include('Warning');
    });

    it('protected branches show .protected-badge', async () => {
      const el = await renderAndOpen([protectedMain]);

      const protectedBadge = el.shadowRoot!.querySelector('.protected-badge');
      expect(protectedBadge).to.not.be.null;
      expect(protectedBadge!.textContent).to.include('Protected');
    });
  });

  // ── Loading state ──────────────────────────────────────────────────────
  describe('Loading state', () => {
    it('shows .loading with "Loading branches..." during fetch', async () => {
      // Use a slow mock that resolves after we check
      let resolveLoad!: (value: CleanupCandidate[]) => void;
      const slowPromise = new Promise<CleanupCandidate[]>((r) => {
        resolveLoad = r;
      });

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_cleanup_candidates':
            return slowPromise;
          case 'plugin:notification|is_permission_granted':
            return false;
          default:
            return null;
        }
      };

      const el = await fixture<LvBranchCleanupDialog>(
        html`<lv-branch-cleanup-dialog .repositoryPath=${REPO_PATH}></lv-branch-cleanup-dialog>`,
      );
      await el.updateComplete;
      el.open();
      await el.updateComplete;

      const loading = el.shadowRoot!.querySelector('.loading');
      expect(loading).to.not.be.null;
      expect(loading!.textContent).to.include('Loading branches...');

      // Resolve the promise so the test can clean up
      resolveLoad([]);
      await settle(el);
    });

    it('loading disappears after data loads', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const loading = el.shadowRoot!.querySelector('.loading');
      expect(loading).to.be.null;
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────
  describe('Empty state', () => {
    it('tab with no branches shows .empty-state', async () => {
      // Only put branches in merged, so stale tab is empty
      const el = await renderAndOpen([mergedSafe]);

      // Switch to stale tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
    });

    it('empty state has appropriate message text', async () => {
      const el = await renderAndOpen([mergedSafe]);

      // Switch to stale tab (which is empty)
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState!.textContent).to.include('No stale branches found');
    });
  });

  // ── Tab switching ──────────────────────────────────────────────────────
  describe('Tab switching', () => {
    it('clicking "Stale" tab button shows stale branches', async () => {
      const el = await renderAndOpen(allCandidates);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const branchNames = el.shadowRoot!.querySelectorAll('.branch-name');
      const names = Array.from(branchNames).map((n) => n.textContent!.trim());
      expect(names).to.include('feature/old');
      expect(names).to.include('feature/stale-wip');
      expect(names).to.not.include('feature/done');
    });

    it('clicking "Gone Upstream" tab shows gone branches', async () => {
      const el = await renderAndOpen(allCandidates);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const goneTab = Array.from(tabs).find((t) => t.textContent!.includes('Gone Upstream'));
      goneTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const branchNames = el.shadowRoot!.querySelectorAll('.branch-name');
      const names = Array.from(branchNames).map((n) => n.textContent!.trim());
      expect(names).to.include('feature/gone-safe');
      expect(names).to.include('feature/gone-danger');
      expect(names).to.not.include('feature/done');
    });

    it('active tab has .active class', async () => {
      const el = await renderAndOpen(allCandidates);

      // Initially merged tab is active
      let activeTab = el.shadowRoot!.querySelector('.tab.active');
      expect(activeTab).to.not.be.null;
      expect(activeTab!.textContent).to.include('Merged');

      // Switch to stale
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      activeTab = el.shadowRoot!.querySelector('.tab.active');
      expect(activeTab).to.not.be.null;
      expect(activeTab!.textContent).to.include('Stale');
    });
  });

  // ── Risk assessment via DOM ────────────────────────────────────────────
  describe('Risk assessment via DOM', () => {
    it('branch with ahead: 0 shows .risk-badge.safe', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const safeBadge = el.shadowRoot!.querySelector('.risk-badge.safe');
      expect(safeBadge).to.not.be.null;
      expect(safeBadge!.textContent).to.include('Safe');
    });

    it('unmerged branch with unpushed commits shows .risk-badge.warning', async () => {
      const el = await renderAndOpen([staleWarning]);

      const warningBadge = el.shadowRoot!.querySelector('.risk-badge.warning');
      expect(warningBadge).to.not.be.null;
      expect(warningBadge!.textContent).to.include('Warning');
    });

    it('merged branch with measured unpushed commits stays .risk-badge.safe', async () => {
      // `ahead` measures distance from the UPSTREAM, which says nothing about
      // whether deleting the local ref loses work. The backend already proved
      // HEAD descends from this branch, so nothing is lost.
      const mergedUnpushed = createCandidate('feature/x', 'merged', {
        aheadBehind: { ahead: 3, behind: 0 },
        upstream: 'origin/feature/x',
      });
      const el = await renderAndOpen([mergedUnpushed]);

      const safeBadge = el.shadowRoot!.querySelector('.risk-badge.safe');
      expect(safeBadge, 'a merged branch is safe regardless of upstream drift').to.not.be.null;
    });

    it('gives one branch the same risk in every tab it appears in', async () => {
      // The backend emits a branch once per qualifying category. Risk belongs
      // to the branch, so the merged proof must win in the Stale tab too —
      // otherwise the same branch reads green on one tab and amber on another.
      const name = 'feature/old-and-merged';
      const el = await renderAndOpen([
        createCandidate(name, 'merged', { aheadBehind: null, upstream: null }),
        createCandidate(name, 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      expect(
        el.shadowRoot!.querySelector('.risk-badge.warning'),
        'the merged proof must apply in the Stale tab too',
      ).to.be.null;
      expect(el.shadowRoot!.querySelector('.risk-badge.safe')).to.not.be.null;
    });

    it('merged branch with no upstream stays .risk-badge.safe', async () => {
      // The backend proved it merged (graph_descendant_of) to put it in the
      // 'merged' category; a missing upstream comparison must not override that
      // and label it risky.
      const mergedNoUpstream = createCandidate('feature/done', 'merged', {
        aheadBehind: null,
        upstream: null,
      });
      const el = await renderAndOpen([mergedNoUpstream]);

      const safeBadge = el.shadowRoot!.querySelector('.risk-badge.safe');
      expect(safeBadge, 'merged branch must stay safe').to.not.be.null;
      expect(safeBadge!.textContent).to.include('Safe');
    });

    it('branch with unmeasurable divergence shows .risk-badge.warning, not "safe"', async () => {
      // aheadBehind is null when the backend could not compare at all — a
      // branch that neither tracks an upstream nor is gone. Treating that as
      // ahead: 0 claimed "Fully merged into current branch" about a branch
      // whose unmerged work is simply unknown, and cleared the delete confirm.
      const unknownDivergence = createCandidate('spike/old-idea', 'stale', {
        aheadBehind: null,
        upstream: null,
      });
      const el = await renderAndOpen([unknownDivergence]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      expect(el.shadowRoot!.querySelector('.risk-badge.safe'), 'must not be labelled safe').to.be
        .null;
      const warningBadge = el.shadowRoot!.querySelector('.risk-badge.warning');
      expect(warningBadge).to.not.be.null;
      expect(warningBadge!.textContent).to.include('Warning');
    });

    it('gone branch with ahead: 3 shows .risk-badge.danger', async () => {
      const el = await renderAndOpen([goneDanger]);

      // Need to switch to gone tab
      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const goneTab = Array.from(tabs).find((t) => t.textContent!.includes('Gone Upstream'));
      goneTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const dangerBadge = el.shadowRoot!.querySelector('.risk-badge.danger');
      expect(dangerBadge).to.not.be.null;
      expect(dangerBadge!.textContent).to.include('Danger');
    });
  });

  // ── Branch protection ──────────────────────────────────────────────────
  describe('Branch protection', () => {
    it('main branch shows .protected-badge and disabled checkbox', async () => {
      const el = await renderAndOpen([protectedMain, mergedSafe]);

      const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
      const mainItem = Array.from(branchItems).find(
        (item) => item.querySelector('.branch-name')?.textContent?.trim() === 'main',
      );
      expect(mainItem).to.not.be.null;

      const protectedBadge = mainItem!.querySelector('.protected-badge');
      expect(protectedBadge).to.not.be.null;

      const checkbox = mainItem!.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.disabled).to.be.true;
    });

    it('master branch shows .protected-badge', async () => {
      const el = await renderAndOpen([protectedMaster]);

      const protectedBadge = el.shadowRoot!.querySelector('.protected-badge');
      expect(protectedBadge).to.not.be.null;
      expect(protectedBadge!.textContent).to.include('Protected');
    });

    it('feature branch does NOT show .protected-badge', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const protectedBadge = el.shadowRoot!.querySelector('.protected-badge');
      expect(protectedBadge).to.be.null;

      // It should show a risk badge instead
      const riskBadge = el.shadowRoot!.querySelector('.risk-badge');
      expect(riskBadge).to.not.be.null;
    });
  });

  // ── Selection ──────────────────────────────────────────────────────────
  describe('Selection', () => {
    it('safe merged non-protected branches are auto-selected (checkbox checked)', async () => {
      const el = await renderAndOpen([mergedSafe, protectedMain]);

      const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
      const featureItem = Array.from(branchItems).find(
        (item) => item.querySelector('.branch-name')?.textContent?.trim() === 'feature/done',
      );
      expect(featureItem).to.not.be.null;

      const checkbox = featureItem!.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).to.be.true;
    });

    it('protected branches are NOT auto-selected', async () => {
      const el = await renderAndOpen([protectedMain, mergedSafe]);

      const branchItems = el.shadowRoot!.querySelectorAll('.branch-item');
      const mainItem = Array.from(branchItems).find(
        (item) => item.querySelector('.branch-name')?.textContent?.trim() === 'main',
      );
      expect(mainItem).to.not.be.null;

      const checkbox = mainItem!.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).to.be.false;
    });

    it('click checkbox toggles selection', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const checkbox = el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(checkbox.checked).to.be.true; // auto-selected

      // Uncheck
      checkbox.click();
      await settle(el);

      const updatedCheckbox = el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(updatedCheckbox.checked).to.be.false;

      // Check again
      updatedCheckbox.click();
      await settle(el);

      const finalCheckbox = el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(finalCheckbox.checked).to.be.true;
    });

    it('select-all checkbox toggles all selectable branches', async () => {
      // Stale branches are never auto-selected, so select-all has something to do.
      const el = await renderAndOpen([staleSafe, staleWarning, protectedMainStale]);

      // Find select-all checkbox
      const selectAllCheckbox = el.shadowRoot!.querySelector(
        '.select-all input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(selectAllCheckbox).to.not.be.null;

      // Click select-all to select all
      selectAllCheckbox.click();
      await settle(el);

      // All non-protected should be checked
      const branchItems = el.shadowRoot!.querySelectorAll('.branch-item:not(.protected)');
      for (const item of Array.from(branchItems)) {
        const cb = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(cb.checked).to.be.true;
      }

      // Protected should still be unchecked
      const protectedItem = el.shadowRoot!.querySelector('.branch-item.protected');
      if (protectedItem) {
        const protectedCb = protectedItem.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(protectedCb.checked).to.be.false;
      }

      // Click select-all again to deselect all
      const selectAllAgain = el.shadowRoot!.querySelector(
        '.select-all input[type="checkbox"]',
      ) as HTMLInputElement;
      selectAllAgain.click();
      await settle(el);

      const branchItemsAfter = el.shadowRoot!.querySelectorAll('.branch-item:not(.protected)');
      for (const item of Array.from(branchItemsAfter)) {
        const cb = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(cb.checked).to.be.false;
      }
    });
  });

  // ── Delete flow ────────────────────────────────────────────────────────
  describe('Delete flow', () => {
    it('delete button shows selected count text "Delete Selected (N)"', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      expect(deleteBtn).to.not.be.null;
      expect(deleteBtn.textContent!.trim()).to.include('Delete Selected (1)');
    });

    it('delete button disabled when nothing selected and no prune requested', async () => {
      // Stale branches are never auto-selected.
      const el = await renderAndOpen([staleWarning]);
      // "Also prune remote tracking branches" defaults to ticked, and the
      // prune is a tail step of this same button — so with it ticked the
      // button must stay live (as "Prune Remotes"), or the checkbox promises
      // something nothing can run. Only with BOTH empty is there nothing to do.
      (el as unknown as { pruneRemotes: boolean }).pruneRemotes = false;
      await el.updateComplete;

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      expect(deleteBtn).to.not.be.null;
      expect(deleteBtn.disabled).to.be.true;
    });

    it('stays runnable for a prune alone when nothing is selected', async () => {
      const el = await renderAndOpen([staleWarning]);
      const internal = el as unknown as { pruneRemotes: boolean; totalSelected: number };
      expect(internal.pruneRemotes, 'prune is ticked by default').to.be.true;
      expect(internal.totalSelected, 'and nothing is selected').to.equal(0);

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      expect(deleteBtn.disabled, 'a ticked prune must be runnable on its own').to.be.false;
      expect(deleteBtn.textContent).to.match(/prune/i);
    });

    it('confirms the exact safe-branch count and names before deleting', async () => {
      const el = await renderAndOpen([mergedSafe, goneSafe]);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      expect(messages[0]).to.include('2 selected local branches');
      expect(messages[0]).to.include(mergedSafe.name);
      expect(messages[0]).to.include(goneSafe.name);
      // "Also prune remote tracking branches" is ticked by default and the
      // prune runs off this same confirmed click, so the confirm has to state
      // that scope — declining it skips the prune too.
      expect(messages[0], 'a ticked prune is part of what is being confirmed').to.include(
        'Remote-tracking branches will also be pruned.',
      );
      expect(findCommands('delete_branch')).to.have.length(2);
      expect(findCommands('prune_remote_tracking_branches')).to.have.length(1);
    });

    it('omits the prune clause from the confirm when prune is unticked', async () => {
      // The clause must track the checkbox, not be boilerplate: with the tick
      // removed nothing prunes, so promising a prune would misstate the scope
      // of an irreversible action.
      const el = await renderAndOpen([mergedSafe, goneSafe]);
      (el.shadowRoot!.querySelector(
        '.prune-option input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      expect(messages[0]).to.include('2 selected local branches');
      expect(messages[0], 'nothing will be pruned, so it must not say so').to.not.include(
        'Remote-tracking branches will also be pruned.',
      );
      expect(findCommands('delete_branch')).to.have.length(2);
      expect(findCommands('prune_remote_tracking_branches')).to.have.length(0);
    });

    it('caps the name list, naming the risky branches first', async () => {
      // Open auto-selects every safe branch, so a long-lived repo produces a
      // confirm with dozens of refs in it. The names must not be able to push
      // the loss warning and the final question out of a native dialog — and
      // the cap must only ever drop names the loss warning is NOT about.
      const candidates = [
        ...Array.from({ length: 13 }, (_, i) =>
          createCandidate(`gone/${String(i).padStart(2, '0')}`, 'gone', {
            aheadBehind: { ahead: 0, behind: 0 },
            upstream: `origin/gone/${String(i).padStart(2, '0')}`,
          }),
        ),
        createCandidate('gone/danger-a', 'gone', {
          aheadBehind: { ahead: 4, behind: 0 },
          upstream: 'origin/gone/danger-a',
        }),
        createCandidate('gone/danger-b', 'gone', {
          aheadBehind: { ahead: 7, behind: 0 },
          upstream: 'origin/gone/danger-b',
        }),
      ];
      const el = await renderAndOpen(candidates);
      for (const box of Array.from(
        el.shadowRoot!.querySelectorAll('.branch-item input[type="checkbox"]'),
      )) {
        if (!(box as HTMLInputElement).checked) (box as HTMLInputElement).click();
      }
      await settle(el);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      const body = messages[0];
      expect(body, 'the exact scope is still stated').to.include(
        '15 selected local branches will be deleted.',
      );
      expect(body, 'the first names orient the user').to.include('gone/00');
      expect(body, 'beyond the cap the names collapse to a count').to.include(
        'and 5 more',
      );
      // The branches that actually lose commits must survive the cap — they
      // are the only ones the user cannot reconstruct from the count.
      for (const named of ['gone/danger-a', 'gone/danger-b']) {
        expect(body, `${named} loses commits, so it must be spelled out`).to.include(
          named,
        );
      }
      expect(
        body.indexOf('gone/danger-a') < body.indexOf('gone/00'),
        'risky names come before the safe ones the cap may drop',
      ).to.be.true;
      for (const omitted of ['gone/08', 'gone/09', 'gone/10', 'gone/11', 'gone/12']) {
        expect(body, `${omitted} must not be spelled out`).to.not.include(omitted);
      }

      const warning = '2 have unpushed commits that will be lost';
      expect(body).to.include(warning);
      expect(
        body.indexOf(warning) < body.indexOf('gone/danger-a'),
        'the loss warning must precede the list that can grow without bound',
      ).to.be.true;
      expect(
        body.indexOf('gone/00') < body.indexOf('This action cannot be undone'),
        'and the final question must still come last',
      ).to.be.true;

      expect(findCommands('delete_branch')).to.have.length(15);
    });

    it('describes a single safe branch in the singular', async () => {
      const el = await renderAndOpen([mergedSafe]);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      expect(messages[0]).to.include('1 selected local branch will be deleted.');
      expect(messages[0]).to.include(
        'This branch was reported as fully merged or otherwise safe to delete.',
      );
      expect(messages[0], 'no plural sentence for a single branch').to.not.include(
        'All selected branches',
      );
    });

    it('describes a single risky branch in the singular', async () => {
      // Stale branches are never auto-selected, so a one-branch risky
      // selection is the ordinary case — the risk clause must agree with the
      // count the rest of the message states.
      const el = await renderAndOpen([
        createCandidate('spike/solo', 'stale', { aheadBehind: null, upstream: null }),
      ]);
      const staleTab = Array.from(el.shadowRoot!.querySelectorAll('.tab')).find((t) =>
        t.textContent!.includes('Stale'),
      );
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      expect(messages[0]).to.include('1 selected local branch will be deleted.');
      expect(messages[0]).to.include(
        'Of this branch, 1 could not be checked for unmerged work',
      );
      expect(messages[0], 'no plural clause for a single branch').to.not.include(
        'Of these branches,',
      );
    });

    it('does not delete or prune safe branches when confirmation is declined', async () => {
      const el = await renderAndOpen([mergedSafe]);
      mockInvoke = async (command: string) => {
        if (isConfirmCommand(command)) return confirmResult(false);
        if (command === 'get_cleanup_candidates') return [];
        return null;
      };
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      expect(confirmMessages()).to.have.length(1);
      expect(findCommands('delete_branch')).to.have.length(0);
      expect(findCommands('prune_remote_tracking_branches')).to.have.length(0);
    });

    it('excludes stale selected names from the confirmation and delete snapshot', async () => {
      const el = await renderAndOpen([mergedSafe]);
      const internal = el as unknown as { selectedBranches: Set<string> };
      internal.selectedBranches.add('feature/no-longer-listed');
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = confirmMessages();
      expect(messages).to.have.length(1);
      expect(messages[0]).to.include('1 selected local branch');
      expect(messages[0]).to.include(mergedSafe.name);
      expect(messages[0]).to.not.include('feature/no-longer-listed');
      const deletes = findCommands('delete_branch');
      expect(deletes).to.have.length(1);
      expect((deletes[0].args as { name: string }).name).to.equal(mergedSafe.name);
    });

    it('never issues a force delete without a confirm', async () => {
      // Invariant guard. force=true skips delete_branch's merged-check, so it
      // must never happen on a path the user was not asked about. A merged
      // branch with upstream drift is labelled Safe (correctly) and is
      // confirmed like any other selection — but it must still never be forced.
      const el = await renderAndOpen([
        createCandidate('feature/merged-drift', 'merged', {
          aheadBehind: { ahead: 5, behind: 0 },
          upstream: 'origin/feature/merged-drift',
        }),
      ]);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const forced = findCommands('delete_branch').filter(
        (c) => (c.args as { force?: boolean }).force === true,
      );
      expect(
        forced.length === 0 || confirmMessages().length > 0,
        'a forced delete must be preceded by a confirm',
      ).to.be.true;
      expect(forced, 'a Safe branch must never be force-deleted').to.have.length(0);
    });

    it('reports declining the escalation as kept, not as a failure', async () => {
      const el = await renderAndOpen([
        createCandidate('spike/idea', 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);

      // Confirm the delete, then DECLINE the force escalation.
      let confirms = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) {
          confirms++;
          return confirmResult(confirms === 1);
        }
        if (command === 'delete_branch') {
          throw {
            code: 'COMMAND_ERROR',
            message: 'Branch is not fully merged. Use force to delete anyway.',
          };
        }
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      // The outcome toast is the LAST thing the handler does, after the
      // confirm, the refused delete, the declined escalation and the prune
      // gate have each made their IPC round trip — wait for that signal, not
      // for a timer that a loaded machine can outrun.
      await waitUntil(
        () => !(el as unknown as { deleting: boolean }).deleting,
        'the delete flow never finished',
      );
      await el.updateComplete;

      const forced = findCommands('delete_branch').filter(
        (c) => (c.args as { force?: boolean }).force === true,
      );
      expect(forced, 'declining must not force-delete').to.have.length(0);

      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some((t) => t.type === 'error'),
        "the user's own decision must not be reported as an error",
      ).to.be.false;
      expect(toasts.some((t) => /kept/i.test(t.message))).to.be.true;
    });

    it('never shows a confirm with an empty clause', async () => {
      // A branch emitted as BOTH merged and stale used to get two labels; the
      // gate read the un-deduplicated union (saw 'warning') while the message
      // read the deduplicated set (saw only 'safe'), producing the text
      // "Of the selected branches, .".
      const name = 'feature/old-and-merged';
      const el = await renderAndOpen([
        createCandidate(name, 'merged', { aheadBehind: null, upstream: null }),
        createCandidate(name, 'stale', { aheadBehind: null, upstream: null }),
      ]);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      for (const message of confirmMessages()) {
        expect(message, `malformed confirm: ${message}`).to.not.match(/,\s*\./);
      }
      expect(findCommands('delete_branch'), 'the delete still runs').to.have.length(1);
    });

    it('offers a force escalation when the backend refuses an unmerged branch', async () => {
      // force is withheld for unmeasurable divergence (that is the safe
      // outcome), but git's "use force to delete anyway" is unactionable
      // unless the dialog offers it.
      const el = await renderAndOpen([
        createCandidate('spike/idea', 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);

      // First delete_branch call is refused as unmerged; the retry succeeds.
      let deleteCalls = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) return confirmResult(true);
        if (command === 'delete_branch') {
          deleteCalls++;
          if (deleteCalls === 1) {
            throw { code: 'COMMAND_ERROR', message: 'Branch is not fully merged. Use force to delete anyway.' };
          }
          return undefined;
        }
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const calls = findCommands('delete_branch');
      expect(calls.length, 'should retry after the escalation confirm').to.equal(2);
      expect((calls[0].args as { force?: boolean }).force).to.not.equal(true);
      expect((calls[1].args as { force?: boolean }).force).to.equal(true);
      expect(
        confirmMessages().some((m) => /not merged into the current branch/i.test(m)),
        'the escalation must be confirmed explicitly',
      ).to.be.true;
    });

    it('reloads its list when it stays open after a successful prune', async () => {
      // The prune removes remote-tracking refs that the risk badges and the
      // Gone Upstream tab are derived from. The dialog now survives that
      // (deleted === 0), so what it shows must be refreshed — otherwise the
      // next Delete click acts on labels the prune already invalidated.
      const el = await renderAndOpen([
        createCandidate('spike/idea', 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);

      let confirms = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) {
          confirms++;
          return confirmResult(confirms === 1);
        }
        if (command === 'delete_branch') {
          throw {
            code: 'COMMAND_ERROR',
            message: 'Branch is not fully merged. Use force to delete anyway.',
          };
        }
        if (command === 'prune_remote_tracking_branches') {
          return { success: true, branchesPruned: ['origin/gone'] };
        }
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      expect(
        findCommands('get_cleanup_candidates'),
        'the visible list must be refreshed after the prune',
      ).to.have.length.greaterThan(0);
    });

    it('ignores open() while a delete is in flight', async () => {
      // The command palette can dispatch open-branch-cleanup over the modal.
      // reset() would clear `deleting`, re-enabling Delete mid-flight so a
      // second concurrent loop could start, and re-pin the repo path.
      const el = await renderAndOpen([mergedSafe]);
      (el as unknown as { deleting: boolean }).deleting = true;
      (el as unknown as { selectedBranches: Set<string> }).selectedBranches = new Set(['keep/me']);

      await el.open();

      expect(
        (el as unknown as { deleting: boolean }).deleting,
        'an in-flight delete must not be cleared',
      ).to.equal(true);
      expect(
        (el as unknown as { selectedBranches: Set<string> }).selectedBranches.has('keep/me'),
        'the in-flight selection must survive',
      ).to.be.true;
    });

    it('reports a failed remote prune instead of claiming it succeeded', async () => {
      // pruneRemoteTrackingBranches goes through invokeCommand, which never
      // throws — it resolves { success: false }. The old try/catch was dead
      // code, so an offline prune was reported as "(remotes pruned)".
      const el = await renderAndOpen([mergedSafe]);

      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) return confirmResult(true);
        if (command === 'delete_branch') return undefined;
        if (command === 'prune_remote_tracking_branches') {
          throw { code: 'COMMAND_ERROR', message: 'could not connect to origin' };
        }
        return null;
      };

      uiStore.setState({ toasts: [] });
      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(
        messages.some((m) => /Failed to prune remote branches/i.test(m)),
        'a failed prune must be reported',
      ).to.be.true;
      expect(
        messages.some((m) => /remotes pruned/i.test(m)),
        'must not claim a prune that did not happen',
      ).to.be.false;
    });

    it('warns of permanent loss for a branch with no remote copy', async () => {
      // Mirror of the pushed case. A branch with NO upstream loses everything
      // on a force delete, so the confirm must not imply an upstream fallback.
      const el = await renderAndOpen([
        createCandidate('spike/idea', 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);

      // The delete confirm fires for any selection — accept it, then decline
      // the escalation.
      let confirms = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) {
          confirms++;
          return confirmResult(confirms === 1);
        }
        if (command === 'delete_branch') {
          throw {
            code: 'COMMAND_ERROR',
            message: 'Branch is not fully merged. Use force to delete anyway.',
          };
        }
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const escalation = confirmMessages().find((m) =>
        /not merged into the current branch/i.test(m),
      );
      expect(escalation, 'escalation confirm shown').to.not.be.undefined;
      expect(escalation!).to.include('no remote copy');
      expect(escalation!).to.include('discarded permanently');
      expect(escalation!, 'must not imply an upstream fallback').to.not.match(
        /can be restored from the remote/i,
      );
    });

    it('reports failed and kept outcomes together', async () => {
      // These were mutually exclusive `else if` arms, so a branch the user
      // chose to keep went unmentioned whenever another branch also failed —
      // leaving them to assume it had been deleted.
      const el = await renderAndOpen([
        createCandidate('a/fails', 'stale', { aheadBehind: { ahead: 2, behind: 0 } }),
        createCandidate('b/kept', 'stale', { aheadBehind: null, upstream: null }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      for (const box of Array.from(
        el.shadowRoot!.querySelectorAll('.branch-item input[type="checkbox"]'),
      )) {
        (box as HTMLInputElement).click();
      }
      await settle(el);

      let confirms = 0;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) {
          confirms++;
          // Confirm the delete, decline the force escalation.
          return confirmResult(confirms === 1);
        }
        if (command === 'delete_branch') {
          const name = (args as { name: string }).name;
          throw name === 'a/fails'
            ? { code: 'COMMAND_ERROR', message: 'locked by another worktree' }
            : {
                code: 'COMMAND_ERROR',
                message: 'Branch is not fully merged. Use force to delete anyway.',
              };
        }
        return null;
      };

      uiStore.setState({ toasts: [] });
      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => /a\/fails/.test(m)), 'the failure is named').to.be.true;
      expect(messages.some((m) => /kept/i.test(m)), 'the kept branch is named').to.be.true;
    });

    it('does not claim commits "exist nowhere else" for a pushed branch', async () => {
      // "not fully merged" is measured against HEAD; the Safe badge is measured
      // against the UPSTREAM. A branch can be refused here while its commits
      // sit safely on its remote, so the confirm must not overstate the loss.
      const el = await renderAndOpen([
        createCandidate('feature/pushed', 'stale', {
          aheadBehind: { ahead: 0, behind: 0 },
          upstream: 'origin/feature/pushed',
        }),
      ]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);
      (el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement).click();
      await settle(el);

      let confirms = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        if (isConfirmCommand(command)) {
          confirms++;
          return confirmResult(confirms === 1);
        }
        if (command === 'delete_branch') {
          throw {
            code: 'COMMAND_ERROR',
            message: 'Branch is not fully merged. Use force to delete anyway.',
          };
        }
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const escalation = confirmMessages().find((m) =>
        /not merged into the current branch/i.test(m),
      );
      expect(escalation, 'escalation confirm shown').to.not.be.undefined;
      expect(escalation!).to.not.match(/nowhere else/i);
      expect(escalation!, 'should name where the commits actually are').to.include(
        'origin/feature/pushed',
      );
    });

    it('does NOT force-delete a branch whose divergence could not be measured', async () => {
      // Regression guard. `force` must not be derived from the risk LABEL:
      // a branch is labelled 'warning' precisely BECAUSE its ahead/behind is
      // unknown, and force-deleting it bypasses delete_branch's merged-check —
      // turning the backend's safe refusal into permanent commit loss.
      const unknownDivergence = createCandidate('spike/old-idea', 'stale', {
        aheadBehind: null,
        upstream: null,
      });
      const el = await renderAndOpen([unknownDivergence]);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      const staleTab = Array.from(tabs).find((t) => t.textContent!.includes('Stale'));
      staleTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(el);

      const checkbox = el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement;
      checkbox.click();
      await settle(el);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const calls = findCommands('delete_branch');
      expect(calls, 'delete_branch invoked').to.have.length(1);
      expect(
        (calls[0].args as { force?: boolean }).force,
        'unknown divergence must fall through to the backend merged-check',
      ).to.not.equal(true);
    });

    it('force-deletes only when unpushed commits were actually measured', async () => {
      // staleWarning has a measured ahead of 3, so force is justified.
      const el = await renderAndOpen([staleWarning]);

      const checkbox = el.shadowRoot!.querySelector(
        '.branch-item input[type="checkbox"]',
      ) as HTMLInputElement;
      checkbox.click();
      await settle(el);
      clearHistory();

      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      const calls = findCommands('delete_branch');
      expect(calls).to.have.length(1);
      expect((calls[0].args as { force?: boolean }).force).to.equal(true);
    });

    it('clicking delete calls delete_branch for each selected branch', async () => {
      // Both are merged and therefore safe, so both are auto-selected.
      const candidates = [mergedSafe, mergedWarning];
      const el = await renderAndOpen(candidates);
      await settle(el);

      clearHistory();

      // Click delete
      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();

      // Wait for async confirmation dialog + deletion
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const deleteCalls = findCommands('delete_branch');
      expect(deleteCalls.length).to.equal(2);

      const deletedNames = deleteCalls.map(
        (c) => (c.args as Record<string, unknown>).name,
      );
      expect(deletedNames).to.include('feature/done');
      expect(deletedNames).to.include('feature/wip');
    });

    it('deletes + prunes the repo it was opened for, not the tab switched to while open', async () => {
      // The dialog pins its repo at open(); repositoryPath is bound live to the
      // active tab. Switching tabs while the (irreversible) cleanup dialog is
      // open must not redirect the force-deletes / remote prune to another repo.
      const el = await renderAndOpen([mergedSafe]);

      // User switches to another repo while the dialog is open.
      el.repositoryPath = '/other/repo';
      await el.updateComplete;

      let detail: { repositoryPath?: string } | null = null;
      el.addEventListener('cleanup-complete', (e) => {
        detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
      });

      clearHistory();
      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const deleteCalls = findCommands('delete_branch');
      expect(deleteCalls.length).to.be.greaterThan(0);
      deleteCalls.forEach((c) =>
        expect((c.args as { path: string }).path).to.equal(REPO_PATH),
      );
      const pruneCalls = findCommands('prune_remote_tracking_branches');
      pruneCalls.forEach((c) =>
        expect((c.args as { path: string }).path).to.equal(REPO_PATH),
      );
      expect(detail, 'cleanup-complete dispatched').to.not.be.null;
      expect(detail!.repositoryPath).to.equal(REPO_PATH);
    });

    it('exposes its pinned repo only while open, for host self-close', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return REMOTES;
        return null;
      };
      const el = await fixture<LvBranchCleanupDialog>(
        html`<lv-branch-cleanup-dialog .repositoryPath=${REPO_PATH}></lv-branch-cleanup-dialog>`,
      );
      await el.updateComplete;
      expect(el.pinnedRepositoryPathIfOpen, 'null before open').to.be.null;
      el.open();
      await settle(el);
      expect(el.pinnedRepositoryPathIfOpen, 'pinned while open').to.equal(REPO_PATH);
      el.close();
      expect(el.pinnedRepositoryPathIfOpen, 'null after close').to.be.null;
    });

    it('cleanup-complete event dispatched after successful deletion', async () => {
      const el = await renderAndOpen([mergedSafe]);

      let eventFired = false;
      el.addEventListener('cleanup-complete', () => {
        eventFired = true;
      });

      clearHistory();

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();

      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });
  });

  // ── Prune option ───────────────────────────────────────────────────────
  describe('Prune option', () => {
    it('prune checkbox is checked by default', async () => {
      const el = await renderAndOpen([mergedSafe]);

      const pruneCheckbox = el.shadowRoot!.querySelector(
        '.prune-option input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(pruneCheckbox).to.not.be.null;
      expect(pruneCheckbox.checked).to.be.true;
    });

    it('when prune is checked and delete executes, prune_remote_tracking_branches is called', async () => {
      const el = await renderAndOpen([mergedSafe]);
      clearHistory();

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();

      await new Promise((r) => setTimeout(r, 200));
      await el.updateComplete;

      const pruneCalls = findCommands('prune_remote_tracking_branches');
      expect(pruneCalls.length).to.equal(1);
      // The dialog names no remote, so every remote in the repo must be sent —
      // dropping one leaves its stale tracking refs behind while the dialog
      // still reports "remotes pruned".
      expect((pruneCalls[0].args as { remotes: string[] }).remotes).to.deep.equal([
        'origin',
        'upstream',
      ]);
    });

    it('prunes nothing, and reports nothing, when the repo has no remotes', async () => {
      const el = await renderAndOpen([mergedSafe]);

      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') return [];
        if (isConfirmCommand(command)) return confirmResult(true);
        if (command === 'delete_branch') return undefined;
        return null;
      };

      uiStore.setState({ toasts: [] });
      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      expect(findCommands('prune_remote_tracking_branches').length).to.equal(0);
      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(
        messages.some((m) => /Failed to prune remote branches/i.test(m)),
        'a repo with no remotes has nothing to prune — that is not a failure',
      ).to.be.false;
      expect(
        messages.some((m) => /remotes pruned/i.test(m)),
        'and nothing was pruned, so it must not say so',
      ).to.be.false;
    });

    it('reports a failure to list the remotes instead of claiming success', async () => {
      const el = await renderAndOpen([mergedSafe]);

      mockInvoke = async (command: string) => {
        if (command === 'get_cleanup_candidates') return [];
        if (command === 'get_remotes') throw { code: 'COMMAND_ERROR', message: 'no remotes' };
        if (isConfirmCommand(command)) return confirmResult(true);
        if (command === 'delete_branch') return undefined;
        return null;
      };

      uiStore.setState({ toasts: [] });
      clearHistory();
      (el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement).click();
      await settle(el);

      expect(findCommands('prune_remote_tracking_branches').length).to.equal(0);
      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(
        messages.some((m) => /Failed to prune remote branches/i.test(m)),
        'the prune could not run, so it must be reported',
      ).to.be.true;
      expect(
        messages.some((m) => /remotes pruned/i.test(m)),
        'must not claim a prune that did not happen',
      ).to.be.false;
    });
  });

  // ── Footer ─────────────────────────────────────────────────────────────
  describe('Footer', () => {
    it('shows "No branches selected" when none selected', async () => {
      // Stale branches are never auto-selected.
      const el = await renderAndOpen([staleWarning]);

      const footer = el.shadowRoot!.querySelector('.footer-summary');
      expect(footer).to.not.be.null;
      expect(footer!.textContent).to.include('No branches selected');
    });

    it('shows "N branches selected" with correct count', async () => {
      const el = await renderAndOpen([mergedSafe, goneSafe]);

      // mergedSafe is auto-selected; goneSafe is auto-selected
      const footer = el.shadowRoot!.querySelector('.footer-summary');
      expect(footer).to.not.be.null;
      expect(footer!.textContent).to.include('2 branches selected');
    });
  });
});
