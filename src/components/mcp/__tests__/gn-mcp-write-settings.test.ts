type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let settings: unknown = { enabled: false, policies: [] };
let saveError: string | null = null;
let loadError: string | null = null;

const mockInvoke: MockInvoke = async (command) => {
  switch (command) {
    case 'get_mcp_write_settings':
      if (loadError) throw new Error(loadError);
      return settings;
    case 'set_mcp_write_settings':
      if (saveError) throw new Error(saveError);
      return null;
    case 'plugin:notification|is_permission_granted':
      return false;
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-mcp-write-settings.ts';
import type { GnMcpWriteSettings } from '../gn-mcp-write-settings.ts';
import { uiStore } from '../../../stores/ui.store.ts';

async function render(): Promise<GnMcpWriteSettings> {
  const el = await fixture<GnMcpWriteSettings>(html`<gn-mcp-write-settings></gn-mcp-write-settings>`);
  await waitUntil(() => el.shadowRoot!.querySelector('.write-toggle, .error'));
  return el;
}

const saves = () => invokeCalls.filter((c) => c.command === 'set_mcp_write_settings').map((c) => c.args);
const toasts = (type: string) => uiStore.getState().toasts.filter((t) => t.type === type).map((t) => t.message);

describe('gn-mcp-write-settings', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    settings = { enabled: false, policies: [] };
    saveError = null;
    loadError = null;
    uiStore.setState({ toasts: [] });
  });

  it('is off by default and turns write tools on', async () => {
    const el = await render();
    const toggle = el.shadowRoot!.querySelector('gn-toggle')!;
    expect(toggle.checked).to.be.false;
    expect(el.shadowRoot!.querySelector('.policies, .empty')).to.be.null;

    toggle.dispatchEvent(new CustomEvent('change', { detail: { checked: true } }));
    await waitUntil(() => saves().length === 1);
    expect(saves()[0]).to.deep.equal({ settings: { enabled: true, policies: [] } });
    await waitUntil(() => toasts('success').length > 0);
    expect(toasts('success')[0]).to.contain('asks you first');
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.empty')!.textContent).to.contain('every change asks you first');
  });

  it('lists and removes always-allow rules', async () => {
    const rule = { repoPath: '/home/u/app', tool: 'commit', branchPattern: 'agent/*' };
    settings = { enabled: true, policies: [rule] };
    const el = await render();
    const item = el.shadowRoot!.querySelector('.policy')!;
    expect(item.textContent).to.contain('commit');
    expect(item.textContent).to.contain('agent/*');
    expect(item.textContent).to.contain('app');

    (item.querySelector('.remove-btn') as HTMLButtonElement).click();
    await waitUntil(() => saves().length === 1);
    expect(saves()[0]).to.deep.equal({ settings: { enabled: true, policies: [] } });
  });

  it('reports a failed save and keeps the old state', async () => {
    saveError = 'disk full';
    const el = await render();
    el.shadowRoot!.querySelector('gn-toggle')!.dispatchEvent(new CustomEvent('change', { detail: { checked: true } }));
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('disk full');
    expect(el.shadowRoot!.querySelector('gn-toggle')!.checked).to.be.false;
  });

  it('shows why the settings could not be read', async () => {
    loadError = 'permission denied';
    const el = await render();
    expect(el.shadowRoot!.querySelector('.error')!.textContent).to.contain('permission denied');
  });
});
