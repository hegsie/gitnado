/**
 * Checkpoints dialog tests (fixture-based). Only Tauri invoke is mocked.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-checkpoints-dialog.ts';
import type { GnCheckpointsDialog } from '../gn-checkpoints-dialog.ts';
import type { Checkpoint } from '../../../services/git.service.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { releaseRefOp, tryAcquireRefOp } from '../../../utils/ref-lock.ts';

const REPO = '/repo/a';
const now = Math.floor(Date.now() / 1000);

function cp(id: string, label: string, extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id,
    oid: `oid-${id}`,
    label,
    sessionId: null,
    headOid: 'abc',
    branch: 'main',
    createdAt: now - 120,
    filesChanged: 2,
    ...extra,
  };
}

interface MockState {
  list: Checkpoint[] | Error;
  confirm: boolean;
  create?: Checkpoint | Error;
  restore?: { restored: Checkpoint; backup: Checkpoint } | Error;
  deleteError?: string;
  files?: unknown;
  hooks?: unknown;
  hooksError?: string;
  installResult?: unknown;
}

let state: MockState;

function install(): void {
  mockInvoke = async (command, args) => {
    switch (command) {
      case 'list_checkpoints':
        if (state.list instanceof Error) throw state.list;
        return state.list;
      case 'create_checkpoint':
        if (state.create instanceof Error) throw state.create;
        return state.create ?? cp('new', (args as { label?: string }).label ?? 'Checkpoint');
      case 'restore_checkpoint':
        if (state.restore instanceof Error) throw state.restore;
        return state.restore;
      case 'delete_checkpoint':
        if (state.deleteError) throw new Error(state.deleteError);
        return null;
      case 'get_checkpoint_files':
        if (state.files instanceof Error) throw state.files;
        return state.files ?? [];
      case 'get_agent_hooks_status':
        if (state.hooksError) throw new Error(state.hooksError);
        return state.hooks ?? { installed: false, partial: false, settingsPath: '/repo/a/.claude/settings.local.json', scriptPath: '/repo/a/.git/gitnado/agent-checkpoint.sh' };
      case 'install_agent_hooks':
      case 'uninstall_agent_hooks':
        if (state.installResult instanceof Error) throw state.installResult;
        return state.installResult;
      case 'plugin:dialog|message':
        return state.confirm ? 'Ok' : 'Cancel';
      case 'plugin:notification|is_permission_granted':
        return false;
      default:
        return null;
    }
  };
}

function calls(command: string) {
  return invokeCalls.filter((c) => c.command === command);
}

function toasts(type: string) {
  return uiStore.getState().toasts.filter((t) => t.type === type).map((t) => t.message);
}

async function render(): Promise<GnCheckpointsDialog> {
  const el = await fixture<GnCheckpointsDialog>(
    html`<gn-checkpoints-dialog .repositoryPath=${REPO}></gn-checkpoints-dialog>`,
  );
  el.open = true;
  await el.updateComplete;
  await waitUntil(() => calls('list_checkpoints').length > 0);
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const $ = (el: GnCheckpointsDialog, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const $$ = (el: GnCheckpointsDialog, sel: string) =>
  Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>(sel));

describe('gn-checkpoints-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
    state = { list: [], confirm: true };
    install();
  });

  it('lists checkpoints with label, age, file count, branch and agent session', async () => {
    state.list = [
      cp('2', 'After turn 3', { sessionId: 'claude-42', filesChanged: 1 }),
      cp('1', 'Manual', { filesChanged: 5 }),
    ];
    const el = await render();

    const rows = $$(el, '.checkpoint');
    expect(rows).to.have.length(2);
    expect(rows[0].textContent).to.contain('After turn 3');
    expect(rows[0].textContent).to.contain('1 file');
    expect(rows[0].textContent).to.contain('on main');
    expect(rows[0].textContent).to.contain('claude-42');
    expect(rows[0].textContent).to.contain('2m ago');
    expect(rows[1].textContent).to.contain('5 files');
    expect((calls('list_checkpoints')[0].args as { path: string }).path).to.equal(REPO);
  });

  it('shows an empty state when there are no checkpoints', async () => {
    const el = await render();
    expect($(el, '.empty-state')!.textContent).to.contain('No checkpoints yet');
  });

  it('shows a load error with a working retry', async () => {
    state.list = new Error('repository is locked');
    const el = await render();
    expect($(el, '.error-state')!.textContent).to.contain('repository is locked');

    state.list = [cp('1', 'Recovered')];
    $(el, '.retry-btn')!.click();
    await waitUntil(() => $$(el, '.checkpoint').length === 1, 'retry did not reload');
  });

  it('creates a named checkpoint, toasts, notifies and reloads', async () => {
    const el = await render();
    const events: CustomEvent[] = [];
    el.addEventListener('checkpoints-changed', (e) => events.push(e as CustomEvent));

    const input = $(el, '.label-input') as HTMLInputElement;
    input.value = '  before refactor  ';
    input.dispatchEvent(new Event('input'));
    state.list = [cp('new', 'before refactor')];
    $(el, '.create-btn')!.click();

    await waitUntil(() => $$(el, '.checkpoint').length === 1, 'list not reloaded');
    expect(calls('create_checkpoint')[0].args).to.deep.equal({
      path: REPO,
      label: 'before refactor',
      sessionId: undefined,
    });
    expect(toasts('success')[0]).to.contain('before refactor');
    expect(events[0].detail).to.deep.equal({ repositoryPath: REPO, workingTreeChanged: false });
    expect(input.value).to.equal('');
  });

  it('reports a failed create', async () => {
    state.create = new Error('Checkpoints need a working tree');
    const el = await render();
    $(el, '.create-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('Checkpoints need a working tree');
  });

  it('expands a checkpoint to show its files, and reports a failure to load them', async () => {
    state.list = [cp('1', 'One'), cp('2', 'Two')];
    state.files = [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'new.txt', status: 'added' },
    ];
    const el = await render();

    $$(el, '.expand-btn')[0].click();
    await waitUntil(() => $(el, '.files'), 'files not shown');
    expect($(el, '.files')!.textContent).to.contain('src/a.ts');
    expect($(el, '.file-status.added')).to.exist;
    expect($$(el, '.expand-btn')[0].getAttribute('aria-expanded')).to.equal('true');

    state.files = new Error('boom');
    $$(el, '.expand-btn')[1].click();
    await waitUntil(() => $(el, '.checkpoint[data-id="2"] .error-state'), 'no error state');
  });

  it('restores after confirmation, toasts the backup, and asks the shell to refresh', async () => {
    const target = cp('1', 'After turn 1');
    state.list = [target];
    state.restore = { restored: target, backup: cp('3', 'Before restoring "After turn 1"') };
    const el = await render();
    const events: CustomEvent[] = [];
    el.addEventListener('checkpoints-changed', (e) => events.push(e as CustomEvent));

    $(el, '.restore-btn')!.click();
    await waitUntil(() => toasts('success').length > 0, 'no success toast');

    expect(calls('restore_checkpoint')[0].args).to.deep.equal({ path: REPO, id: '1' });
    expect(toasts('success')[0]).to.contain('Before restoring');
    expect(events.map((e) => e.detail)).to.deep.equal([
      { repositoryPath: REPO, workingTreeChanged: true },
    ]);
  });

  it('does nothing when the restore is not confirmed', async () => {
    state.list = [cp('1', 'One')];
    state.confirm = false;
    const el = await render();
    $(el, '.restore-btn')!.click();
    await waitUntil(() => calls('plugin:dialog|message').length > 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls('restore_checkpoint')).to.have.length(0);
  });

  it('reports a failed restore and releases the repository lock', async () => {
    state.list = [cp('1', 'One')];
    state.restore = new Error('Resolve merge conflicts before restoring a checkpoint');
    const el = await render();
    $(el, '.restore-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('Resolve merge conflicts');
    expect(tryAcquireRefOp(REPO), 'lock must be released').to.be.true;
    releaseRefOp(REPO);
  });

  it('refuses to restore while another operation holds the repository', async () => {
    state.list = [cp('1', 'One')];
    const el = await render();
    tryAcquireRefOp(REPO);
    try {
      $(el, '.restore-btn')!.click();
      await waitUntil(() => toasts('warning').length > 0, 'no busy warning');
      expect(calls('restore_checkpoint')).to.have.length(0);
    } finally {
      releaseRefOp(REPO);
    }
  });

  it('deletes after confirmation and reports failures', async () => {
    state.list = [cp('1', 'Old')];
    const el = await render();

    state.list = [];
    $(el, '.delete-btn')!.click();
    await waitUntil(() => $(el, '.empty-state'), 'list not reloaded after delete');
    expect(calls('delete_checkpoint')[0].args).to.deep.equal({ path: REPO, id: '1' });
    expect(toasts('success')[0]).to.contain('deleted');

    state.list = [cp('2', 'Other')];
    el.open = false;
    await el.updateComplete;
    el.open = true;
    await waitUntil(() => $$(el, '.checkpoint').length === 1);
    state.deleteError = 'reference is locked';
    $(el, '.delete-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('reference is locked');
  });

  it('exposes the repo-scoped dialog contract for the tab-close sweep', async () => {
    const el = await render();
    expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO);
    expect(el.operationInFlight).to.be.false;
    el.close();
    await el.updateComplete;
    expect(el.pinnedRepositoryPathIfOpen).to.be.null;
  });

  describe('Claude Code hooks', () => {
    const paths = { settingsPath: '/repo/a/.claude/settings.local.json', scriptPath: '/x' };

    it('offers to turn automatic checkpoints on, and reports success', async () => {
      state.installResult = { installed: true, partial: false, ...paths };
      const el = await render();
      await waitUntil(() => $(el, '.hooks-btn'), 'no hooks button');
      expect($(el, '.hooks-status')!.textContent).to.contain('Off');
      expect($(el, '.hooks-btn')!.textContent).to.equal('Turn On');

      $(el, '.hooks-btn')!.click();
      await waitUntil(() => toasts('success').length > 0);
      expect(calls('install_agent_hooks')[0].args).to.deep.equal({ path: REPO });
      expect(toasts('success')[0]).to.contain('before and after every turn');
      await el.updateComplete;
      expect($(el, '.hooks-status')!.textContent).to.contain('On');
      expect($(el, '.hooks-btn')!.textContent).to.equal('Turn Off');
    });

    it('turns them off again', async () => {
      state.hooks = { installed: true, partial: false, ...paths };
      state.installResult = { installed: false, partial: false, ...paths };
      const el = await render();
      await waitUntil(() => $(el, '.hooks-btn')?.textContent === 'Turn Off');
      $(el, '.hooks-btn')!.click();
      await waitUntil(() => toasts('success').length > 0);
      expect(calls('uninstall_agent_hooks')).to.have.length(1);
      expect(toasts('success')[0]).to.contain('turned off');
    });

    it('offers a repair for a partial install', async () => {
      state.hooks = { installed: false, partial: true, ...paths };
      const el = await render();
      await waitUntil(() => $(el, '.hooks-btn')?.textContent === 'Repair');
      expect($(el, '.hooks-status')!.textContent).to.contain('Incomplete');
    });

    it('reports a failed install without changing the status', async () => {
      state.installResult = new Error('.claude/settings.local.json is not a valid JSON object');
      const el = await render();
      await waitUntil(() => $(el, '.hooks-btn'));
      $(el, '.hooks-btn')!.click();
      await waitUntil(() => toasts('error').length > 0);
      expect(toasts('error')[0]).to.contain('not a valid JSON object');
      expect($(el, '.hooks-btn')!.textContent).to.equal('Turn On');
    });

    it('shows why the status could not be read', async () => {
      state.hooksError = 'Agent hooks need a working tree';
      const el = await render();
      await waitUntil(() => $(el, '.hooks-row.error'), 'no error state');
      expect($(el, '.hooks-status')!.textContent).to.contain('need a working tree');
      expect($(el, '.hooks-btn')).to.be.null;
    });
  });
});
