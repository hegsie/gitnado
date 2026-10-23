/**
 * Multi-repo pinning tests for the create-tag and create-branch dialogs.
 *
 * Both dialogs' `repositoryPath` property is bound live to the active tab in
 * app-shell. If the user opens the dialog on repo A and switches tabs to repo B
 * while the modal is open, Create must still target repo A (the repo the dialog
 * was opened for), and the created event must carry A so the host pins its
 * refresh there — not silently mutate/refresh B.
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

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnCreateTagDialog } from '../gn-create-tag-dialog.ts';
import type { GnCreateBranchDialog } from '../gn-create-branch-dialog.ts';
import '../gn-create-tag-dialog.ts';
import '../gn-create-branch-dialog.ts';

const REPO_A = '/repo/a';
const REPO_B = '/repo/b';

describe('create-branch start point does not leak between entry points', () => {
  it('reopening without a start point clears the one set by "Create branch from here"', async () => {
    // One shared dialog serves the context menu, the palette and Ctrl+Shift+N.
    // reset() cleared every field except startPoint, so a ref picked once from
    // the context menu stuck for the session: every later Create Branch cut
    // from that ref instead of HEAD, shown only in a disabled "Based on" field.
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`,
    );
    await el.updateComplete;

    el.open('origin/feature');
    await el.updateComplete;
    expect(el.startPoint).to.equal('origin/feature');

    el.close();
    await el.updateComplete;

    el.open();
    await el.updateComplete;
    expect(el.startPoint, 'a fresh open starts from HEAD').to.equal('');
  });

  it('create_branch is invoked with no start point after a reopen', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`,
    );
    await el.updateComplete;

    el.open('origin/feature');
    await el.updateComplete;
    el.close();
    await el.updateComplete;

    el.open();
    await el.updateComplete;
    (el as unknown as { branchName: string }).branchName = 'feature/new';
    invokeCalls.length = 0;
    await (el as unknown as { handleCreate: () => Promise<void> }).handleCreate();

    const call = invokeCalls.find((c) => c.command === 'create_branch');
    expect(call, 'create_branch invoked').to.not.be.undefined;
    const args = call!.args as { startPoint?: string };
    expect(args.startPoint, 'cut from HEAD, not the stale ref').to.be.undefined;
  });

  it('an explicit start point still reaches create_branch', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`,
    );
    await el.updateComplete;

    el.open('origin/feature');
    await el.updateComplete;
    (el as unknown as { branchName: string }).branchName = 'feature/new';
    invokeCalls.length = 0;
    await (el as unknown as { handleCreate: () => Promise<void> }).handleCreate();

    const args = invokeCalls.find((c) => c.command === 'create_branch')!.args as {
      startPoint?: string;
    };
    expect(args.startPoint).to.equal('origin/feature');
  });
});

describe('create-tag / create-branch dialog pinning', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    mockInvoke = () => Promise.resolve(null);
  });

  it('create-tag targets the repo it was opened for after a mid-dialog tab switch', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${REPO_A}></gn-create-tag-dialog>`,
    );
    await el.updateComplete;

    let detail: { repositoryPath?: string } | null = null;
    el.addEventListener('tag-created', (e) => {
      detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    });

    // Open the dialog on repo A, then switch the (live) prop to repo B.
    el.open();
    await el.updateComplete;
    el.repositoryPath = REPO_B;
    await el.updateComplete;

    // Fill in a non-annotated tag and create.
    const internal = el as unknown as {
      name: string;
      isAnnotated: boolean;
      handleCreate: () => Promise<void>;
    };
    internal.name = 'v1.0.0';
    internal.isAnnotated = false;
    invokeCalls.length = 0;
    await internal.handleCreate();

    const call = invokeCalls.find((c) => c.command === 'create_tag');
    expect(call, 'create_tag called').to.not.be.undefined;
    expect((call!.args as { path: string }).path).to.equal(REPO_A);
    expect(detail, 'tag-created dispatched').to.not.be.null;
    expect(detail!.repositoryPath).to.equal(REPO_A);
  });

  it('create-tag exposes its pinned repo only while open, for host self-close', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${REPO_A}></gn-create-tag-dialog>`,
    );
    await el.updateComplete;

    expect(el.pinnedRepositoryPathIfOpen, 'null before open').to.be.null;
    el.open();
    await el.updateComplete;
    expect(el.pinnedRepositoryPathIfOpen, 'pinned repo while open').to.equal(REPO_A);
    el.close();
    expect(el.pinnedRepositoryPathIfOpen, 'null after close').to.be.null;
  });

  it('create-branch targets the repo it was opened for after a mid-dialog tab switch', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`,
    );
    await el.updateComplete;

    let detail: { repositoryPath?: string } | null = null;
    el.addEventListener('branch-created', (e) => {
      detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    });

    el.open();
    await el.updateComplete;
    el.repositoryPath = REPO_B;
    await el.updateComplete;

    const internal = el as unknown as {
      branchName: string;
      handleCreate: () => Promise<void>;
    };
    internal.branchName = 'feature/x';
    invokeCalls.length = 0;
    await internal.handleCreate();

    const call = invokeCalls.find((c) => c.command === 'create_branch');
    expect(call, 'create_branch called').to.not.be.undefined;
    expect((call!.args as { path: string }).path).to.equal(REPO_A);
    expect(detail, 'branch-created dispatched').to.not.be.null;
    expect(detail!.repositoryPath).to.equal(REPO_A);
  });

  it('create-branch exposes its pinned repo only while open, for host self-close', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`,
    );
    await el.updateComplete;

    expect(el.pinnedRepositoryPathIfOpen, 'null before open').to.be.null;
    el.open();
    await el.updateComplete;
    expect(el.pinnedRepositoryPathIfOpen, 'pinned repo while open').to.equal(REPO_A);
    el.close();
    expect(el.pinnedRepositoryPathIfOpen, 'null after close').to.be.null;
  });
});

describe('create-tag / create-branch deferred reveal', () => {
  // open() defers `modal.open = true` until after the reset render commits, so
  // that a field typed into immediately is not overwritten by the pending
  // render. That deferral must not resurrect a dialog closed in the meantime —
  // e.g. by the host's tab-close sweep — which would leave modal.open true
  // while isOpen is false: a visible dialog the app believes is shut.
  it('does not re-reveal the tag dialog when close() lands first', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${REPO_A}></gn-create-tag-dialog>`
    );
    await el.updateComplete;

    el.open();
    el.close();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    const modal = el.shadowRoot!.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal.open, 'modal must stay closed').to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).isOpen, 'isOpen agrees with the modal').to.be.false;
  });

  it('does not re-reveal the branch dialog when close() lands first', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${REPO_A}></gn-create-branch-dialog>`
    );
    await el.updateComplete;

    el.open();
    el.close();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    const modal = el.shadowRoot!.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal.open, 'modal must stay closed').to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).isOpen, 'isOpen agrees with the modal').to.be.false;
  });

  it('still opens normally when close() does not intervene', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${REPO_A}></gn-create-tag-dialog>`
    );
    await el.updateComplete;

    el.open();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    const modal = el.shadowRoot!.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal.open, 'deferral still reveals the dialog').to.be.true;
  });
});

