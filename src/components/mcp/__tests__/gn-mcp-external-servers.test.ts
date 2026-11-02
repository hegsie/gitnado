type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let servers: unknown[] = [];
let saveError: string | null = null;
let toolsError: string | null = null;
let confirm = true;

const mockInvoke: MockInvoke = async (command, args) => {
  switch (command) {
    case 'list_external_mcp_servers':
      return servers;
    case 'save_external_mcp_server': {
      if (saveError) throw new Error(saveError);
      const a = args as { server: Record<string, unknown>; token?: string };
      const saved = { ...a.server, id: a.server.id || 'srv1', hasToken: Boolean(a.token) || a.server.hasToken };
      servers = [saved];
      return saved;
    }
    case 'remove_external_mcp_server':
      servers = [];
      return null;
    case 'list_external_mcp_tools':
      if (toolsError) throw new Error(toolsError);
      return [{ name: 'get_issue', description: 'Look up an issue' }];
    case 'preview_external_mcp_context':
      return { server: 'Jira', text: 'PROJ-7: Fix login redirect' };
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
import '../gn-mcp-external-servers.ts';
import type { GnMcpExternalServers } from '../gn-mcp-external-servers.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { OpenRepository } from '../../../stores/repository.store.ts';

const jira = {
  id: 'srv1',
  name: 'Jira',
  transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
  enabled: true,
  contextTool: 'get_issue',
  contextArgs: '{"key":"{issueKey}"}',
  hasToken: true,
};

const $ = (el: GnMcpExternalServers, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const toasts = (type: string) => uiStore.getState().toasts.filter((t) => t.type === type).map((t) => t.message);
const calls = (c: string) => invokeCalls.filter((x) => x.command === c);

async function render(): Promise<GnMcpExternalServers> {
  const el = await fixture<GnMcpExternalServers>(html`<gn-mcp-external-servers></gn-mcp-external-servers>`);
  await waitUntil(() => calls('list_external_mcp_servers').length > 0);
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

async function fill(el: GnMcpExternalServers, sel: string, value: string): Promise<void> {
  const input = $(el, sel) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
}

describe('gn-mcp-external-servers', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    servers = [];
    saveError = null;
    toolsError = null;
    confirm = true;
    uiStore.setState({ toasts: [] });
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
    repositoryStore.setState({
      openRepositories: [{ repository: { path: '/repo/app' } } as unknown as OpenRepository],
      activeIndex: 0,
    });
  });

  it('starts empty and adds an HTTP server with a keyring token', async () => {
    const el = await render();
    expect($(el, '.empty')!.textContent).to.contain('No servers added');
    $(el, '.add-server-btn')!.click();
    await el.updateComplete;
    await fill(el, '.name-input', 'Jira');
    await fill(el, '.url-input', 'https://mcp.example.com/mcp');
    await fill(el, '.token-input', 'secret-token');
    await fill(el, '.tool-input', 'get_issue');
    const template = $(el, '.args-template') as HTMLTextAreaElement;
    template.value = '{"key":"{issueKey}"}';
    template.dispatchEvent(new Event('input'));
    $(el, '.save-btn')!.click();

    await waitUntil(() => calls('save_external_mcp_server').length === 1);
    expect(calls('save_external_mcp_server')[0].args).to.deep.equal({
      server: {
        id: '',
        name: 'Jira',
        transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
        enabled: true,
        contextTool: 'get_issue',
        contextArgs: '{"key":"{issueKey}"}',
        hasToken: false,
      },
      token: 'secret-token',
      clearToken: undefined,
    });
    await waitUntil(() => $(el, '.server'), 'list not reloaded');
    expect($(el, '.server')!.textContent).to.contain('AI context from');
  });

  it('adds a stdio server, splitting arguments', async () => {
    const el = await render();
    $(el, '.add-server-btn')!.click();
    await el.updateComplete;
    await fill(el, '.name-input', 'Docs');
    const kind = $(el, '.kind-select') as HTMLSelectElement;
    kind.value = 'stdio';
    kind.dispatchEvent(new Event('change'));
    await el.updateComplete;
    await fill(el, '.command-input', 'npx');
    await fill(el, '.args-input', '-y   @acme/docs-mcp');
    $(el, '.save-btn')!.click();
    await waitUntil(() => calls('save_external_mcp_server').length === 1);
    const server = (calls('save_external_mcp_server')[0].args as { server: { transport: unknown; contextTool: unknown } }).server;
    expect(server.transport).to.deep.equal({ type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'] });
    expect(server.contextTool).to.be.null;
  });

  it('keeps the form open with the reason when saving fails', async () => {
    saveError = 'Context arguments must be JSON: expected value';
    const el = await render();
    $(el, '.add-server-btn')!.click();
    await el.updateComplete;
    await fill(el, '.name-input', 'Bad');
    $(el, '.save-btn')!.click();
    await waitUntil(() => $(el, '.error'));
    expect($(el, '.error')!.textContent).to.contain('must be JSON');
    expect($(el, 'form')).to.exist;
  });

  it('tests a server, previews its context, and reports connection failures', async () => {
    servers = [jira];
    const el = await render();
    $(el, '.test-btn')!.click();
    await waitUntil(() => $(el, '.tools'));
    expect($(el, '.tools')!.textContent).to.contain('get_issue');
    expect(toasts('success')[0]).to.contain('reachable: 1 tool');
    expect(calls('list_external_mcp_tools')[0].args).to.deep.equal({ id: 'srv1' });

    $(el, '.preview-btn')!.click();
    await waitUntil(() => $(el, '.preview'));
    expect($(el, '.preview')!.textContent).to.contain('PROJ-7: Fix login redirect');
    expect(calls('preview_external_mcp_context')[0].args).to.deep.equal({ id: 'srv1', repoPath: '/repo/app' });

    toolsError = 'The server refused the connection (HTTP 401)';
    $(el, '.test-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('HTTP 401');
  });

  it('refuses to contact a server in offline mode, before invoking anything', async () => {
    servers = [jira];
    settingsStore.setState({ offlineMode: true });
    const el = await render();
    $(el, '.test-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('Offline mode is on');
    expect(calls('list_external_mcp_tools')).to.have.length(0);
  });

  it('edits a server keeping its saved token, and can clear it', async () => {
    servers = [jira];
    const el = await render();
    $(el, '.edit-btn')!.click();
    await el.updateComplete;
    expect(($(el, '.token-input') as HTMLInputElement).placeholder).to.contain('A token is saved');
    ($(el, '.clear-token') as HTMLInputElement).click();
    $(el, '.save-btn')!.click();
    await waitUntil(() => calls('save_external_mcp_server').length === 1);
    const args = calls('save_external_mcp_server')[0].args as { token?: string; clearToken?: boolean; server: { id: string } };
    expect(args.server.id).to.equal('srv1');
    expect(args.token).to.be.undefined;
    expect(args.clearToken).to.be.true;
  });

  it('removes a server after confirmation', async () => {
    servers = [jira];
    const el = await render();
    $(el, '.remove-btn')!.click();
    await waitUntil(() => calls('remove_external_mcp_server').length === 1);
    expect(calls('remove_external_mcp_server')[0].args).to.deep.equal({ id: 'srv1' });
    await waitUntil(() => $(el, '.empty'));
  });
});
