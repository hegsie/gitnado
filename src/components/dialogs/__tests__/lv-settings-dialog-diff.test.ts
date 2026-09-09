/**
 * Settings Dialog — Diff section tests
 *
 * The diff view's toolbar and this dialog write the same two settings
 * (`diffIgnoreWhitespace`, `diffContextLines`). These tests render the real
 * dialog and drive the real controls, so the rows stay discoverable here and
 * keep writing the shared store.
 */

import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let nextId = 1;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  // The dialog listens for model-download events on connect and unlistens on
  // disconnect; answer both so the event plugin does not throw outside a test.
  if (command === 'plugin:event|listen') return nextId++;
  if (command === 'plugin:event|unlisten') return null;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_system_capabilities':
      return { hasGpu: false, gpuName: null, totalRam: 8 };
    case 'get_downloaded_models':
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_available_models':
      return [];
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    case 'get_available_merge_tools':
      return [];
    case 'list_diff_tools':
      return [];
    default:
      return null;
  }
};

(
  globalThis as unknown as {
    __TAURI_INTERNALS__: { invoke: MockInvoke; transformCallback: () => number };
  }
).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => nextId++,
};

// `unlisten()` pokes the event plugin's own internals before the IPC call.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// Import AFTER setting up the mock
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

describe('lv-settings-dialog Diff section', () => {
  let el: LvSettingsDialog;

  beforeEach(async () => {
    settingsStore.getState().setDiffIgnoreWhitespace('none');
    settingsStore.getState().setDiffContextLines(3);
    el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
  });

  function whitespaceSelect(): HTMLSelectElement {
    const select = el.shadowRoot!.querySelector<HTMLSelectElement>('#diff-whitespace-select');
    expect(select, 'the Whitespace row exists').to.not.be.null;
    return select!;
  }

  function contextInput(): HTMLInputElement {
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('#diff-context-lines-input');
    expect(input, 'the Context Lines row exists').to.not.be.null;
    return input!;
  }

  it('renders a Diff section holding both new rows', () => {
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).to.contain('Diff');
    expect(text).to.contain('Whitespace');
    expect(text).to.contain('Context Lines');
  });

  it('offers every whitespace mode the backend implements', () => {
    const values = Array.from(whitespaceSelect().options).map((o) => o.value);
    expect(values).to.deep.equal(['none', 'eol', 'change', 'all']);
  });

  it('shows the stored values when the dialog opens', async () => {
    settingsStore.getState().setDiffIgnoreWhitespace('change');
    settingsStore.getState().setDiffContextLines(8);

    const reopened = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`
    );
    await reopened.updateComplete;

    const select = reopened.shadowRoot!.querySelector<HTMLSelectElement>('#diff-whitespace-select');
    const input = reopened.shadowRoot!.querySelector<HTMLInputElement>('#diff-context-lines-input');
    expect(select!.value).to.equal('change');
    expect(input!.value).to.equal('8');
  });

  it('writes the whitespace mode to the shared store and announces it', async () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    const select = whitespaceSelect();
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;

    expect(settingsStore.getState().diffIgnoreWhitespace).to.equal('all');
    expect(eventFired, 'settings-changed dispatched').to.be.true;
  });

  it('writes the context-line count to the shared store and announces it', async () => {
    let eventFired = false;
    window.addEventListener('settings-changed', () => { eventFired = true; }, { once: true });

    const input = contextInput();
    input.value = '10';
    input.dispatchEvent(new Event('change'));
    await el.updateComplete;

    expect(settingsStore.getState().diffContextLines).to.equal(10);
    expect(eventFired, 'settings-changed dispatched').to.be.true;
  });

  it('clamps an out-of-range context-line entry in both the store and the field', async () => {
    const input = contextInput();

    input.value = '250';
    input.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(settingsStore.getState().diffContextLines).to.equal(20);
    expect(input.value).to.equal('20');

    input.value = '-7';
    input.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(settingsStore.getState().diffContextLines).to.equal(0);
    expect(input.value).to.equal('0');
  });

  it('falls back to git’s default when the field is cleared', async () => {
    const input = contextInput();
    input.value = '';
    input.dispatchEvent(new Event('change'));
    await el.updateComplete;

    expect(settingsStore.getState().diffContextLines).to.equal(3);
    expect(input.value).to.equal('3');
  });

  it('labels both rows for assistive technology', () => {
    expect(whitespaceSelect().getAttribute('aria-labelledby')).to.equal('diff-whitespace-label');
    expect(contextInput().getAttribute('aria-labelledby')).to.equal('diff-context-label');
    expect(el.shadowRoot!.querySelector('#diff-whitespace-label')).to.not.be.null;
    expect(el.shadowRoot!.querySelector('#diff-context-label')).to.not.be.null;
    expect(contextInput().getAttribute('min')).to.equal('0');
    expect(contextInput().getAttribute('max')).to.equal('20');
  });

  it('restores both defaults on reset', async () => {
    settingsStore.getState().setDiffIgnoreWhitespace('all');
    settingsStore.getState().setDiffContextLines(15);

    settingsStore.getState().resetToDefaults();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).loadSettings();
    await el.updateComplete;

    expect(settingsStore.getState().diffIgnoreWhitespace).to.equal('none');
    expect(settingsStore.getState().diffContextLines).to.equal(3);
    expect(whitespaceSelect().value).to.equal('none');
    expect(contextInput().value).to.equal('3');
  });
});
