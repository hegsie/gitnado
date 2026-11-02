/**
 * Stacked branches in the branch list (roadmap 4.3, #614): the Stacks
 * section, and the "Stack on…" / "Remove from Stack" context-menu actions.
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

import { expect, fixture, html } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import type { GnBranchList } from '../gn-branch-list.ts';
import '../gn-branch-list.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { invalidateProviderDetection } from '../../../services/pull-request.service.ts';
import type { Branch, RestackPlan, Stack } from '../../../types/git.types.ts';

const REPO_PATH = '/test/repo';

const BRANCHES = [
  { name: 'main', shorthand: 'main', isHead: true, isRemote: false, upstream: null },
  { name: 'feat-a', shorthand: 'feat-a', isHead: false, isRemote: false, upstream: null },
  { name: 'feat-b', shorthand: 'feat-b', isHead: false, isRemote: false, upstream: null },
];

const STACKS: Stack[] = [{
  base: 'main',
  branches: [
    { name: 'feat-a', parent: 'main', depth: 1, ahead: 2, behind: 0, isHead: false, parentMissing: false },
    { name: 'feat-b', parent: 'feat-a', depth: 2, ahead: 1, behind: 3, isHead: false, parentMissing: false },
  ],
}];

function mocks(overrides: Record<string, unknown> = {}): void {
  mockInvoke = async (command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      if (value instanceof Error) throw value.message;
      return typeof value === 'function' ? (value as () => unknown)() : value;
    }
    switch (command) {
      case 'get_branches': return BRANCHES;
      case 'get_stacks': return STACKS;
      case 'get_remotes':
      case 'get_hidden_branches': return [];
      case 'get_branch_sort_mode': return 'name';
      case 'plugin:dialog|message': return 'Ok';
      default: return null;
    }
  };
}

async function createList(): Promise<GnBranchList> {
  const el = await fixture<GnBranchList>(
    html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`,
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

type Internals = {
  contextMenu: { visible: boolean; x: number; y: number; branch: Branch | null };
  handleStackOn: () => Promise<void>;
  handleRemoveFromStack: () => Promise<void>;
};

function openMenuFor(el: GnBranchList, name: string): void {
  const branch = BRANCHES.find((b) => b.name === name) as unknown as Branch;
  (el as unknown as Internals).contextMenu = { visible: true, x: 0, y: 0, branch };
}

async function answerPrompt(value: string | null): Promise<void> {
  type PromptEl = Element & { value: string; resolve?: unknown };
  const find = (): PromptEl | null => document.querySelector('gn-prompt-dialog') as unknown as PromptEl | null;
  let dialog = find();
  for (let i = 0; i < 50 && !dialog?.resolve; i++) {
    await new Promise((r) => setTimeout(r, 10));
    dialog = find();
  }
  expect(dialog, 'prompt dialog mounted').to.not.be.null;
  if (value === null) {
    (dialog!.shadowRoot!.querySelector('.btn-secondary, .btn:not(.btn-primary)') as HTMLButtonElement).click();
    return;
  }
  dialog!.value = value;
  await (dialog as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  (dialog!.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement).click();
}

const toastMessages = () => uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

describe('gn-branch-list stacks', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
    mocks();
  });

  afterEach(() => {
    document.querySelectorAll('gn-prompt-dialog').forEach((d) => d.remove());
  });

  it('renders each stack bottom-to-top with depth, ahead count and restack badge', async () => {
    const el = await createList();
    const rows = Array.from(el.shadowRoot!.querySelectorAll('.stack-branch')) as HTMLElement[];
    expect(rows.map((r) => r.dataset.branch)).to.deep.equal(['feat-a', 'feat-b']);
    expect(el.shadowRoot!.querySelector('.stack-base')!.textContent).to.contain('on main');
    expect(rows[0].textContent).to.contain('+2');
    expect(rows[0].querySelector('.stack-badge')).to.be.null;
    expect(rows[1].querySelector('.stack-badge')!.textContent).to.contain('needs restack');
    expect(parseInt(rows[1].style.paddingLeft)).to.be.greaterThan(parseInt(rows[0].style.paddingLeft));
  });

  it('flags a branch whose parent is gone', async () => {
    mocks({
      get_stacks: [{ base: 'gone', branches: [{ ...STACKS[0].branches[0], parent: 'gone', parentMissing: true }] }],
    });
    const el = await createList();
    expect(el.shadowRoot!.querySelector('.stack-badge.warning')!.textContent).to.contain('parent missing');
  });

  it('shows no Stacks section when nothing is stacked', async () => {
    mocks({ get_stacks: [] });
    const el = await createList();
    expect(el.shadowRoot!.querySelector('.stacks-group')).to.be.null;
    expect(el.shadowRoot!.querySelectorAll('.branch-item').length).to.be.greaterThan(0);
  });

  it('reports a stacks read failure without hiding the branches', async () => {
    mocks({ get_stacks: new Error('config locked') });
    const el = await createList();
    expect(el.shadowRoot!.querySelector('.stacks-error')!.textContent).to.contain('config locked');
    expect(el.shadowRoot!.querySelectorAll('.branch-item').length).to.equal(3);
  });

  it('double-clicking a stack row checks that branch out', async () => {
    const el = await createList();
    invokeCalls.length = 0;
    const row = el.shadowRoot!.querySelector('.stack-branch[data-branch="feat-b"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    for (let i = 0; i < 50 && !invokeCalls.some((c) => c.command.startsWith('checkout')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const call = invokeCalls.find((c) => c.command.startsWith('checkout'));
    expect(call, 'checkout invoked').to.not.be.undefined;
    expect(JSON.stringify(call!.args)).to.contain('feat-b');
  });

  it('menu offers Stack on / Remove from Stack depending on membership', async () => {
    const el = await createList();
    openMenuFor(el, 'feat-b');
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('[data-action="stack-on"]')!.textContent).to.contain('Change Stack Parent');
    expect(el.shadowRoot!.querySelector('[data-action="remove-from-stack"]')).to.not.be.null;

    mocks({ get_stacks: [] });
    const el2 = await createList();
    openMenuFor(el2, 'feat-a');
    await el2.updateComplete;
    expect(el2.shadowRoot!.querySelector('[data-action="stack-on"]')!.textContent).to.contain('Stack on');
    expect(el2.shadowRoot!.querySelector('[data-action="remove-from-stack"]')).to.be.null;
  });

  it('Stack on… sets the parent, toasts, reloads and dispatches branches-changed', async () => {
    const el = await createList();
    let changed: string | undefined;
    el.addEventListener('branches-changed', (e) => {
      changed = (e as CustomEvent<{ repositoryPath: string }>).detail.repositoryPath;
    });
    openMenuFor(el, 'feat-a');
    invokeCalls.length = 0;
    const done = (el as unknown as Internals).handleStackOn();
    await answerPrompt('main');
    await done;

    const call = invokeCalls.find((c) => c.command === 'set_branch_parent');
    expect(call!.args).to.deep.include({ path: REPO_PATH, branch: 'feat-a', parent: 'main' });
    expect(toastMessages()).to.include('success:feat-a is now stacked on main');
    expect(invokeCalls.some((c) => c.command === 'get_stacks')).to.be.true;
    expect(changed).to.equal(REPO_PATH);
  });

  it('Stack on… shows the backend refusal (e.g. a loop) as an error toast', async () => {
    mocks({ set_branch_parent: new Error('feat-b is already stacked on feat-a; stacking feat-a on it would make a loop') });
    const el = await createList();
    openMenuFor(el, 'feat-a');
    const done = (el as unknown as Internals).handleStackOn();
    await answerPrompt('feat-b');
    await done;
    expect(toastMessages().some((m) => m.startsWith('error:') && m.includes('loop'))).to.be.true;
  });

  it('Stack on… does nothing when the prompt is cancelled', async () => {
    const el = await createList();
    openMenuFor(el, 'feat-a');
    invokeCalls.length = 0;
    const done = (el as unknown as Internals).handleStackOn();
    await answerPrompt(null);
    await done;
    expect(invokeCalls.some((c) => c.command === 'set_branch_parent')).to.be.false;
    expect(uiStore.getState().toasts).to.have.length(0);
  });

  it('Remove from Stack clears the parent and dispatches branches-changed', async () => {
    const el = await createList();
    let changed = false;
    el.addEventListener('branches-changed', () => { changed = true; });
    openMenuFor(el, 'feat-b');
    invokeCalls.length = 0;
    await (el as unknown as Internals).handleRemoveFromStack();
    const call = invokeCalls.find((c) => c.command === 'clear_branch_parent');
    expect(call!.args).to.deep.include({ path: REPO_PATH, branch: 'feat-b' });
    expect(toastMessages()).to.include('success:feat-b removed from its stack');
    expect(changed).to.be.true;
  });

  it('Remove from Stack reports failures', async () => {
    mocks({ clear_branch_parent: new Error('config locked') });
    const el = await createList();
    openMenuFor(el, 'feat-b');
    await (el as unknown as Internals).handleRemoveFromStack();
    expect(toastMessages().some((m) => m.startsWith('error:') && m.includes('config locked'))).to.be.true;
  });

  describe('restack', () => {
    const PLAN: RestackPlan = {
      base: 'main',
      canApply: true,
      hasChanges: true,
      steps: [
        { branch: 'feat-a', onto: 'main', status: 'upToDate', commits: 2, conflictFiles: [], conflictCommit: null },
        { branch: 'feat-b', onto: 'feat-a', status: 'restacked', commits: 1, conflictFiles: [], conflictCommit: null },
      ],
    };
    const restackBtn = (el: GnBranchList) =>
      el.shadowRoot!.querySelector('.restack-btn[data-base="main"]') as HTMLButtonElement | null;
    const settle = async (el: GnBranchList, done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;
    };

    it('offers Restack only when a branch is behind its parent', async () => {
      const el = await createList();
      expect(restackBtn(el)).to.not.be.null;
      mocks({ get_stacks: [{ base: 'main', branches: [{ ...STACKS[0].branches[0] }] }] });
      const el2 = await createList();
      expect(restackBtn(el2)).to.be.null;
    });

    it('previews, confirms with the plan, restacks, reloads and dispatches branches-changed', async () => {
      let confirmText = '';
      mocks({
        preview_restack: PLAN,
        restack: PLAN,
        'plugin:dialog|message': () => 'Ok',
      });
      const inner = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') confirmText = JSON.stringify(args);
        return inner(command, args);
      };
      const el = await createList();
      let changed = false;
      el.addEventListener('branches-changed', () => { changed = true; });
      invokeCalls.length = 0;
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);

      expect(invokeCalls.find((c) => c.command === 'preview_restack')!.args).to.deep.equal({ path: REPO_PATH, base: 'main' });
      expect(confirmText).to.contain('feat-b → onto feat-a (1 commit)');
      expect(confirmText).to.not.contain('feat-a → onto');
      expect(invokeCalls.find((c) => c.command === 'restack')!.args).to.deep.equal({ path: REPO_PATH, base: 'main' });
      expect(toastMessages()).to.include('success:Restacked 1 branch on main');
      expect(changed).to.be.true;
      expect(invokeCalls.filter((c) => c.command === 'get_stacks').length).to.be.greaterThan(0);
    });

    it('explains a predicted conflict and never restacks', async () => {
      mocks({
        preview_restack: {
          ...PLAN,
          canApply: false,
          steps: [
            { ...PLAN.steps[0], status: 'conflict', conflictFiles: ['a.ts'], conflictCommit: 'edit a' },
            { ...PLAN.steps[1], status: 'blocked' },
          ],
        },
      });
      const el = await createList();
      invokeCalls.length = 0;
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);
      expect(toastMessages()[0]).to.match(/^error:Restacking would conflict: feat-a at "edit a" in a\.ts/);
      expect(invokeCalls.some((c) => c.command === 'restack')).to.be.false;
      expect(invokeCalls.some((c) => c.command === 'plugin:dialog|message')).to.be.false;
    });

    it('does nothing when the confirm is declined', async () => {
      mocks({ preview_restack: PLAN, 'plugin:dialog|message': 'Cancel' });
      const el = await createList();
      invokeCalls.length = 0;
      restackBtn(el)!.click();
      await settle(el, () => invokeCalls.some((c) => c.command === 'plugin:dialog|message'));
      await new Promise((r) => setTimeout(r, 20));
      expect(invokeCalls.some((c) => c.command === 'restack')).to.be.false;
      expect(uiStore.getState().toasts).to.have.length(0);
    });

    it('reports an up-to-date stack without confirming', async () => {
      mocks({ preview_restack: { ...PLAN, hasChanges: false } });
      const el = await createList();
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);
      expect(toastMessages()).to.include('info:The stack on main is already up to date');
    });

    it('reports preview and restack failures', async () => {
      mocks({ preview_restack: new Error('scratch worktree failed') });
      const el = await createList();
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);
      expect(toastMessages()[0]).to.equal('error:Could not check the stack: scratch worktree failed');

      uiStore.setState({ toasts: [] });
      mocks({ preview_restack: PLAN, restack: new Error('b is checked out in another worktree') });
      const el2 = await createList();
      restackBtn(el2)!.click();
      await settle(el2, () => toastMessages().length > 0);
      expect(toastMessages()[0]).to.equal('error:Restack failed: b is checked out in another worktree');
    });

    it('releases the ref lock so a second restack can run', async () => {
      mocks({ preview_restack: { ...PLAN, hasChanges: false } });
      const el = await createList();
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);
      uiStore.setState({ toasts: [] });
      restackBtn(el)!.click();
      await settle(el, () => toastMessages().length > 0);
      expect(toastMessages()).to.include('info:The stack on main is already up to date');
    });
  });

  describe('sync stack pull requests', () => {
    const PUSHED = BRANCHES.map((b) => ({ ...b, upstream: b.name === 'main' ? 'origin/main' : `origin/${b.name}`, targetOid: `${b.name}-oid` }));
    const ghPr = (number: number, head: string, base: string) => ({
      number, title: `PR ${number}`, state: 'open', user: { login: 'me' }, headRef: head, baseRef: base,
      draft: false, mergeable: null, htmlUrl: `https://gh/pr/${number}`,
    });
    let confirmText = '';
    const github = (overrides: Record<string, unknown> = {}) => {
      confirmText = '';
      mocks({
        get_branches: PUSHED,
        detect_github_repo: { owner: 'octo', repo: 'gitnado', remoteName: 'origin' },
        get_keyring_token: 'tok',
        list_pull_requests: [ghPr(11, 'feat-a', 'main')],
        create_pull_request: ghPr(12, 'feat-b', 'feat-a'),
        get_pull_request: { body: '' },
        ...overrides,
      });
      const inner = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') confirmText = JSON.stringify(args);
        return inner(command, args);
      };
    };
    const syncBtn = (el: GnBranchList) => el.shadowRoot!.querySelector('.sync-prs-btn') as HTMLButtonElement | null;
    const waitForToast = async () => {
      for (let i = 0; i < 200 && toastMessages().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const createReady = async () => {
      const el = await createList();
      for (let i = 0; i < 100 && !syncBtn(el); i++) {
        await new Promise((r) => setTimeout(r, 10));
        await el.updateComplete;
      }
      return el;
    };

    beforeEach(() => invalidateProviderDetection());

    it('offers Sync PRs only when a hosting provider is detected', async () => {
      github();
      expect(syncBtn(await createReady())).to.not.be.null;
      invalidateProviderDetection();
      mocks();
      const el = await createList();
      await new Promise((r) => setTimeout(r, 50));
      expect(syncBtn(el)).to.be.null;
    });

    it('plans, confirms, creates and updates, then reports and refreshes', async () => {
      github();
      const el = await createReady();
      let changed = false;
      el.addEventListener('branches-changed', () => { changed = true; });
      invokeCalls.length = 0;
      syncBtn(el)!.click();
      await waitForToast();

      expect(confirmText).to.contain('feat-a: update the stack table on pull request 11');
      expect(confirmText).to.contain('feat-b: open a pull request into feat-a');
      expect(invokeCalls.find((c) => c.command === 'create_pull_request')!.args).to.deep.include({ owner: 'octo', repo: 'gitnado' });
      expect(invokeCalls.filter((c) => c.command === 'update_pull_request')).to.have.length(2);
      expect(toastMessages()[0]).to.equal('success:Stack pull requests: created 1 pull request, updated 1 pull request');
      expect(changed).to.be.true;
    });

    it('asks for an account when there is no token', async () => {
      github({ get_keyring_token: null });
      const el = await createReady();
      syncBtn(el)!.click();
      await waitForToast();
      expect(toastMessages()[0]).to.equal('error:Connect a GitHub account to sync pull requests');
      expect(invokeCalls.some((c) => c.command === 'list_pull_requests')).to.be.false;
    });

    it('explains when nothing can be synced and changes nothing', async () => {
      github({ get_branches: BRANCHES });
      const el = await createReady();
      syncBtn(el)!.click();
      await waitForToast();
      expect(toastMessages()[0]).to.match(/^warning:Nothing to sync: feat-a — it has not been pushed yet/);
      expect(confirmText).to.equal('');
    });

    it('does nothing when the confirm is declined, and reports listing failures', async () => {
      github({ 'plugin:dialog|message': 'Cancel' });
      const el = await createReady();
      invokeCalls.length = 0;
      syncBtn(el)!.click();
      for (let i = 0; i < 100 && !confirmText; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30));
      expect(invokeCalls.some((c) => c.command === 'create_pull_request')).to.be.false;
      expect(toastMessages()).to.have.length(0);

      invalidateProviderDetection();
      github({ list_pull_requests: new Error('rate limited') });
      const el2 = await createReady();
      syncBtn(el2)!.click();
      await waitForToast();
      expect(toastMessages()[0]).to.equal('error:Could not read pull requests from GitHub: rate limited');
    });
  });
});
