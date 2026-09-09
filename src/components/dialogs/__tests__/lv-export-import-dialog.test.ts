/**
 * Export / Import Dialog Tests
 *
 * These render the REAL lv-export-import-dialog, mock only the Tauri invoke
 * layer (git commands AND the dialog plugin's file pickers), and verify the
 * component calls the right commands with the right arguments and shows the
 * user what happened.
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
import '../lv-export-import-dialog.ts';
import type { LvExportImportDialog, ExportImportOpenOptions } from '../lv-export-import-dialog.ts';
import type { LvModal } from '../lv-modal.ts';
import type { Branch, Commit } from '../../../types/git.types.ts';
import { uiStore } from '../../../stores/index.ts';
import { resetOverlayStack } from '../../../utils/overlay-stack.ts';
import { tryAcquireRefOp, isRefOpRunning, resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

// ── Fixtures ───────────────────────────────────────────────────────────────
function makeBranch(shorthand: string, isRemote = false): Branch {
  return {
    name: isRemote ? `refs/remotes/${shorthand}` : `refs/heads/${shorthand}`,
    shorthand,
    isHead: shorthand === 'main',
    isRemote,
    upstream: null,
    targetOid: 'a'.repeat(40),
    isStale: false,
  };
}

function makeCommit(oid: string, summary: string, timestamp: number): Commit {
  return {
    oid,
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: null,
    author: { name: 'A', email: 'a@example.com', timestamp },
    committer: { name: 'A', email: 'a@example.com', timestamp },
    parentIds: [],
    timestamp,
  };
}

const BRANCHES = [makeBranch('main'), makeBranch('feature/x'), makeBranch('origin/main', true)];
const TAGS = [{ name: 'v1.0', oid: 'b'.repeat(40) }];

const OID_NEW = '3'.repeat(40);
const OID_MID = '2'.repeat(40);
const OID_OLD = '1'.repeat(40);
// Newest-first, exactly the order the graph hands them over.
const COMMITS = [
  makeCommit(OID_NEW, 'newest change', 300),
  makeCommit(OID_MID, 'middle change', 200),
  makeCommit(OID_OLD, 'oldest change', 100),
];

const ARCHIVE_FILES = ['README.md', 'src/main.ts', 'src/app.ts'];
const BUNDLE_HEADS = [
  { name: 'refs/heads/main', oid: 'c'.repeat(40) },
  { name: 'refs/tags/v2.0', oid: 'd'.repeat(40) },
];

// ── Mock plumbing ──────────────────────────────────────────────────────────
let dialogOpenResult: string | string[] | null = null;
let dialogSaveResult: string | null = null;
/** command → override that wins over the default answer. */
let overrides: Record<string, () => Promise<unknown>> = {};

function setupMocks(): void {
  mockInvoke = (command) => {
    const override = overrides[command];
    if (override) return override();
    switch (command) {
      case 'get_archive_files':
        return Promise.resolve(ARCHIVE_FILES);
      case 'create_archive':
        return Promise.resolve(dialogSaveResult);
      case 'create_patch':
        return Promise.resolve(['/out/0001-a.patch']);
      case 'apply_patch':
      case 'apply_patch_to_index':
        return Promise.resolve(null);
      case 'bundle_create':
        return Promise.resolve({ bundlePath: '/tmp/x.bundle', refsCount: 4, objectsCount: 42 });
      case 'bundle_list_heads':
        return Promise.resolve(BUNDLE_HEADS);
      case 'bundle_verify':
        return Promise.resolve({ isValid: true, refs: BUNDLE_HEADS, requires: [], message: null });
      case 'bundle_unbundle':
        return Promise.resolve(BUNDLE_HEADS);
      case 'plugin:dialog|open':
        return Promise.resolve(dialogOpenResult);
      case 'plugin:dialog|save':
        return Promise.resolve(dialogSaveResult);
      case 'plugin:notification|is_permission_granted':
        return Promise.resolve(false);
      default:
        return Promise.resolve(null);
    }
  };
}

