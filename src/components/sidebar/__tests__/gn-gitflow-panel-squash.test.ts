/**
 * Tests for gn-gitflow-panel squash-finish conflict handling (Fix 6).
 *
 * A git-flow feature finish can be a squash finish. If it hits a merge conflict,
 * the conflict dialog must be told it is a squash (detail.squash = true) so the
 * completion produces a single-parent squash commit rather than a two-parent
 * merge commit. A non-squash finish must dispatch squash = false.
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
import type { GnGitflowPanel } from '../gn-gitflow-panel.ts';
import '../gn-gitflow-panel.ts';
// Import prompt dialog so showPrompt (used by release/hotfix finish) finds it.
import '../../dialogs/gn-prompt-dialog.ts';
import type { GnPromptDialog } from '../../dialogs/gn-prompt-dialog.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function setupMockPrompt(value: string | null): void {
  let dialog = document.querySelector<GnPromptDialog>('gn-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('gn-prompt-dialog') as GnPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => value;
}

function cleanupMockPrompt(): void {
  document.querySelector('gn-prompt-dialog')?.remove();
}

function defaultMockInvoke(command: string): Promise<unknown> {
  // A squash finish discards the branch's individual commits, so it is gated
  // by a confirm. plugin-dialog routes confirm() through `message` and treats
  // the OK button label as confirmed.
  if (command === 'plugin:dialog|message') {
    return Promise.resolve('Ok');
  }
  if (command === 'get_gitflow_config') {
    return Promise.resolve({
      initialized: true,
      masterBranch: 'main',
      developBranch: 'develop',
      featurePrefix: 'feature/',
      releasePrefix: 'release/',
      hotfixPrefix: 'hotfix/',
      supportPrefix: 'support/',
      versionTagPrefix: '',
    });
  }
  if (command === 'get_branches') return Promise.resolve([]);
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnGitflowPanel> {
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnGitflowPanel>(
    html`<gn-gitflow-panel .repositoryPath=${REPO_PATH}></gn-gitflow-panel>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 20));
  return el;
}

interface GitflowFinishDetail {
  kind: 'feature' | 'release' | 'hotfix';
  name: string;
  branchName: string;
  deleteBranch: boolean;
  tagMessage?: string;
  priorFinishCommitLanded?: boolean;
}

interface ConflictDetail {
  operationType: string;
  squash: boolean;
  gitflowFinish?: GitflowFinishDetail;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-gitflow-panel squash finish conflict (Fix 6)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('runs only one squash finish when clicked twice before the confirm resolves', async () => {
    // There is an IPC round trip between the click and the native confirm
    // opening, so a double-click lands a second call in that window. Testing
    // the guard only at function entry let both calls through: two concurrent
    // squash finishes on one repo can double-merge or mint a duplicate squash
    // commit, and the Rust command takes no repo-level lock.
    const el = await createComponent();

    let releaseConfirm!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'plugin:dialog|message') {
        return new Promise((resolve) => {
          releaseConfirm = resolve;
        });
      }
      return defaultMockInvoke(command);
    };

    const internal = el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }, squash?: boolean) => Promise<void>;
    };

    invokeCalls.length = 0;
    const first = internal.handleFinishFeature({ name: 'x', branch: 'feature/x' }, true);
    // Second click lands while the first confirm is still pending.
    const second = internal.handleFinishFeature({ name: 'x', branch: 'feature/x' }, true);

    releaseConfirm('Ok');
    await Promise.all([first, second]);

    expect(
      invokeCalls.filter((c) => c.command === 'plugin:dialog|message'),
      'the second click must not raise a second confirm',
    ).to.have.length(1);
    expect(
      invokeCalls.filter((c) => c.command === 'gitflow_finish_feature'),
      'only one squash finish may run',
    ).to.have.length(1);
  });

  it('releases the re-entrancy guard when the squash confirm is declined', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'plugin:dialog|message') return Promise.resolve('Cancel');
      return defaultMockInvoke(command);
    };

    const internal = el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }, squash?: boolean) => Promise<void>;
      operationInProgress: boolean;
    };

    await internal.handleFinishFeature({ name: 'x', branch: 'feature/x' }, true);

    expect(
      internal.operationInProgress,
      'declining must not leave the panel wedged',
    ).to.equal(false);
  });

  it('does not squash-finish when the confirm is declined', async () => {
    // A squash finish collapses the branch to one commit and deletes it, so
    // every original commit becomes unreachable. gitflow deletes via git2
    // directly, bypassing delete_branch's merged-check, so this confirm is the
    // only gate on the whole path.
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'plugin:dialog|message') return Promise.resolve('Cancel');
      return defaultMockInvoke(command);
    };

    invokeCalls.length = 0;
    await (el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }, squash?: boolean) => Promise<void>;
    }).handleFinishFeature({ name: 'x', branch: 'feature/x' }, true);

    expect(
      invokeCalls.filter((c) => c.command === 'gitflow_finish_feature'),
      'declining must not run the squash finish',
    ).to.have.length(0);
  });

  it('does not confirm for an ordinary (non-squash) finish', async () => {
    // The plain finish keeps the branch's commits reachable via the merge, so
    // it must not acquire a gate the squash path needs.
    const el = await createComponent();
    invokeCalls.length = 0;

    await (el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }, squash?: boolean) => Promise<void>;
    }).handleFinishFeature({ name: 'x', branch: 'feature/x' }, false);

    expect(invokeCalls.filter((c) => c.command === 'plugin:dialog|message')).to.have.length(0);
    expect(invokeCalls.filter((c) => c.command === 'gitflow_finish_feature')).to.have.length(1);
  });

  it('dispatches squash=true when a squash finish hits a merge conflict', async () => {
    const el = await createComponent();

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'gitflow_finish_feature') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflict' });
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }, squash?: boolean) => Promise<void>;
    }).handleFinishFeature({ name: 'x', branch: 'feature/x' }, true);

    // The finish itself was invoked with squash=true.
    const finishCall = invokeCalls.find((c) => c.command === 'gitflow_finish_feature');
    expect(finishCall, 'gitflow_finish_feature invoked').to.exist;
    expect((finishCall!.args as Record<string, unknown>).squash).to.equal(true);

    // The conflict dialog was told it is a squash.
    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.operationType).to.equal('merge');
    expect(detail!.squash).to.be.true;

    // The finish context is threaded so the dialog can complete the finish
    // (delete the feature branch) after the conflict is resolved.
    expect(detail!.gitflowFinish, 'gitflowFinish present').to.exist;
    expect(detail!.gitflowFinish!.kind).to.equal('feature');
    expect(detail!.gitflowFinish!.name).to.equal('x');
    expect(detail!.gitflowFinish!.branchName).to.equal('feature/x');
    expect(detail!.gitflowFinish!.deleteBranch).to.be.true;
  });

  it('renders a Squash button on feature items that finishes with squash=true', async () => {
    const el = await createComponent();

    // Populate an active feature item, then reload the active-items list.
    mockInvoke = (command: string) => {
      if (command === 'get_branches') {
        return Promise.resolve([{ name: 'feature/x', isRemote: false }]);
      }
      return defaultMockInvoke(command);
    };
    await (el as unknown as { loadActiveItems: () => Promise<void> }).loadActiveItems();
    await el.updateComplete;

    const squashBtn = el.shadowRoot!.querySelector('.item-squash-btn') as HTMLButtonElement;
    expect(squashBtn, 'squash button rendered on feature item').to.exist;

    // Clicking the squash affordance must invoke the finish with squash=true.
    squashBtn.click();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    const finishCall = invokeCalls.find((c) => c.command === 'gitflow_finish_feature');
    expect(finishCall, 'gitflow_finish_feature invoked from squash button').to.exist;
    expect((finishCall!.args as Record<string, unknown>).squash).to.equal(true);
  });

  it('dispatches squash=false for a normal (non-squash) finish conflict', async () => {
    const el = await createComponent();

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'gitflow_finish_feature') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflict' });
      }
      return defaultMockInvoke(command);
    };

    // Default UI path: handleFinishFeature(item) with no squash arg.
    await (el as unknown as {
      handleFinishFeature: (item: { name: string; branch: string }) => Promise<void>;
    }).handleFinishFeature({ name: 'y', branch: 'feature/y' });

    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.operationType).to.equal('merge');
    expect(detail!.squash).to.be.false;

    // Non-squash feature finish still threads a feature finish context.
    expect(detail!.gitflowFinish, 'gitflowFinish present').to.exist;
    expect(detail!.gitflowFinish!.kind).to.equal('feature');
    expect(detail!.gitflowFinish!.name).to.equal('y');
    expect(detail!.gitflowFinish!.branchName).to.equal('feature/y');
  });

  it('threads a release finish context when a release finish conflicts', async () => {
    const el = await createComponent();
    setupMockPrompt('Release 1.0.0');

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'gitflow_finish_release') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflict' });
      }
      if (command === 'get_branches') {
        // HEAD on develop → the backend already merged+tagged master before
        // conflicting on the develop merge.
        return Promise.resolve([{ name: 'develop', isHead: true, isRemote: false }]);
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as {
      handleFinishRelease: (item: { name: string; branch: string }) => Promise<void>;
    }).handleFinishRelease({ name: '1.0.0', branch: 'release/1.0.0' });

    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.operationType).to.equal('merge');
    expect(detail!.squash).to.be.false;
    expect(detail!.gitflowFinish, 'gitflowFinish present').to.exist;
    expect(detail!.gitflowFinish!.kind).to.equal('release');
    expect(detail!.gitflowFinish!.name).to.equal('1.0.0');
    expect(detail!.gitflowFinish!.branchName).to.equal('release/1.0.0');
    expect(detail!.gitflowFinish!.deleteBranch).to.be.true;
    expect(detail!.gitflowFinish!.tagMessage).to.equal('Release 1.0.0');
    // Develop-stage conflict: master merge + tag already landed.
    expect(detail!.gitflowFinish!.priorFinishCommitLanded).to.be.true;

    cleanupMockPrompt();
  });

  it('marks priorFinishCommitLanded false when the master merge itself conflicts', async () => {
    const el = await createComponent();
    setupMockPrompt('Release 2.0.0');

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'gitflow_finish_release') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflict' });
      }
      if (command === 'get_branches') {
        // HEAD still on master → the master merge itself conflicted; no tag yet.
        return Promise.resolve([{ name: 'main', isHead: true, isRemote: false }]);
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as {
      handleFinishRelease: (item: { name: string; branch: string }) => Promise<void>;
    }).handleFinishRelease({ name: '2.0.0', branch: 'release/2.0.0' });

    expect(detail!.gitflowFinish!.priorFinishCommitLanded).to.not.be.true;

    cleanupMockPrompt();
  });

  it('threads a hotfix finish context when a hotfix finish conflicts', async () => {
    const el = await createComponent();
    setupMockPrompt('Hotfix 1.0.1');

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'gitflow_finish_hotfix') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflict' });
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as {
      handleFinishHotfix: (item: { name: string; branch: string }) => Promise<void>;
    }).handleFinishHotfix({ name: '1.0.1', branch: 'hotfix/1.0.1' });

    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.gitflowFinish, 'gitflowFinish present').to.exist;
    expect(detail!.gitflowFinish!.kind).to.equal('hotfix');
    expect(detail!.gitflowFinish!.name).to.equal('1.0.1');
    expect(detail!.gitflowFinish!.branchName).to.equal('hotfix/1.0.1');
    expect(detail!.gitflowFinish!.deleteBranch).to.be.true;
    expect(detail!.gitflowFinish!.tagMessage).to.equal('Hotfix 1.0.1');

    cleanupMockPrompt();
  });
});
