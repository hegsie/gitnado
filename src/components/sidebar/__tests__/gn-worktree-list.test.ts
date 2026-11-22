/**
 * Tests for gn-worktree-list component and first-class worktree integration
 * across gn-left-panel, gn-branch-list, gn-worktree-dialog, and gn-file-status.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let cbId = 0;
const invokedCommands: Array<{ command: string; args?: Record<string, unknown> }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokedCommands.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { Branch, StatusEntry } from '../../../types/git.types.ts';
import type { Worktree } from '../../../services/git.service.ts';
import '../gn-worktree-list.ts';
import {
  openOrSwitchWorktreeTab,
  closeRemovedWorktreeTab,
  type GnWorktreeList,
} from '../gn-worktree-list.ts';
import '../gn-branch-list.ts';
import type { GnBranchList } from '../gn-branch-list.ts';
import '../gn-file-status.ts';
import type { GnFileStatus } from '../gn-file-status.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_MAIN = '/test/repo';
const REPO_WT_1 = '/test/repo-wt-1';
const REPO_WT_STALE = '/test/repo-wt-stale';

const mockWorktrees: Worktree[] = [
  {
    path: REPO_MAIN,
    headOid: '1111111abcdef',
    branch: 'main',
    isMain: true,
    isLocked: false,
    lockReason: null,
    isBare: false,
    isPrunable: false,
    isCurrent: true,
  },
  {
    path: REPO_WT_1,
    headOid: '2222222abcdef',
    branch: 'feat/ai-agent',
    isMain: false,
    isLocked: false,
    lockReason: null,
    isBare: false,
    isPrunable: false,
    isCurrent: false,
  },
  {
    path: REPO_WT_STALE,
    headOid: '3333333abcdef',
    branch: 'feat/old',
    isMain: false,
    isLocked: false,
    lockReason: null,
    isBare: false,
    isPrunable: true,
    isCurrent: false,
  },
];

const mockBranches: Branch[] = [
  {
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: null,
    targetOid: '1111111abcdef',
    isStale: false,
  },
  {
    name: 'feat/ai-agent',
    shorthand: 'feat/ai-agent',
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: '2222222abcdef',
    isStale: false,
  },
];

async function settle(el: { updateComplete: Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
  }
  await el.updateComplete;
}

describe('gn-worktree-list & first-class worktree support', () => {
  beforeEach(() => {
    invokedCommands.length = 0;
    repositoryStore.getState().reset();
    resetRefOpLocks();

    repositoryStore.getState().addRepository({
      path: REPO_MAIN,
      name: 'repo',
      isValid: true,
      isBare: false,
      headRef: 'refs/heads/main',
      detachedHeadOid: null,
      state: 'clean',
      isShallow: false,
      isPartialClone: false,
      cloneFilter: null,
    });

    mockInvoke = async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'get_worktrees':
          return mockWorktrees;
        case 'get_branches':
          return mockBranches;
        case 'get_remotes':
          return [];
        case 'get_status':
          return [];
        case 'open_repository': {
          const path = String(args?.path ?? REPO_WT_1);
          return {
            path,
            name: path.split('/').pop() ?? 'wt',
            isValid: true,
            isBare: false,
            headRef: 'refs/heads/feat/ai-agent',
            detachedHeadOid: null,
            state: 'clean',
            isShallow: false,
            isPartialClone: false,
            cloneFilter: null,
          };
        }
        case 'lock_worktree':
        case 'unlock_worktree':
        case 'remove_worktree':
        case 'prune_worktrees':
        case 'open_in_configured_editor':
          return { success: true, message: 'Opened in code' };
        case 'plugin:dialog|message':
        case 'plugin:dialog|confirm':
        case 'plugin:dialog|ask':
          return 'Ok';
        default:
          return null;
      }
    };
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    resetRefOpLocks();
  });

  describe('gn-worktree-list component', () => {
    it('renders worktrees with current, main, and stale badges and emits worktree-count-changed', async () => {
      let emittedCount = -1;
      const el = await fixture<GnWorktreeList>(html`
        <gn-worktree-list
          .repositoryPath=${REPO_MAIN}
          @worktree-count-changed=${(e: CustomEvent<{ count: number }>) => {
            emittedCount = e.detail.count;
          }}
        ></gn-worktree-list>
      `);
      await settle(el);

      expect(emittedCount).to.equal(3);
      const items = el.shadowRoot!.querySelectorAll('.worktree-item');
      expect(items.length).to.equal(3);

      const badges = Array.from(el.shadowRoot!.querySelectorAll('.badge')).map((b) =>
        b.textContent?.trim()
      );
      expect(badges).to.include('current');
      expect(badges).to.include('main');
      expect(badges).to.include('stale');

      // Prune Stale footer button appears when a worktree is prunable
      const footerBtns = Array.from(el.shadowRoot!.querySelectorAll('.worktree-btn')).map((b) =>
        b.textContent?.trim()
      );
      expect(footerBtns.some((t) => t?.includes('Prune Stale'))).to.be.true;
    });

    it('opens a linked worktree in a new repository tab on click or Open button', async () => {
      const el = await fixture<GnWorktreeList>(html`
        <gn-worktree-list .repositoryPath=${REPO_MAIN}></gn-worktree-list>
      `);
      await settle(el);

      const items = el.shadowRoot!.querySelectorAll('.worktree-item');
      (items[1] as HTMLElement).click();
      await settle(el);

      const openRepos = repositoryStore.getState().openRepositories;
      expect(openRepos.some((r) => r.repository.path === REPO_WT_1)).to.be.true;
      expect(repositoryStore.getState().getActiveRepository()?.repository.path).to.equal(REPO_WT_1);
    });

    it('switches to an already-open worktree tab without calling open_repository again', async () => {
      // Open REPO_WT_1 first
      await openOrSwitchWorktreeTab(REPO_WT_1);
      // Switch back to REPO_MAIN
      repositoryStore.getState().setActiveIndex(0);
      invokedCommands.length = 0;

      const switched = await openOrSwitchWorktreeTab(REPO_WT_1);
      expect(switched).to.be.true;
      expect(repositoryStore.getState().getActiveRepository()?.repository.path).to.equal(REPO_WT_1);
      expect(invokedCommands.some((c) => c.command === 'open_repository')).to.be.false;
    });

    it('closes an open tab and prunes persistence when closeRemovedWorktreeTab is called', async () => {
      await openOrSwitchWorktreeTab(REPO_WT_1);
      expect(repositoryStore.getState().openRepositories.length).to.equal(2);

      closeRemovedWorktreeTab(REPO_WT_1);
      expect(repositoryStore.getState().openRepositories.length).to.equal(1);
      expect(
        repositoryStore.getState().openRepositories.some((r) => r.repository.path === REPO_WT_1)
      ).to.be.false;
    });

    it('clears worktrees and emits count 0 when get_worktrees fails on repo switch', async () => {
      const counts: number[] = [];
      const el = await fixture<GnWorktreeList>(html`
        <gn-worktree-list
          .repositoryPath=${REPO_MAIN}
          @worktree-count-changed=${(e: CustomEvent<{ count: number }>) =>
            counts.push(e.detail.count)}
        ></gn-worktree-list>
      `);
      await settle(el);
      expect(el.shadowRoot!.querySelectorAll('.worktree-item').length).to.equal(3);

      mockInvoke = async (command: string) => {
        if (command === 'get_worktrees') {
          throw { code: 'COMMAND_ERROR', message: 'failed to resolve path' };
        }
        return null;
      };

      el.repositoryPath = '/missing/worktree';
      await settle(el);

      expect(el.shadowRoot!.querySelectorAll('.worktree-item').length).to.equal(0);
      expect(counts[counts.length - 1]).to.equal(0);
      expect(el.shadowRoot!.querySelector('.error')?.textContent).to.include(
        'failed to resolve path'
      );
    });
  });

  describe('gn-branch-list worktree integration', () => {
    it('renders worktree badge on branches checked out in another worktree and switches tab on checkout', async () => {
      const el = await fixture<GnBranchList>(html`
        <gn-branch-list .repositoryPath=${REPO_MAIN}></gn-branch-list>
      `);
      await settle(el);

      const badge = el.shadowRoot!.querySelector('.worktree-badge') as HTMLElement;
      expect(badge, 'worktree badge should render for feat/ai-agent').to.exist;
      expect(badge.textContent?.trim()).to.equal('repo-wt-1');

      // Checking out a branch that is checked out in another worktree switches to that worktree tab
      // instead of failing git checkout
      invokedCommands.length = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleCheckout(mockBranches[1]);

      expect(invokedCommands.some((c) => c.command === 'checkout')).to.be.false;
      expect(repositoryStore.getState().getActiveRepository()?.repository.path).to.equal(REPO_WT_1);
    });

    it('clears stale branches when switching to a repository whose get_branches fails', async () => {
      const el = await fixture<GnBranchList>(html`
        <gn-branch-list .repositoryPath=${REPO_MAIN}></gn-branch-list>
      `);
      await settle(el);
      expect(el.shadowRoot!.querySelectorAll('.branch-item').length).to.be.greaterThan(0);

      mockInvoke = async (command: string) => {
        if (command === 'get_branches' || command === 'get_worktrees') {
          throw { code: 'COMMAND_ERROR', message: 'path not found' };
        }
        return [];
      };

      el.repositoryPath = '/deleted/worktree';
      await settle(el);

      expect(el.shadowRoot!.querySelectorAll('.branch-item').length).to.equal(0);
    });
  });

  describe('gn-file-status Open in Editor & stale status clearing', () => {
    it('uses open_in_configured_editor instead of shell open for Open in Editor context action', async () => {
      const fileEntry: StatusEntry = {
        path: 'src/components/tags-input.ts',
        status: 'modified',
        isStaged: false,
        isConflicted: false,
      };
      mockInvoke = async (command: string) => {
        if (command === 'get_status') return [fileEntry];
        if (command === 'open_in_configured_editor') {
          return { success: true, message: 'Opened in code' };
        }
        return null;
      };

      const el = await fixture<GnFileStatus>(html`
        <gn-file-status .repositoryPath=${REPO_MAIN}></gn-file-status>
      `);
      await settle(el);

      invokedCommands.length = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        file: fileEntry,
        isStaged: false,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleContextOpenInEditor();

      const editorCall = invokedCommands.find((c) => c.command === 'open_in_configured_editor');
      expect(editorCall).to.exist;
      expect(editorCall?.args).to.deep.include({
        path: REPO_MAIN,
        filePath: 'src/components/tags-input.ts',
      });
    });

    it('clears files and emits status-changed with 0 counts when get_status fails on repo switch', async () => {
      const fileEntry: StatusEntry = {
        path: 'src/index.ts',
        status: 'modified',
        isStaged: false,
        isConflicted: false,
      };
      mockInvoke = async (command: string) => {
        if (command === 'get_status') return [fileEntry];
        return null;
      };

      const statusEvents: Array<{ stagedCount: number; totalCount?: number }> = [];
      const el = await fixture<GnFileStatus>(html`
        <gn-file-status
          .repositoryPath=${REPO_MAIN}
          @status-changed=${(e: CustomEvent<{ stagedCount: number; totalCount?: number }>) =>
            statusEvents.push(e.detail)}
        ></gn-file-status>
      `);
      await settle(el);
      expect(statusEvents[statusEvents.length - 1]?.totalCount).to.equal(1);

      mockInvoke = async (command: string) => {
        if (command === 'get_status') {
          throw { code: 'COMMAND_ERROR', message: 'repository path does not exist' };
        }
        return null;
      };

      el.repositoryPath = '/deleted/worktree';
      await settle(el);

      expect(statusEvents[statusEvents.length - 1]).to.deep.equal({
        stagedCount: 0,
        totalCount: 0,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el as any).unstagedFiles).to.deep.equal([]);
    });
  });
});
