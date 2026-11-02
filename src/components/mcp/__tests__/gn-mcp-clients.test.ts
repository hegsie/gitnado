type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let clients: unknown[] = [];
let createError: string | null = null;
let confirm = true;

const mockInvoke: MockInvoke = async (command, args) => {
  switch (command) {
    case 'list_mcp_clients':
      return clients;
    case 'create_mcp_client': {
      if (createError) throw new Error(createError);
      const name = (args as { name: string }).name;
      const client = { id: 'c1', name, createdAt: 0, lastUsedAt: null };
      clients = [...clients, client];
      return { client, token: 'gnc_secret' };
    }
    case 'revoke_mcp_client':
      clients = [];
      return null;
    case 'get_mcp_stdio_command':
      return { program: '/opt/gitnado', args: ['--mcp-stdio'] };
    case 'plugin:dialog|message':
      return confirm ? 'Ok' : 'Cancel';
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
import '../gn-mcp-clients.ts';
import type { GnMcpClients } from '../gn-mcp-clients.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const $ = (el: GnMcpClients, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const toasts = (type: string) => uiStore.getState().toasts.filter((t) => t.type === type).map((t) => t.message);

async function render(): Promise<GnMcpClients> {
  const el = await fixture<GnMcpClients>(html`<gn-mcp-clients .port=${4100}></gn-mcp-clients>`);
  await waitUntil(() => invokeCalls.some((c) => c.command === 'list_mcp_clients'));
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

async function addClient(el: GnMcpClients, name: string): Promise<void> {
  const input = $(el, '.client-name-input') as HTMLInputElement;
  input.value = name;
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
  $(el, '.add-client-btn')!.click();
}

describe('gn-mcp-clients', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    clients = [];
    createError = null;
    confirm = true;
    uiStore.setState({ toasts: [] });
  });

  it('starts empty and requires a name', async () => {
    const el = await render();
    expect($(el, '.empty')!.textContent).to.contain('No client tokens yet');
    expect(($(el, '.add-client-btn') as HTMLButtonElement).disabled).to.be.true;
  });

  it('creates a client and shows its token once with setup for each client', async () => {
    const el = await render();
    await addClient(el, 'Cursor');
    await waitUntil(() => $(el, '.new-token'), 'token panel not shown');
    await waitUntil(() => el.shadowRoot!.querySelectorAll('.tab').length === 4, 'stdio tab missing');

    expect(invokeCalls.find((c) => c.command === 'create_mcp_client')!.args).to.deep.equal({ name: 'Cursor' });
    expect($(el, '.snippet')!.textContent).to.contain('claude mcp add --transport http gitnado http://127.0.0.1:4100/mcp');
    expect($(el, '.snippet')!.textContent).to.contain('gnc_secret');

    (el.shadowRoot!.querySelector('.tab[data-kind="vscode"]') as HTMLElement).click();
    await el.updateComplete;
    expect($(el, '.snippet')!.textContent).to.contain('"type": "http"');

    (el.shadowRoot!.querySelector('.tab[data-kind="stdio"]') as HTMLElement).click();
    await el.updateComplete;
    expect($(el, '.snippet')!.textContent).to.contain('/opt/gitnado');
    expect($(el, '.snippet')!.textContent).to.contain('GITNADO_MCP_TOKEN');

    expect(el.shadowRoot!.querySelectorAll('.client')).to.have.length(1);
    expect(toasts('success')[0]).to.contain("won't be shown again");

    $(el, '.done-btn')!.click();
    await el.updateComplete;
    expect($(el, '.new-token')).to.be.null;
    expect(el.shadowRoot!.textContent).to.not.contain('gnc_secret');
  });

  it('reports a failed create', async () => {
    createError = 'disk full';
    const el = await render();
    await addClient(el, 'VS Code');
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('disk full');
    expect($(el, '.new-token')).to.be.null;
  });

  it('lists clients with last use and revokes after confirmation', async () => {
    clients = [{ id: 'c9', name: 'Claude Code', createdAt: 0, lastUsedAt: Math.floor(Date.now() / 1000) - 120 }];
    const el = await render();
    expect($(el, '.client')!.textContent).to.contain('Claude Code');
    expect($(el, '.client')!.textContent).to.contain('used 2m ago');

    $(el, '.revoke-btn')!.click();
    await waitUntil(() => invokeCalls.some((c) => c.command === 'revoke_mcp_client'));
    expect(invokeCalls.find((c) => c.command === 'revoke_mcp_client')!.args).to.deep.equal({ id: 'c9' });
    await waitUntil(() => $(el, '.empty'), 'list not reloaded');
  });

  it('does not revoke when the confirmation is declined', async () => {
    clients = [{ id: 'c9', name: 'Claude Code', createdAt: 0, lastUsedAt: null }];
    confirm = false;
    const el = await render();
    expect($(el, '.client')!.textContent).to.contain('never used');
    $(el, '.revoke-btn')!.click();
    await waitUntil(() => invokeCalls.some((c) => c.command === 'plugin:dialog|message'));
    await new Promise((r) => setTimeout(r, 10));
    expect(invokeCalls.some((c) => c.command === 'revoke_mcp_client')).to.be.false;
  });
});
