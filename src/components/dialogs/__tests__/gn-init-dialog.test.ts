/**
 * Tests for gn-init-dialog component
 *
 * Focused on the "Initial Branch Name" field: it is seeded from the
 * "Default Branch Name" setting and forwarded to the init_repository command.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
let captured: { command: string; args?: unknown }[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    captured.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => {
    void once;
    void callback;
    return 0;
  },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-init-dialog.ts';
import type { GnInitDialog } from '../gn-init-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

const REPO = {
  path: '/tmp/repo',
  name: 'repo',
  isValid: true,
  isBare: false,
  headRef: null,
  state: 'Clean',
  isShallow: false,
  isPartialClone: false,
  cloneFilter: null,
};

function branchInput(el: GnInitDialog): HTMLInputElement {
  return el.shadowRoot!.querySelector('#initial-branch') as HTMLInputElement;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function fillAndInit(el: GnInitDialog, path: string, branch: string): Promise<void> {
  setInput(el.shadowRoot!.querySelector('#path') as HTMLInputElement, path);
  setInput(branchInput(el), branch);
  await el.updateComplete;
  const initBtn = Array.from(el.shadowRoot!.querySelectorAll('.btn-primary')).find((b) =>
    b.textContent!.includes('Initialize')
  ) as HTMLButtonElement;
  initBtn.click();
  // Let the awaited invoke settle and the component re-render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

function initArgs(): Record<string, unknown> {
  const entry = captured.find((c) => c.command === 'init_repository');
  expect(entry, 'init_repository was not invoked').to.exist;
  return entry!.args as Record<string, unknown>;
}

describe('gn-init-dialog initial branch', () => {
  let el: GnInitDialog;

  beforeEach(async () => {
    captured = [];
    mockInvoke = (command: string) =>
      command === 'init_repository' ? Promise.resolve(REPO) : Promise.resolve(null);
    settingsStore.getState().setDefaultBranchName('main');

    el = await fixture<GnInitDialog>(html`<gn-init-dialog></gn-init-dialog>`);
  });

  it('prefills the initial branch field from the Default Branch Name setting', async () => {
    settingsStore.getState().setDefaultBranchName('trunk');
    el.open();
    await el.updateComplete;

    expect(branchInput(el)).to.exist;
    expect(branchInput(el).value).to.equal('trunk');
  });

  it('sends the initial branch to init_repository', async () => {
    el.open();
    await el.updateComplete;

    await fillAndInit(el, '/tmp/repo', 'trunk');

    expect(initArgs()).to.deep.equal({
      path: '/tmp/repo',
      bare: false,
      initialBranch: 'trunk',
    });
  });

  it('omits initialBranch when the field is cleared', async () => {
    el.open();
    await el.updateComplete;

    await fillAndInit(el, '/tmp/repo', '   ');

    const args = initArgs();
    expect(args.path).to.equal('/tmp/repo');
    expect(args.bare).to.equal(false);
    expect(args.initialBranch).to.equal(undefined);
  });

  it('surfaces an invalid-branch error from the backend and keeps the dialog open', async () => {
    mockInvoke = (command: string) =>
      command === 'init_repository'
        ? Promise.reject({ code: 'CUSTOM_ERROR', message: 'Invalid initial branch name: bad name' })
        : Promise.resolve(null);

    el.open();
    await el.updateComplete;

    await fillAndInit(el, '/tmp/repo', 'bad name');

    const error = el.shadowRoot!.querySelector('.error-message');
    expect(error).to.exist;
    expect(error!.textContent).to.contain('Invalid initial branch name: bad name');

    const modal = el.shadowRoot!.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal.open).to.equal(true);
  });

  it('re-reads the setting each time the dialog is opened', async () => {
    el.open();
    await el.updateComplete;
    expect(branchInput(el).value).to.equal('main');

    el.close();
    await el.updateComplete;

    settingsStore.getState().setDefaultBranchName('develop');
    el.open();
    await el.updateComplete;

    expect(branchInput(el).value).to.equal('develop');
  });
});