function calls(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function argsOf(name: string): Record<string, unknown> {
  const found = calls(name);
  expect(found.length, `expected an invoke of ${name}`).to.be.greaterThan(0);
  return found[found.length - 1].args as Record<string, unknown>;
}

function lastToast(): { type: string; message: string } | undefined {
  const toasts = uiStore.getState().toasts;
  return toasts[toasts.length - 1];
}

async function openDialogAt(
  opts: ExportImportOpenOptions,
  commits: Commit[] = COMMITS,
): Promise<LvExportImportDialog> {
  const el = await fixture<LvExportImportDialog>(html`
    <lv-export-import-dialog
      .repositoryPath=${REPO_PATH}
      .graphRepositoryPath=${REPO_PATH}
      .branches=${BRANCHES}
      .tags=${TAGS}
      .commits=${commits}
    ></lv-export-import-dialog>
  `);
  el.open(opts);
  await el.updateComplete;
  // The dialog reveals the modal in a microtask after its reset render.
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function q<T extends Element>(el: LvExportImportDialog, selector: string): T {
  const found = el.shadowRoot?.querySelector<T>(selector);
  expect(found, `expected ${selector} in the dialog`).to.exist;
  return found as T;
}

function modalOf(el: LvExportImportDialog): LvModal {
  return q<LvModal>(el, 'lv-modal');
}

async function click(el: LvExportImportDialog, selector: string): Promise<void> {
  q<HTMLButtonElement>(el, selector).click();
  await settle(el);
}

/** Let a pending answer land and the dialog re-render on it. */
async function settle(el: LvExportImportDialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

describe('lv-export-import-dialog', () => {
  beforeEach(() => {
    resetOverlayStack();
    resetRefOpLocks();
    invokeHistory.length = 0;
    overrides = {};
    dialogOpenResult = null;
    dialogSaveResult = null;
    uiStore.setState({ toasts: [] });
    setupMocks();
  });

  // ── Archive ──────────────────────────────────────────────────────────────
  describe('archive', () => {
    it('keeps ref data pinned when the host switches repositories', async () => {
      const el = await openDialogAt({ tab: 'archive' });
      el.repositoryPath = '/repo/other';
      el.graphRepositoryPath = '/repo/other';
      el.branches = [makeBranch('other-repo-only')];
      el.tags = [{ name: 'other-tag', oid: 'other-oid' }];
      await el.updateComplete;

      const values = Array.from(q<HTMLSelectElement>(el, '#archive-ref').options).map(
        (option) => option.value
      );
      expect(values).to.include('feature/x');
      expect(values).to.include('v1.0');
      expect(values).not.to.include('other-repo-only');
      expect(values).not.to.include('other-tag');
    });

    it('accepts ref data that finishes loading for the pinned repository', async () => {
      const el = await openDialogAt({ tab: 'archive' });
      el.tags = [...TAGS, { name: 'late-tag', oid: 'late-oid' }];
      await el.updateComplete;
      el.repositoryPath = '/repo/other';
      el.graphRepositoryPath = '/repo/other';
      el.tags = [{ name: 'other-tag', oid: 'other-oid' }];
      await el.updateComplete;

      const values = Array.from(q<HTMLSelectElement>(el, '#archive-ref').options).map(
        (option) => option.value
      );
      expect(values).to.include('late-tag');
      expect(values).not.to.include('other-tag');
    });

    it('does not adopt foreign graph refs when switching back to the pinned repository', async () => {
      const el = await openDialogAt({ tab: 'archive' });
      el.repositoryPath = '/repo/other';
      el.graphRepositoryPath = '/repo/other';
      el.tags = [{ name: 'other-tag', oid: 'other-oid' }];
      await el.updateComplete;

      el.repositoryPath = REPO_PATH;
      el.tags = [{ name: 'still-other-tag', oid: 'still-other-oid' }];
      await el.updateComplete;

      const values = Array.from(q<HTMLSelectElement>(el, '#archive-ref').options).map(
        (option) => option.value
      );
      expect(values).to.include('v1.0');
      expect(values).not.to.include('still-other-tag');
    });

    it('loads the file preview for the ref it was opened on', async () => {
      const el = await openDialogAt({ tab: 'archive', ref: 'v1.0' });

      expect(argsOf('get_archive_files')).to.deep.equal({
        path: REPO_PATH,
        treeRef: 'v1.0',
      });
      const count = q<HTMLElement>(el, '[data-testid="archive-file-count"]');
      expect(count.textContent?.trim()).to.equal('3 files');
      // The deep-linked ref is the one the select shows, not a HEAD fallback.
      expect(q<HTMLSelectElement>(el, '#archive-ref').value).to.equal('v1.0');
    });

    it('exports to the path chosen in the save dialog', async () => {
      dialogSaveResult = '/tmp/repo.zip';
      const el = await openDialogAt({ tab: 'archive', ref: 'v1.0' });

      await click(el, '[data-testid="archive-export"]');

      expect(argsOf('create_archive')).to.deep.equal({
        path: REPO_PATH,
        outputPath: '/tmp/repo.zip',
        treeRef: 'v1.0',
        format: 'zip',
        prefix: undefined,
      });
      expect(lastToast()?.type).to.equal('success');
      expect(lastToast()?.message).to.contain('/tmp/repo.zip');
    });

    it('suggests a filename whose extension follows the format select', async () => {
      dialogSaveResult = '/tmp/repo.tar.gz';
      const el = await openDialogAt({ tab: 'archive' });

      const format = q<HTMLSelectElement>(el, '#archive-format');
      format.value = 'tar.gz';
      format.dispatchEvent(new Event('change'));
      await el.updateComplete;

      await click(el, '[data-testid="archive-export"]');

      const saveArgs = argsOf('plugin:dialog|save') as { options?: { defaultPath?: string } };
      const defaultPath =
        saveArgs.options?.defaultPath ?? (saveArgs as { defaultPath?: string }).defaultPath;
      expect(defaultPath, 'the picker must suggest the selected format').to.be.a('string');
      expect(defaultPath as string).to.match(/\.tar\.gz$/);
      expect(argsOf('create_archive').format).to.equal('tar.gz');
    });

    it('keeps the dialog open and shows the backend message when the export fails', async () => {
      dialogSaveResult = '/tmp/repo.zip';
      overrides['create_archive'] = () =>
        Promise.reject(new Error('fatal: not a valid object name'));
      const el = await openDialogAt({ tab: 'archive' });

      await click(el, '[data-testid="archive-export"]');

      expect(q<HTMLElement>(el, '[data-testid="dialog-error"]').textContent).to.contain(
        'not a valid object name',
      );
      expect(modalOf(el).open, 'a failure must not be a dead end').to.be.true;
      expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO_PATH);
    });

    it('treats a cancelled save picker as a cancel, not a failure', async () => {
      dialogSaveResult = null;
      const el = await openDialogAt({ tab: 'archive' });

      await click(el, '[data-testid="archive-export"]');

      expect(calls('create_archive')).to.have.length(0);
      expect(el.shadowRoot?.querySelector('[data-testid="dialog-error"]')).to.be.null;
      expect(modalOf(el).open).to.be.true;
    });
  });

  // ── Patch ────────────────────────────────────────────────────────────────
  describe('patch', () => {
    it('numbers the patch series oldest-first', async () => {
      dialogOpenResult = '/tmp/patches';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'create' });

      // Ticked newest-first, the same order the graph lists them.
      q<HTMLInputElement>(el, `input[data-oid="${OID_NEW}"]`).click();
      await el.updateComplete;
      q<HTMLInputElement>(el, `input[data-oid="${OID_OLD}"]`).click();
      await el.updateComplete;

      await click(el, '[data-testid="patch-create"]');

      expect(argsOf('create_patch')).to.deep.equal({
        path: REPO_PATH,
        commitOids: [OID_OLD, OID_NEW],
        outputPath: '/tmp/patches',
      });
      expect(lastToast()?.type).to.equal('success');
    });

    it('breaks a commit-time tie with graph order, never child before parent', async () => {
      // Git stamps commit times to the second, so a parent and the child made
      // right after it routinely share one. Timestamp alone cannot order them,
      // and a stable sort would leave them in the order they were ticked.
      const TIED_CHILD = '5'.repeat(40);
      const TIED_PARENT = '4'.repeat(40);
      const tied = [
        makeCommit(TIED_CHILD, 'child change', 500),
        makeCommit(TIED_PARENT, 'parent change', 500),
      ];
      dialogOpenResult = '/tmp/patches';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'create' }, tied);

      // Ticked newest-first, exactly how the list reads top to bottom.
      q<HTMLInputElement>(el, `input[data-oid="${TIED_CHILD}"]`).click();
      await el.updateComplete;
      q<HTMLInputElement>(el, `input[data-oid="${TIED_PARENT}"]`).click();
      await el.updateComplete;

      await click(el, '[data-testid="patch-create"]');

      // Parent first, or `git am` cannot replay the series.
      expect(argsOf('create_patch')).to.deep.equal({
        path: REPO_PATH,
        commitOids: [TIED_PARENT, TIED_CHILD],
        outputPath: '/tmp/patches',
      });
    });

    it('pre-checks the commit it was deep-linked from', async () => {
      const el = await openDialogAt({ tab: 'patch', patchMode: 'create', commitOid: OID_MID });
      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_MID}"]`).checked).to.be.true;
    });

    it('pre-checks every commit of a graph multi-selection', async () => {
      const el = await openDialogAt({
        tab: 'patch',
        patchMode: 'create',
        commitOids: [OID_NEW, OID_OLD],
      });

      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_NEW}"]`).checked).to.be.true;
      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_OLD}"]`).checked).to.be.true;
      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_MID}"]`).checked).to.be.false;
      expect(q<HTMLElement>(el, '[data-testid="patch-selected-count"]').textContent).to.contain(
        '2 selected',
      );
    });

    it('keeps every deep-linked commit visible under a filter that hides them', async () => {
      // The rows the dialog says are ticked have to stay on screen, or the
      // count claims a selection the user cannot see or undo.
      const el = await openDialogAt({
        tab: 'patch',
        patchMode: 'create',
        commitOids: [OID_NEW, OID_OLD],
      });

      const filter = q<HTMLInputElement>(el, '#commit-filter');
      filter.value = 'middle';
      filter.dispatchEvent(new Event('input'));
      await settle(el);

      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_NEW}"]`).checked).to.be.true;
      expect(q<HTMLInputElement>(el, `input[data-oid="${OID_OLD}"]`).checked).to.be.true;
      expect(el.shadowRoot?.querySelectorAll('.list-row.pinned')).to.have.length(2);
      expect(el.shadowRoot?.querySelector('.empty'), 'the matching row is still listed').to.not
        .exist;
    });

    it('writes a multi-selection series oldest first', async () => {
      dialogOpenResult = '/tmp/patches';
      const el = await openDialogAt({
        tab: 'patch',
        patchMode: 'create',
        commitOids: [OID_NEW, OID_OLD],
      });

      await click(el, '[data-testid="patch-create"]');

      expect(argsOf('create_patch')).to.deep.equal({
        path: REPO_PATH,
        commitOids: [OID_OLD, OID_NEW],
        outputPath: '/tmp/patches',
      });
    });

    it('Check runs a dry run and applies nothing', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-check"]'); // disabled: no file yet
      expect(calls('apply_patch')).to.have.length(0);

      await click(el, '[data-testid="patch-choose-file"]');
      await click(el, '[data-testid="patch-check"]');

      const applyCalls = calls('apply_patch');
      expect(applyCalls).to.have.length(1);
      expect((applyCalls[0].args as { checkOnly?: boolean }).checkOnly).to.be.true;
      expect(applyCalls.filter((c) => !(c.args as { checkOnly?: boolean }).checkOnly)).to.have.length(
        0,
      );
      expect(lastToast()?.message).to.contain('applies cleanly');
      expect(modalOf(el).open, 'a check leaves the dialog open').to.be.true;
    });

    it('applies to the repo it was opened on, not the tab that is active now', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-choose-file"]');

      // The user switches tabs behind the open modal.
      el.repositoryPath = '/other/repo';
      await el.updateComplete;

      let detail: { repositoryPath?: string } | null = null;
      el.addEventListener('patch-applied', (e) => {
        detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
      });

      await click(el, '[data-testid="patch-apply"]');

      expect(argsOf('apply_patch')).to.deep.equal({
        path: REPO_PATH,
        patchPath: '/tmp/fix.patch',
        checkOnly: undefined,
      });
      expect(detail).to.not.be.null;
      expect(detail!.repositoryPath).to.equal(REPO_PATH);
    });

    it('applies to the index through apply_patch_to_index', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-choose-file"]');

      const indexRadio = q<HTMLInputElement>(el, 'input[name="patch-target"][value="index"]');
      indexRadio.click();
      await el.updateComplete;

      await click(el, '[data-testid="patch-apply"]');

      expect(calls('apply_patch_to_index')).to.have.length(1);
      expect(calls('apply_patch')).to.have.length(0);
    });

    it('reports a failed apply inline, dispatches nothing, and releases the lock', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      overrides['apply_patch'] = () => Promise.reject(new Error('patch does not apply'));
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-choose-file"]');

      let dispatched = false;
      el.addEventListener('patch-applied', () => {
        dispatched = true;
      });

      await click(el, '[data-testid="patch-apply"]');

      expect(q<HTMLElement>(el, '[data-testid="dialog-error"]').textContent).to.contain(
        'patch does not apply',
      );
      expect(dispatched, 'a failed apply must not claim the repo changed').to.be.false;
      expect(isRefOpRunning(REPO_PATH), 'the lock is released in a finally').to.be.false;
      expect(modalOf(el).open).to.be.true;
    });

    it('greys out Apply while another operation holds the repository', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-choose-file"]');

      tryAcquireRefOp(REPO_PATH);
      await el.updateComplete;

      const apply = q<HTMLButtonElement>(el, '[data-testid="patch-apply"]');
      expect(apply.disabled).to.be.true;
      apply.click();
      await el.updateComplete;
      expect(calls('apply_patch')).to.have.length(0);
    });

    it('disables Apply and Check until a patch file is chosen', async () => {
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      expect(q<HTMLButtonElement>(el, '[data-testid="patch-apply"]').disabled).to.be.true;
      expect(q<HTMLButtonElement>(el, '[data-testid="patch-check"]').disabled).to.be.true;
    });

    it('refuses dismissal while an apply is in flight', async () => {
      dialogOpenResult = '/tmp/fix.patch';
      let release: (() => void) | null = null;
      overrides['apply_patch'] = () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        });
      const el = await openDialogAt({ tab: 'patch', patchMode: 'apply' });
      await click(el, '[data-testid="patch-choose-file"]');

      q<HTMLButtonElement>(el, '[data-testid="patch-apply"]').click();
      await el.updateComplete;
      expect(el.operationInFlight).to.be.true;

      // The × / Escape route: lv-modal drops `open` then dispatches `close`.
      modalOf(el).close();
      await el.updateComplete;
      expect(modalOf(el).open, 'an in-flight apply owns the dialog').to.be.true;

      release!();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
      expect(el.operationInFlight).to.be.false;
      expect(modalOf(el).open).to.be.false;
    });
  });

  // ── Bundle ───────────────────────────────────────────────────────────────
  describe('bundle', () => {
    it('verifies and lists the heads of the chosen bundle', async () => {
      dialogOpenResult = '/tmp/x.bundle';
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'import' });

      await click(el, '[data-testid="bundle-choose-file"]');

      expect(argsOf('bundle_list_heads')).to.deep.equal({ bundlePath: '/tmp/x.bundle' });
      expect(argsOf('bundle_verify')).to.deep.equal({
        path: REPO_PATH,
        bundlePath: '/tmp/x.bundle',
      });
      const text = el.shadowRoot?.textContent ?? '';
      expect(text).to.contain('refs/heads/main');
      expect(text).to.contain('refs/tags/v2.0');
    });

    it('disables Import for a bundle whose prerequisites are missing', async () => {
      dialogOpenResult = '/tmp/x.bundle';
      overrides['bundle_verify'] = () =>
        Promise.resolve({
          isValid: false,
          refs: BUNDLE_HEADS,
          requires: ['f'.repeat(40)],
          message: 'repository lacks these prerequisite commits',
        });
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'import' });

      await click(el, '[data-testid="bundle-choose-file"]');

      expect(q<HTMLButtonElement>(el, '[data-testid="bundle-import"]').disabled).to.be.true;
      const warn = q<HTMLElement>(el, '[data-testid="bundle-unimportable"]');
      expect(warn.textContent).to.contain('prerequisite');
      expect(warn.textContent).to.contain('f'.repeat(40));
    });

    it('ignores a late inspection for a bundle that is no longer the chosen one', async () => {
      // The Choose button stays live while an inspection runs, so a second
      // pick can overtake the first. The first bundle's verdict must not be
      // shown for — or unlock Import on — the bundle chosen after it.
      const settleVerify: Array<(v: unknown) => void> = [];
      overrides['bundle_verify'] = () =>
        new Promise((resolve) => {
          settleVerify.push(resolve);
        });

      dialogOpenResult = '/tmp/stale.bundle';
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'import' });
      await click(el, '[data-testid="bundle-choose-file"]');

      dialogOpenResult = '/tmp/current.bundle';
      await click(el, '[data-testid="bundle-choose-file"]');

      expect(settleVerify).to.have.length(2);

      // The bundle chosen second answers first: it cannot be applied here.
      settleVerify[1]({
        isValid: false,
        refs: BUNDLE_HEADS,
        requires: ['f'.repeat(40)],
        message: 'repository lacks these prerequisite commits',
      });
      await settle(el);

      // The bundle chosen first answers late, and says it is applicable.
      settleVerify[0]({ isValid: true, refs: BUNDLE_HEADS, requires: [], message: null });
      await settle(el);

      expect(q<HTMLElement>(el, '[data-testid="chosen-bundle-file"]').textContent?.trim()).to.equal(
        '/tmp/current.bundle',
      );
      expect(q<HTMLButtonElement>(el, '[data-testid="bundle-import"]').disabled).to.be.true;
      expect(q<HTMLElement>(el, '[data-testid="bundle-unimportable"]').textContent).to.contain(
        'prerequisite',
      );
    });

    it('import dispatches bundle-imported with the pinned path and toasts the ref count', async () => {
      dialogOpenResult = '/tmp/x.bundle';
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'import' });
      await click(el, '[data-testid="bundle-choose-file"]');

      let detail: { repositoryPath?: string; refs?: unknown[] } | null = null;
      el.addEventListener('bundle-imported', (e) => {
        detail = (e as CustomEvent<{ repositoryPath?: string; refs?: unknown[] }>).detail;
      });

      await click(el, '[data-testid="bundle-import"]');

      expect(argsOf('bundle_unbundle')).to.deep.equal({
        path: REPO_PATH,
        bundlePath: '/tmp/x.bundle',
      });
      expect(detail).to.not.be.null;
      expect(detail!.repositoryPath).to.equal(REPO_PATH);
      expect(lastToast()?.message).to.contain('Imported 2 refs');
      expect(isRefOpRunning(REPO_PATH)).to.be.false;
    });

    it('creates with --all by default and with explicit refs when it is off', async () => {
      dialogSaveResult = '/tmp/out.bundle';
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'create' });

      await click(el, '[data-testid="bundle-create"]');
      expect(argsOf('bundle_create')).to.deep.equal({
        path: REPO_PATH,
        bundlePath: '/tmp/out.bundle',
        refs: [],
        all: true,
      });
      expect(lastToast()?.message).to.contain('4 refs, 42 objects');

      // Success closes the dialog; reopen for the explicit-refs half.
      const el2 = await openDialogAt({ tab: 'bundle', bundleMode: 'create' });
      q<HTMLInputElement>(el2, '#bundle-all').click();
      await el2.updateComplete;
      q<HTMLInputElement>(el2, 'input[data-ref="refs/heads/main"]').click();
      await el2.updateComplete;

      await click(el2, '[data-testid="bundle-create"]');
      expect(argsOf('bundle_create')).to.deep.equal({
        path: REPO_PATH,
        bundlePath: '/tmp/out.bundle',
        refs: ['refs/heads/main'],
        all: false,
      });
    });

    it('disables Create when --all is off and nothing is ticked', async () => {
      const el = await openDialogAt({ tab: 'bundle', bundleMode: 'create' });
      q<HTMLInputElement>(el, '#bundle-all').click();
      await el.updateComplete;

      expect(q<HTMLButtonElement>(el, '[data-testid="bundle-create"]').disabled).to.be.true;
      expect(calls('bundle_create')).to.have.length(0);
    });
  });
});
